import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import type { DownstreamFlowPath } from "./DownstreamInundation";

export interface DownstreamShallowWaterResult {
  center: Point;
  minX: number;
  minY: number;
  width: number;
  height: number;
  resolutionX: number;
  resolutionY: number;
  cellSize: number;
  terrain: Float32Array;
  maxDepth: Float32Array;
  arrivalTime: Float32Array;
  maxVelocity: Float32Array;
  wetCellCount: number;
  wetAreaM2: number;
  overtoppingHeadM: number;
  sourceDepthM: number;
  peakDischargeM3s: number;
  effectiveOverflowWidthM: number;
  inputVolumeM3: number;
  storedVolumeM3: number;
  outflowVolumeM3: number;
  massBalanceErrorPct: number;
  peakDepthM: number;
  peakVelocityMs: number;
  maxArrivalTimeS: number;
  simulatedDurationS: number;
  frontDistanceM: number;
  stopReason:
    | "converged"
    | "duration-limit"
    | "step-limit"
    | "domain-boundary-reached";
  frontStillAdvancing: boolean;
}

const TARGET_CELL_SIZE_M = 20;
const MAX_RESOLUTION = 128;
const DOMAIN_MARGIN_M = 220;
const GRAVITY = 9.81;
const MIN_SIMULATION_SECONDS = 120;
const MAX_SIMULATION_SECONDS = 1800;
const MAX_SIMULATION_STEPS = 2400;
const CONVERGENCE_STEPS = 40;
const DEPTH_CHANGE_TOLERANCE_M = 0.001;
const WEIR_COEFFICIENT = 1.7;
const MIN_WET_DEPTH_M = 0.03;
const ELEVATION_BATCH_SIZE = 16384;

async function sampleTerrain(
  view: SceneView,
  points: number[][],
  spatialReference: Point["spatialReference"]
): Promise<number[]> {
  const map = view.map;
  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const elevations: number[] = [];

  for (let offset = 0; offset < points.length; offset += ELEVATION_BATCH_SIZE) {
    const batch = points.slice(offset, offset + ELEVATION_BATCH_SIZE);
    const geometry = new Multipoint({
      spatialReference,
      points: batch
    });
    const result = await map.ground.queryElevation(geometry, {
      demResolution: "finest-contiguous"
    });

    for (const point of result.geometry.points) {
      const elevation = point[2];
      elevations.push(
        elevation !== undefined && Number.isFinite(elevation)
          ? elevation
          : Number.NaN
      );
    }
  }

  return elevations;
}

function indexOf(row: number, col: number, width: number): number {
  return row * width + col;
}

export async function simulateDownstreamShallowWater(
  view: SceneView,
  flow: DownstreamFlowPath,
  overtoppingHeadM: number,
  damLengthM?: number
): Promise<DownstreamShallowWaterResult> {
  if (flow.points.length < 2) {
    throw new Error("Downstream flow path is too short for raster simulation.");
  }

  const xs = flow.points.map((point) => point[0]);
  const ys = flow.points.map((point) => point[1]);
  const minX = Math.min(...xs) - DOMAIN_MARGIN_M;
  const maxX = Math.max(...xs) + DOMAIN_MARGIN_M;
  const minY = Math.min(...ys) - DOMAIN_MARGIN_M;
  const maxY = Math.max(...ys) + DOMAIN_MARGIN_M;
  const width = Math.max(maxX - minX, TARGET_CELL_SIZE_M * 8);
  const height = Math.max(maxY - minY, TARGET_CELL_SIZE_M * 8);

  const scale = Math.max(
    width / (MAX_RESOLUTION - 1),
    height / (MAX_RESOLUTION - 1),
    TARGET_CELL_SIZE_M
  );
  const resolutionX = Math.max(8, Math.ceil(width / scale) + 1);
  const resolutionY = Math.max(8, Math.ceil(height / scale) + 1);
  const cellSize = Math.max(
    width / Math.max(resolutionX - 1, 1),
    height / Math.max(resolutionY - 1, 1)
  );

  const points: number[][] = [];
  for (let row = 0; row < resolutionY; row += 1) {
    const y = minY + row * cellSize;
    for (let col = 0; col < resolutionX; col += 1) {
      const x = minX + col * cellSize;
      points.push([x, y]);
    }
  }

  const sampled = await sampleTerrain(
    view,
    points,
    flow.source.spatialReference
  );
  const count = resolutionX * resolutionY;
  const terrain = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const elevation = sampled[i];
    terrain[i] = Number.isFinite(elevation) ? elevation : Number.NaN;
  }

  let depth = new Float32Array(count);
  let nextDepth = new Float32Array(count);
  const maxDepth = new Float32Array(count);
  const maxVelocity = new Float32Array(count);
  const arrivalTime = new Float32Array(count);
  arrivalTime.fill(-1);

  const source = flow.points[0];
  const sourceCol = Math.min(
    Math.max(Math.round((source[0] - minX) / cellSize), 0),
    resolutionX - 1
  );
  const sourceRow = Math.min(
    Math.max(Math.round((source[1] - minY) / cellSize), 0),
    resolutionY - 1
  );
  const head = Math.max(overtoppingHeadM, 0);
  const effectiveOverflowWidthM = Math.max(
    cellSize,
    Math.min(
      damLengthM && Number.isFinite(damLengthM)
        ? damLengthM * 0.25
        : cellSize * 3,
      cellSize * 8
    )
  );
  const peakDischargeM3s =
    WEIR_COEFFICIENT *
    effectiveOverflowWidthM *
    Math.pow(head, 1.5);
  const sourcePulseSeconds = Math.min(
    Math.max(30 + head * 90, 30),
    180
  );
  const equivalentSourceDepth = Math.max(
    head,
    MIN_WET_DEPTH_M
  );
  const characteristicWaveSpeed = Math.max(
    Math.sqrt(GRAVITY * equivalentSourceDepth),
    1
  );
  const dtSeconds = Math.min(
    Math.max((cellSize / characteristicWaveSpeed) * 0.32, 0.35),
    1.5
  );

  const sourceIndices: number[] = [];
  for (
    let row = Math.max(0, sourceRow - 1);
    row <= Math.min(resolutionY - 1, sourceRow + 1);
    row += 1
  ) {
    for (
      let col = Math.max(0, sourceCol - 1);
      col <= Math.min(resolutionX - 1, sourceCol + 1);
      col += 1
    ) {
      const sourceIndex = indexOf(row, col, resolutionX);
      if (Number.isFinite(terrain[sourceIndex])) {
        sourceIndices.push(sourceIndex);
      }
    }
  }

  if (sourceIndices.length === 0) {
    throw new Error("No valid terrain cells are available at the overtopping source.");
  }

  const cellAreaM2 = cellSize * cellSize;
  let inputVolumeM3 = 0;
  let outflowVolumeM3 = 0;
  let boundaryReached = false;

  const neighbors = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [1, 1, Math.SQRT2]
  ] as const;

  let simulatedDurationS = 0;
  let stopReason: DownstreamShallowWaterResult["stopReason"] = "duration-limit";
  let stableSteps = 0;
  let frontStillAdvancing = false;

  for (let step = 0; step < MAX_SIMULATION_STEPS; step += 1) {
    const simulationTime = step * dtSeconds;

    if (simulationTime >= MAX_SIMULATION_SECONDS) {
      stopReason = "duration-limit";
      break;
    }

    // Finite-volume overtopping source. Use a triangular hydrograph based on
    // a broad-crested weir approximation so the injected water volume is
    // explicit and auditable rather than imposed as a persistent depth.
    if (simulationTime <= sourcePulseSeconds && peakDischargeM3s > 0) {
      const phase = simulationTime / Math.max(sourcePulseSeconds, 1);
      const hydrographFactor =
        phase <= 0.35
          ? phase / 0.35
          : Math.max(1 - (phase - 0.35) / 0.65, 0);
      const dischargeM3s = peakDischargeM3s * hydrographFactor;
      const injectedVolumeM3 = dischargeM3s * dtSeconds;
      const injectedDepth =
        injectedVolumeM3 /
        (sourceIndices.length * cellAreaM2);

      for (const sourceIndex of sourceIndices) {
        depth[sourceIndex] += injectedDepth;
      }

      inputVolumeM3 += injectedVolumeM3;
    }

    nextDepth.set(depth);

    for (let row = 1; row < resolutionY - 1; row += 1) {
      for (let col = 1; col < resolutionX - 1; col += 1) {
        const index = indexOf(row, col, resolutionX);
        const localDepth = depth[index];
        const localTerrain = terrain[index];

        if (
          !Number.isFinite(localTerrain) ||
          localDepth <= MIN_WET_DEPTH_M
        ) {
          continue;
        }

        const localSurface = localTerrain + localDepth;
        let available = localDepth * 0.55;

        for (const [dr, dc, distanceFactor] of neighbors) {
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

          const hydraulicDepth = Math.max(localDepth, MIN_WET_DEPTH_M);
          const waveCelerity = Math.sqrt(GRAVITY * hydraulicDepth);
          const neighborDistance = cellSize * distanceFactor;
          const slope = Math.min(
            Math.max(headDifference / neighborDistance, 0),
            1
          );
          const velocity = Math.min(
            waveCelerity * Math.sqrt(slope),
            12
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

    // Open downstream/domain boundary. Water reaching the raster edge is
    // allowed to leave instead of reflecting back and accumulating in closed
    // edge cells. Track the removed volume for the mass balance.
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
        const boundaryDepth = nextDepth[boundaryIndex];
        if (
          !Number.isFinite(terrain[boundaryIndex]) ||
          boundaryDepth <= MIN_WET_DEPTH_M
        ) {
          continue;
        }

        boundaryReached = true;
        const celerity = Math.sqrt(
          GRAVITY * Math.max(boundaryDepth, MIN_WET_DEPTH_M)
        );
        const drainFraction = Math.min(
          celerity * dtSeconds / cellSize,
          0.65
        );
        const drainedDepth = boundaryDepth * drainFraction;
        nextDepth[boundaryIndex] -= drainedDepth;
        outflowVolumeM3 += drainedDepth * cellAreaM2;
      }
    }

    const swap = depth;
    depth = nextDepth;
    nextDepth = swap;

    const arrivalSampleTime = (step + 1) * dtSeconds;
    let newWetCells = 0;
    let wetCellsThisStep = 0;
    let totalDepthChange = 0;

    for (let i = 0; i < count; i += 1) {
      const value = depth[i];
      const previousValue = nextDepth[i];

      if (value > maxDepth[i]) {
        maxDepth[i] = value;
      }

      if (value > MIN_WET_DEPTH_M) {
        wetCellsThisStep += 1;
      }

      if (value > MIN_WET_DEPTH_M && arrivalTime[i] < 0) {
        arrivalTime[i] = arrivalSampleTime;
        newWetCells += 1;
      }

      totalDepthChange += Math.abs(value - previousValue);
    }

    simulatedDurationS = arrivalSampleTime;
    const meanDepthChange =
      wetCellsThisStep > 0
        ? totalDepthChange / wetCellsThisStep
        : 0;

    frontStillAdvancing = newWetCells > 0;

    const sourceFinished =
      arrivalSampleTime > sourcePulseSeconds;
    const minimumDurationReached =
      arrivalSampleTime >= MIN_SIMULATION_SECONDS;
    const hydraulicallyStable =
      newWetCells === 0 &&
      meanDepthChange <= DEPTH_CHANGE_TOLERANCE_M;

    if (
      sourceFinished &&
      minimumDurationReached &&
      hydraulicallyStable
    ) {
      stableSteps += 1;
    } else {
      stableSteps = 0;
    }

    if (stableSteps >= CONVERGENCE_STEPS) {
      stopReason = "converged";
      frontStillAdvancing = false;
      break;
    }

    if (step === MAX_SIMULATION_STEPS - 1) {
      stopReason = "step-limit";
    }
  }

  let wetCellCount = 0;
  let peakDepthM = 0;
  let sourceDepthM = 0;
  let peakVelocityMs = 0;
  let maxArrivalTimeS = 0;
  let frontDistanceM = 0;
  const sourceExclusionRadiusCells = 2;

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / resolutionX);
    const col = i % resolutionX;
    const distanceFromSource = Math.hypot(
      row - sourceRow,
      col - sourceCol
    );

    if (distanceFromSource <= sourceExclusionRadiusCells) {
      sourceDepthM = Math.max(sourceDepthM, maxDepth[i]);
    } else {
      peakDepthM = Math.max(peakDepthM, maxDepth[i]);
      peakVelocityMs = Math.max(peakVelocityMs, maxVelocity[i]);
    }

    if (maxDepth[i] > MIN_WET_DEPTH_M) {
      wetCellCount += 1;

      const x = minX + col * cellSize;
      const y = minY + row * cellSize;
      frontDistanceM = Math.max(
        frontDistanceM,
        Math.hypot(x - source[0], y - source[1])
      );

      if (arrivalTime[i] >= 0) {
        maxArrivalTimeS = Math.max(maxArrivalTimeS, arrivalTime[i]);
      }
    }
  }

  let storedVolumeM3 = 0;
  for (let i = 0; i < count; i += 1) {
    storedVolumeM3 += Math.max(depth[i], 0) * cellAreaM2;
  }

  const balanceResidualM3 =
    inputVolumeM3 - outflowVolumeM3 - storedVolumeM3;
  const massBalanceErrorPct =
    inputVolumeM3 > 0
      ? Math.abs(balanceResidualM3) / inputVolumeM3 * 100
      : 0;

  if (boundaryReached) {
    stopReason = "domain-boundary-reached";
  }

  return {
    center: new Point({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: source[2],
      spatialReference: flow.source.spatialReference
    }),
    minX,
    minY,
    width,
    height,
    resolutionX,
    resolutionY,
    cellSize,
    terrain,
    maxDepth,
    arrivalTime,
    maxVelocity,
    wetCellCount,
    wetAreaM2: wetCellCount * cellSize * cellSize,
    overtoppingHeadM: head,
    sourceDepthM,
    peakDischargeM3s,
    effectiveOverflowWidthM,
    inputVolumeM3,
    storedVolumeM3,
    outflowVolumeM3,
    massBalanceErrorPct,
    peakDepthM,
    peakVelocityMs,
    maxArrivalTimeS,
    simulatedDurationS,
    frontDistanceM,
    stopReason,
    frontStillAdvancing
  };
}
