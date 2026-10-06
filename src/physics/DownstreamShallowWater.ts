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
  peakDepthM: number;
  peakVelocityMs: number;
  maxArrivalTimeS: number;
}

const TARGET_CELL_SIZE_M = 20;
const MAX_RESOLUTION = 128;
const DOMAIN_MARGIN_M = 220;
const STEPS = 180;
const DT_SECONDS = 0.45;
const GRAVITY = 9.81;
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
  overtoppingHeadM: number
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
  const sourceDepth = Math.min(
    Math.max(0.25 + Math.max(overtoppingHeadM, 0) * 4, 0.25),
    4
  );

  for (let row = Math.max(0, sourceRow - 1); row <= Math.min(resolutionY - 1, sourceRow + 1); row += 1) {
    for (let col = Math.max(0, sourceCol - 1); col <= Math.min(resolutionX - 1, sourceCol + 1); col += 1) {
      const index = indexOf(row, col, resolutionX);
      if (Number.isFinite(terrain[index])) {
        depth[index] = sourceDepth;
        maxDepth[index] = sourceDepth;
        arrivalTime[index] = 0;
      }
    }
  }

  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1]
  ] as const;

  for (let step = 0; step < STEPS; step += 1) {
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
        let available = localDepth * 0.32;

        for (const [dr, dc] of neighbors) {
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
          const velocity = Math.min(
            waveCelerity * Math.sqrt(Math.min(headDifference / cellSize, 1)),
            12
          );
          const courantTransfer = Math.min(
            available,
            velocity * DT_SECONDS / cellSize * localDepth * 0.22,
            headDifference * 0.16
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

    const swap = depth;
    depth = nextDepth;
    nextDepth = swap;

    const simulationTime = (step + 1) * DT_SECONDS;
    for (let i = 0; i < count; i += 1) {
      const value = depth[i];
      if (value > maxDepth[i]) {
        maxDepth[i] = value;
      }
      if (value > MIN_WET_DEPTH_M && arrivalTime[i] < 0) {
        arrivalTime[i] = simulationTime;
      }
    }
  }

  let wetCellCount = 0;
  let peakDepthM = 0;
  let peakVelocityMs = 0;
  let maxArrivalTimeS = 0;
  const sourceExclusionRadiusCells = 2;

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / resolutionX);
    const col = i % resolutionX;
    const distanceFromSource = Math.hypot(
      row - sourceRow,
      col - sourceCol
    );

    if (distanceFromSource > sourceExclusionRadiusCells) {
      peakDepthM = Math.max(peakDepthM, maxDepth[i]);
      peakVelocityMs = Math.max(peakVelocityMs, maxVelocity[i]);
    }

    if (maxDepth[i] > MIN_WET_DEPTH_M) {
      wetCellCount += 1;
      if (arrivalTime[i] >= 0) {
        maxArrivalTimeS = Math.max(maxArrivalTimeS, arrivalTime[i]);
      }
    }
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
    overtoppingHeadM: Math.max(overtoppingHeadM, 0),
    sourceDepthM: sourceDepth,
    peakDepthM,
    peakVelocityMs,
    maxArrivalTimeS
  };
}
