import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import type { DamBarrier } from "./WaterBasin";

export interface DownstreamFlowPath {
  source: Point;
  points: number[][];
  lengthM: number;
  elevationDropM: number;
}

export interface DownstreamInundationSurface {
  ring: number[][];
  areaM2: number;
  maxWidthM: number;
  sourceStageM: number;
}

const STEP_M = 30;
const DIRECTION_COUNT = 16;
const MAX_STEPS = 70;
const MIN_DESCENT_M = 0.15;

function sideOfLine(x: number, y: number, dam: DamBarrier): number {
  return (
    (dam.end.x - dam.start.x) * (y - dam.start.y) -
    (dam.end.y - dam.start.y) * (x - dam.start.x)
  );
}

async function sampleCandidates(
  view: SceneView,
  points: number[][],
  spatialReference: Point["spatialReference"]
): Promise<number[]> {
  const samples = new Multipoint({
    spatialReference,
    points
  });

  const map = view.map;
  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const result = await map.ground.queryElevation(samples, {
    demResolution: "finest-contiguous"
  });

  return result.geometry.points.map((point) => {
    const elevation = point[2];
    return elevation !== undefined && Number.isFinite(elevation)
      ? elevation
      : Number.NaN;
  });
}

export async function traceDownstreamFlow(
  view: SceneView,
  dam: DamBarrier,
  reservoirCenter: Point,
  crestSource: Point
): Promise<DownstreamFlowPath> {
  const reservoirSide = Math.sign(
    sideOfLine(reservoirCenter.x, reservoirCenter.y, dam)
  );

  if (reservoirSide === 0) {
    throw new Error("Unable to determine the downstream side of the dam.");
  }

  const dx = dam.end.x - dam.start.x;
  const dy = dam.end.y - dam.start.y;
  const damLength = Math.hypot(dx, dy);

  if (damLength < 1) {
    throw new Error("Dam geometry is too short for downstream tracing.");
  }

  const nx = -dy / damLength;
  const ny = dx / damLength;
  const downstreamSign = -reservoirSide;

  // Start just beyond the downstream face instead of exactly on the crest.
  const startX = crestSource.x + nx * downstreamSign * STEP_M;
  const startY = crestSource.y + ny * downstreamSign * STEP_M;

  const startElevation = (
    await sampleCandidates(
      view,
      [[startX, startY]],
      crestSource.spatialReference
    )
  )[0];

  if (!Number.isFinite(startElevation)) {
    throw new Error("Unable to sample terrain below the overtopping source.");
  }

  const source = new Point({
    x: startX,
    y: startY,
    z: startElevation,
    spatialReference: crestSource.spatialReference
  });

  const path: number[][] = [[startX, startY, startElevation]];
  let currentX = startX;
  let currentY = startY;
  let currentZ = startElevation;
  let previousHeading = Math.atan2(ny * downstreamSign, nx * downstreamSign);
  let lengthM = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const candidates: number[][] = [];
    const headings: number[] = [];

    for (let i = 0; i < DIRECTION_COUNT; i += 1) {
      const angle =
        previousHeading - Math.PI * 0.75 +
        (i / (DIRECTION_COUNT - 1)) * Math.PI * 1.5;

      headings.push(angle);
      candidates.push([
        currentX + Math.cos(angle) * STEP_M,
        currentY + Math.sin(angle) * STEP_M
      ]);
    }

    const elevations = await sampleCandidates(
      view,
      candidates,
      crestSource.spatialReference
    );

    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < elevations.length; i += 1) {
      const elevation = elevations[i];
      if (!Number.isFinite(elevation)) {
        continue;
      }

      const descent = currentZ - elevation;
      if (descent < MIN_DESCENT_M) {
        continue;
      }

      // Elevation dominates. A small steering penalty avoids unrealistic
      // zig-zags when several neighbouring cells have nearly equal heights.
      const steering = Math.abs(headings[i] - previousHeading);
      const normalizedSteering = Math.min(
        steering,
        Math.PI * 2 - steering
      );
      const score = elevation + normalizedSteering * 0.35;

      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    const next = candidates[bestIndex];
    const nextZ = elevations[bestIndex];

    currentX = next[0];
    currentY = next[1];
    currentZ = nextZ;
    previousHeading = headings[bestIndex];
    path.push([currentX, currentY, currentZ]);
    lengthM += STEP_M;
  }

  return {
    source,
    points: path,
    lengthM,
    elevationDropM: Math.max((startElevation ?? currentZ) - currentZ, 0)
  };
}


const CROSS_SECTION_STEP_M = 15;
const CROSS_SECTION_HALF_WIDTH_M = 180;
const MIN_STAGE_M = 0.35;
const MAX_STAGE_M = 5;

function polygonArea2D(ring: number[][]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) * 0.5;
}

export async function buildDownstreamInundationSurface(
  view: SceneView,
  flow: DownstreamFlowPath,
  overtoppingHeadM: number
): Promise<DownstreamInundationSurface> {
  if (flow.points.length < 2) {
    throw new Error("Downstream path is too short to build an inundation surface.");
  }

  const sourceStageM = Math.min(
    Math.max(MIN_STAGE_M + Math.max(overtoppingHeadM, 0) * 2.5, MIN_STAGE_M),
    MAX_STAGE_M
  );

  const leftBank: number[][] = [];
  const rightBank: number[][] = [];
  let maxWidthM = 0;

  for (let i = 0; i < flow.points.length; i += 1) {
    const current = flow.points[i];
    const previous = flow.points[Math.max(i - 1, 0)];
    const next = flow.points[Math.min(i + 1, flow.points.length - 1)];

    const tx = next[0] - previous[0];
    const ty = next[1] - previous[1];
    const tangentLength = Math.hypot(tx, ty);

    if (tangentLength < 0.001) {
      continue;
    }

    const nx = -ty / tangentLength;
    const ny = tx / tangentLength;
    const progress =
      flow.points.length <= 1 ? 0 : i / (flow.points.length - 1);

    // First approximation: the available hydraulic head decays downstream.
    // The next solver stage will replace this envelope with dynamic shallow
    // water state, but this keeps the initial surface tied to terrain.
    const stageM = Math.max(
      MIN_STAGE_M,
      sourceStageM * (1 - progress * 0.72)
    );
    const waterElevation = current[2] + stageM;

    const offsets: number[] = [];
    const samplePoints: number[][] = [];

    for (
      let distance = -CROSS_SECTION_HALF_WIDTH_M;
      distance <= CROSS_SECTION_HALF_WIDTH_M;
      distance += CROSS_SECTION_STEP_M
    ) {
      offsets.push(distance);
      samplePoints.push([
        current[0] + nx * distance,
        current[1] + ny * distance
      ]);
    }

    const elevations = await sampleCandidates(
      view,
      samplePoints,
      flow.source.spatialReference
    );

    const centerIndex = Math.floor(offsets.length / 2);
    let leftIndex = centerIndex;
    let rightIndex = centerIndex;

    for (let j = centerIndex - 1; j >= 0; j -= 1) {
      const elevation = elevations[j];
      if (!Number.isFinite(elevation) || elevation > waterElevation) {
        break;
      }
      leftIndex = j;
    }

    for (let j = centerIndex + 1; j < offsets.length; j += 1) {
      const elevation = elevations[j];
      if (!Number.isFinite(elevation) || elevation > waterElevation) {
        break;
      }
      rightIndex = j;
    }

    const leftDistance = offsets[leftIndex];
    const rightDistance = offsets[rightIndex];

    leftBank.push([
      current[0] + nx * leftDistance,
      current[1] + ny * leftDistance,
      waterElevation
    ]);

    rightBank.push([
      current[0] + nx * rightDistance,
      current[1] + ny * rightDistance,
      waterElevation
    ]);

    maxWidthM = Math.max(
      maxWidthM,
      Math.abs(rightDistance - leftDistance)
    );
  }

  if (leftBank.length < 2 || rightBank.length < 2) {
    throw new Error("Unable to derive downstream valley cross-sections.");
  }

  const ring = [
    ...leftBank,
    ...rightBank.reverse(),
    leftBank[0]
  ];

  return {
    ring,
    areaM2: polygonArea2D(ring),
    maxWidthM,
    sourceStageM
  };
}

