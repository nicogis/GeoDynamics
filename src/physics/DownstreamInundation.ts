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

  const result = await view.map.ground.queryElevation(samples, {
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
