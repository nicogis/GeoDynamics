export type OutletEdge = "left" | "right" | "bottom" | "top";

export interface ConservativeFlowStepOptions {
  resolutionX: number;
  resolutionY: number;
  cellSize: number;
  dtSeconds: number;
  gravity: number;
  manningN: number;
  minWetDepthM: number;
}

export interface BoundaryDrainResult {
  outflowVolumeM3: number;
  boundaryReached: boolean;
}

export interface MassBalanceAudit {
  storedVolumeM3: number;
  residualVolumeM3: number;
  errorPct: number;
}

const NEIGHBORS = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2]
] as const;

function indexOf(row: number, col: number, width: number): number {
  return row * width + col;
}

export function advanceConservativeFlowStep(
  depth: Float32Array,
  nextDepth: Float32Array,
  terrain: Float32Array,
  maxVelocity: Float32Array,
  options: ConservativeFlowStepOptions
): void {
  const {
    resolutionX,
    resolutionY,
    cellSize,
    dtSeconds,
    gravity,
    manningN,
    minWetDepthM
  } = options;

  nextDepth.set(depth);

  for (let row = 1; row < resolutionY - 1; row += 1) {
    for (let col = 1; col < resolutionX - 1; col += 1) {
      const index = indexOf(row, col, resolutionX);
      const localDepth = depth[index];
      const localTerrain = terrain[index];

      if (!Number.isFinite(localTerrain) || localDepth <= minWetDepthM) {
        continue;
      }

      const localSurface = localTerrain + localDepth;
      let available = localDepth * 0.55;

      for (const [dr, dc, distanceFactor] of NEIGHBORS) {
        if (available <= 0) {
          break;
        }

        const neighborIndex = indexOf(
          row + dr,
          col + dc,
          resolutionX
        );
        const neighborTerrain = terrain[neighborIndex];

        if (!Number.isFinite(neighborTerrain)) {
          continue;
        }

        const neighborSurface =
          neighborTerrain + depth[neighborIndex];
        const headDifference = localSurface - neighborSurface;

        if (headDifference <= 0.002) {
          continue;
        }

        const hydraulicDepth = Math.max(localDepth, minWetDepthM);
        const waveCelerity = Math.sqrt(gravity * hydraulicDepth);
        const neighborDistance = cellSize * distanceFactor;
        const slope = Math.min(
          Math.max(headDifference / neighborDistance, 0),
          1
        );

        const manningVelocity =
          slope > 0
            ? (1 / manningN) *
              Math.pow(hydraulicDepth, 2 / 3) *
              Math.sqrt(slope)
            : 0;
        const velocity = Math.min(
          manningVelocity,
          waveCelerity * 2.5,
          15
        );
        const courantNumber = Math.min(
          velocity * dtSeconds / neighborDistance,
          0.45
        );
        const courantTransfer = Math.min(
          available,
          courantNumber * localDepth * 0.42,
          headDifference * 0.24
        );

        if (courantTransfer <= 0) {
          continue;
        }

        nextDepth[index] -= courantTransfer;
        nextDepth[neighborIndex] += courantTransfer;
        available -= courantTransfer;
        maxVelocity[index] = Math.max(maxVelocity[index], velocity);
        maxVelocity[neighborIndex] = Math.max(
          maxVelocity[neighborIndex],
          velocity
        );
      }
    }
  }
}

export function drainOutletBoundary(
  depth: Float32Array,
  terrain: Float32Array,
  options: ConservativeFlowStepOptions,
  outletEdge: OutletEdge
): BoundaryDrainResult {
  const {
    resolutionX,
    resolutionY,
    cellSize,
    dtSeconds,
    gravity,
    minWetDepthM
  } = options;

  const cellAreaM2 = cellSize * cellSize;
  let outflowVolumeM3 = 0;
  let boundaryReached = false;

  for (let row = 0; row < resolutionY; row += 1) {
    for (let col = 0; col < resolutionX; col += 1) {
      if (
        row !== 0 &&
        row !== resolutionY - 1 &&
        col !== 0 &&
        col !== resolutionX - 1
      ) {
        continue;
      }

      const boundaryIndex = indexOf(row, col, resolutionX);
      const boundaryDepth = depth[boundaryIndex];

      if (
        !Number.isFinite(terrain[boundaryIndex]) ||
        boundaryDepth <= minWetDepthM
      ) {
        continue;
      }

      const isOutletCell =
        (outletEdge === "left" && col === 0) ||
        (outletEdge === "right" && col === resolutionX - 1) ||
        (outletEdge === "bottom" && row === 0) ||
        (outletEdge === "top" && row === resolutionY - 1);

      if (!isOutletCell) {
        boundaryReached = true;
        continue;
      }

      const celerity = Math.sqrt(
        gravity * Math.max(boundaryDepth, minWetDepthM)
      );
      const drainFraction = Math.min(
        celerity * dtSeconds / cellSize,
        0.65
      );
      const drainedDepth = boundaryDepth * drainFraction;

      depth[boundaryIndex] -= drainedDepth;
      outflowVolumeM3 += drainedDepth * cellAreaM2;
    }
  }

  return { outflowVolumeM3, boundaryReached };
}

export function computeStoredVolumeM3(
  depth: Float32Array,
  cellAreaM2: number
): number {
  let storedVolumeM3 = 0;

  for (let i = 0; i < depth.length; i += 1) {
    storedVolumeM3 += Math.max(depth[i], 0) * cellAreaM2;
  }

  return storedVolumeM3;
}

export function auditMassBalance(
  inputVolumeM3: number,
  outflowVolumeM3: number,
  depth: Float32Array,
  cellAreaM2: number
): MassBalanceAudit {
  const storedVolumeM3 = computeStoredVolumeM3(depth, cellAreaM2);
  const residualVolumeM3 =
    inputVolumeM3 - outflowVolumeM3 - storedVolumeM3;
  const errorPct =
    inputVolumeM3 > 0
      ? Math.abs(residualVolumeM3) / inputVolumeM3 * 100
      : storedVolumeM3 > 0
        ? 100
        : 0;

  return {
    storedVolumeM3,
    residualVolumeM3,
    errorPct
  };
}


export function triangularHydrographFactor(
  timeS: number,
  durationS: number,
  peakPhase = 0.35
): number {
  if (durationS <= 0 || timeS < 0 || timeS > durationS) {
    return 0;
  }

  const phase = timeS / durationS;
  const clampedPeak = Math.min(Math.max(peakPhase, 0.001), 0.999);

  return phase <= clampedPeak
    ? phase / clampedPeak
    : Math.max(1 - (phase - clampedPeak) / (1 - clampedPeak), 0);
}

export function expectedTriangularHydrographVolumeM3(
  peakDischargeM3s: number,
  durationS: number
): number {
  return Math.max(peakDischargeM3s, 0) * Math.max(durationS, 0) * 0.5;
}
