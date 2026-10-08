import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import type { DownstreamFlowPath } from "./DownstreamInundation";
import type { DownstreamShallowWaterResult } from "./DownstreamShallowWater";
import {
  expectedTriangularHydrographVolumeM3,
  triangularHydrographFactor
} from "./DownstreamSolverCore";
import {
  advanceSwe2D,
  computeSwe2DVolumeM3,
  createSwe2DState
} from "./ShallowWater2D";

const TARGET_CELL_SIZE_M = 20;
const MAX_RESOLUTION = 128;
const DOMAIN_MARGIN_M = 300;
const GRAVITY = 9.81;
const MANNING_N = 0.045;
const DRY_DEPTH_M = 1e-5;
const DISPLAY_WET_DEPTH_M = 0.01;
const WEIR_COEFFICIENT = 1.7;
const MAX_SIMULATION_SECONDS = 900;
const MAX_SIMULATION_STEPS = 3000;
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
      const z = point[2];
      elevations.push(
        z !== undefined && Number.isFinite(z) ? z : Number.NaN
      );
    }
  }

  return elevations;
}

function indexOf(row: number, col: number, width: number): number {
  return row * width + col;
}

export async function simulateDownstreamSwe2D(
  view: SceneView,
  flow: DownstreamFlowPath,
  overtoppingHeadM: number,
  measuredOverflowWidthM?: number
): Promise<DownstreamShallowWaterResult> {
  if (flow.points.length < 2) {
    throw new Error("Downstream flow path is too short for SWE 2D simulation.");
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

  const samplePoints: number[][] = [];
  for (let row = 0; row < resolutionY; row += 1) {
    const y = minY + row * cellSize;
    for (let col = 0; col < resolutionX; col += 1) {
      const x = minX + col * cellSize;
      samplePoints.push([x, y]);
    }
  }

  const sampled = await sampleTerrain(
    view,
    samplePoints,
    flow.source.spatialReference
  );

  const count = resolutionX * resolutionY;
  let finiteSum = 0;
  let finiteCount = 0;
  for (const value of sampled) {
    if (Number.isFinite(value)) {
      finiteSum += value;
      finiteCount += 1;
    }
  }
  if (finiteCount === 0) {
    throw new Error("SWE 2D terrain sampling returned no finite elevations.");
  }
  const fallbackElevation = finiteSum / finiteCount;

  const terrain = new Float32Array(count);
  const bed = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const z = Number.isFinite(sampled[i]) ? sampled[i] : fallbackElevation;
    terrain[i] = z;
    bed[i] = z;
  }

  const state = createSwe2DState(count);
  const maxDepth = new Float32Array(count);
  const previousDepth = new Float64Array(count);
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
  const effectiveOverflowWidthM =
    measuredOverflowWidthM !== undefined &&
    Number.isFinite(measuredOverflowWidthM) &&
    measuredOverflowWidthM > 0
      ? Math.max(measuredOverflowWidthM, 1)
      : cellSize * 3;
  const peakDischargeM3s =
    WEIR_COEFFICIENT *
    effectiveOverflowWidthM *
    Math.pow(head, 1.5);
  const sourcePulseSeconds = Math.min(
    Math.max(
      30 + head * 90 + Math.sqrt(effectiveOverflowWidthM) * 4,
      30
    ),
    240
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
      sourceIndices.push(indexOf(row, col, resolutionX));
    }
  }

  const cellAreaM2 = cellSize * cellSize;
  const grid = {
    nx: resolutionX,
    ny: resolutionY,
    dx: cellSize,
    dy: cellSize,
    bed
  };

  let inputVolumeM3 = 0;
  let simulatedDurationS = 0;
  let peakVelocityMs = 0;
  let maxArrivalTimeS = 0;
  let stableSteps = 0;
  let stopReason: DownstreamShallowWaterResult["stopReason"] =
    "duration-limit";
  let boundaryReached = false;

  for (let step = 0; step < MAX_SIMULATION_STEPS; step += 1) {
    if (simulatedDurationS >= MAX_SIMULATION_SECONDS) {
      stopReason = "duration-limit";
      break;
    }

    previousDepth.set(state.h);

    const diagnostics = advanceSwe2D(state, grid, {
      gravity: GRAVITY,
      cfl: 0.32,
      dryDepth: DRY_DEPTH_M,
      manningN: MANNING_N,
      maxDtSeconds: 1
    });
    const dtSeconds = diagnostics.dtSeconds;

    if (
      simulatedDurationS <= sourcePulseSeconds &&
      peakDischargeM3s > 0
    ) {
      const factor = triangularHydrographFactor(
        simulatedDurationS,
        sourcePulseSeconds
      );
      const injectedVolumeM3 = peakDischargeM3s * factor * dtSeconds;
      const injectedDepth =
        injectedVolumeM3 / (sourceIndices.length * cellAreaM2);

      for (const sourceIndex of sourceIndices) {
        state.h[sourceIndex] += injectedDepth;
      }

      inputVolumeM3 += injectedVolumeM3;
    }

    simulatedDurationS += dtSeconds;
    let wetCellsThisStep = 0;
    let newWetCells = 0;
    let maxDepthChange = 0;

    for (let i = 0; i < count; i += 1) {
      const h = state.h[i];
      maxDepthChange = Math.max(
        maxDepthChange,
        Math.abs(h - previousDepth[i])
      );
      if (h > maxDepth[i]) {
        maxDepth[i] = h;
      }

      if (h > DISPLAY_WET_DEPTH_M) {
        wetCellsThisStep += 1;
        if (arrivalTime[i] < 0) {
          arrivalTime[i] = simulatedDurationS;
          newWetCells += 1;
        }
      }

      if (h > DRY_DEPTH_M) {
        const velocity = Math.hypot(
          state.hu[i] / h,
          state.hv[i] / h
        );
        maxVelocity[i] = Math.max(maxVelocity[i], velocity);
        peakVelocityMs = Math.max(peakVelocityMs, velocity);
      }
    }

    for (let col = 0; col < resolutionX; col += 1) {
      if (
        state.h[indexOf(0, col, resolutionX)] > DISPLAY_WET_DEPTH_M ||
        state.h[
          indexOf(resolutionY - 1, col, resolutionX)
        ] > DISPLAY_WET_DEPTH_M
      ) {
        boundaryReached = true;
      }
    }
    for (let row = 0; row < resolutionY; row += 1) {
      if (
        state.h[indexOf(row, 0, resolutionX)] > DISPLAY_WET_DEPTH_M ||
        state.h[
          indexOf(row, resolutionX - 1, resolutionX)
        ] > DISPLAY_WET_DEPTH_M
      ) {
        boundaryReached = true;
      }
    }

    const sourceFinished = simulatedDurationS > sourcePulseSeconds;
    const stable =
      sourceFinished &&
      newWetCells === 0 &&
      maxDepthChange < 1e-4;

    stableSteps = stable ? stableSteps + 1 : 0;

    if (boundaryReached) {
      stopReason = "domain-boundary-reached";
      break;
    }

    if (stableSteps >= 40 && wetCellsThisStep > 0) {
      stopReason = "converged";
      break;
    }

    if (step === MAX_SIMULATION_STEPS - 1) {
      stopReason = "step-limit";
    }
  }

  let wetCellCount = 0;
  let wetAreaM2 = 0;
  let peakDepthM = 0;
  let sourceDepthM = 0;
  let frontDistanceM = 0;

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / resolutionX);
    const col = i % resolutionX;
    const h = maxDepth[i];

    if (Math.hypot(row - sourceRow, col - sourceCol) <= 2) {
      sourceDepthM = Math.max(sourceDepthM, h);
    } else {
      peakDepthM = Math.max(peakDepthM, h);
    }

    if (h > DISPLAY_WET_DEPTH_M) {
      wetCellCount += 1;
      wetAreaM2 += cellAreaM2;
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

  const storedVolumeM3 = computeSwe2DVolumeM3(state, grid);
  const outflowVolumeM3 = 0;
  const massBalanceResidualM3 =
    inputVolumeM3 - storedVolumeM3 - outflowVolumeM3;
  const massBalanceErrorPct =
    inputVolumeM3 > 0
      ? Math.abs(massBalanceResidualM3) / inputVolumeM3 * 100
      : 0;
  const expectedHydrographVolumeM3 =
    expectedTriangularHydrographVolumeM3(
      peakDischargeM3s,
      sourcePulseSeconds
    );
  const hydrographVolumeErrorPct =
    expectedHydrographVolumeM3 > 0
      ? Math.abs(inputVolumeM3 - expectedHydrographVolumeM3) /
        expectedHydrographVolumeM3 *
        100
      : 0;

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
    wetAreaM2,
    overtoppingHeadM: head,
    sourceDepthM,
    peakDischargeM3s,
    effectiveOverflowWidthM,
    manningN: MANNING_N,
    hydrographDurationS: sourcePulseSeconds,
    inputVolumeM3,
    storedVolumeM3,
    outflowVolumeM3,
    massBalanceResidualM3,
    massBalanceErrorPct,
    expectedHydrographVolumeM3,
    hydrographVolumeErrorPct,
    peakDepthM,
    peakVelocityMs,
    maxArrivalTimeS,
    simulatedDurationS,
    frontDistanceM,
    frontSpeedMs:
      simulatedDurationS > 0
        ? frontDistanceM / simulatedDurationS
        : 0,
    simulationBlocks: 1,
    domainExpansionCount: 0,
    domainMarginM: DOMAIN_MARGIN_M,
    stopReason,
    frontStillAdvancing: stopReason !== "converged"
  };
}
