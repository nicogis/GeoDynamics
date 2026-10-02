import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

export interface DamBarrier {
  start: Point;
  end: Point;
}

export interface SampledWaterBasin {
  center: Point;
  size: number;
  resolution: number;
  waterElevation: number;
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
  damLength: number;
}

interface BasinSample {
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
}

function rotateMaskClockwise(
  mask: Uint8Array,
  resolution: number
): Uint8Array {
  const rotated = new Uint8Array(mask.length);

  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const sourceIndex = row * resolution + col;
      const targetRow = col;
      const targetCol = resolution - 1 - row;
      rotated[targetRow * resolution + targetCol] = mask[sourceIndex];
    }
  }

  return rotated;
}

function touchesMaskBoundary(
  mask: Uint8Array,
  resolution: number
): boolean {
  for (let i = 0; i < resolution; i += 1) {
    const top = i;
    const bottom = (resolution - 1) * resolution + i;
    const left = i * resolution;
    const right = i * resolution + (resolution - 1);

    if (
      mask[top] !== 0 ||
      mask[bottom] !== 0 ||
      mask[left] !== 0 ||
      mask[right] !== 0
    ) {
      return true;
    }
  }

  return false;
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSquared = abx * abx + aby * aby;

  if (lengthSquared === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  const t = Math.min(
    Math.max((apx * abx + apy * aby) / lengthSquared, 0),
    1
  );
  const cx = ax + t * abx;
  const cy = ay + t * aby;

  return Math.hypot(px - cx, py - cy);
}

async function sampleConnectedMask(
  view: SceneView,
  seed: Point,
  dam: DamBarrier,
  size: number,
  resolution: number,
  waterElevation: number
): Promise<BasinSample> {
  const map = view.map;
  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const half = size / 2;
  const step = size / resolution;
  const points: number[][] = [];

  for (let row = 0; row < resolution; row += 1) {
    const y = seed.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const x = seed.x - half + (col + 0.5) * step;
      points.push([x, y]);
    }
  }

  const samples = new Multipoint({
    spatialReference: seed.spatialReference,
    points
  });

  const result = await map.ground.queryElevation(samples, {
    demResolution: "finest-contiguous"
  });

  const elevations = result.geometry.points;
  const candidate = new Uint8Array(resolution * resolution);

  // Make the numerical barrier slightly thicker than one DEM cell so the
  // 4-neighbour flood fill cannot leak through a diagonal gap.
  const barrierHalfWidth = Math.max(step * 1.35, 4);

  for (let row = 0; row < resolution; row += 1) {
    const y = seed.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      const elevation = elevations[index]?.[2];

      if (!Number.isFinite(elevation) || elevation > waterElevation) {
        continue;
      }

      const x = seed.x - half + (col + 0.5) * step;
      const distanceToDam = pointToSegmentDistance(
        x,
        y,
        dam.start.x,
        dam.start.y,
        dam.end.x,
        dam.end.y
      );

      if (distanceToDam > barrierHalfWidth) {
        candidate[index] = 255;
      }
    }
  }

  const seedCol = Math.min(
    Math.max(Math.floor((seed.x - (seed.x - half)) / step), 0),
    resolution - 1
  );
  const seedRow = Math.min(
    Math.max(Math.floor((seed.y - (seed.y - half)) / step), 0),
    resolution - 1
  );
  const seedIndex = seedRow * resolution + seedCol;

  if (candidate[seedIndex] === 0) {
    throw new Error(
      "The basin seed is outside the reservoir water level or too close to the dam."
    );
  }

  const mask = new Uint8Array(candidate.length);
  const queue = new Int32Array(candidate.length);
  let head = 0;
  let tail = 0;

  queue[tail++] = seedIndex;
  mask[seedIndex] = 255;

  while (head < tail) {
    const index = queue[head++];
    const row = Math.floor(index / resolution);
    const col = index % resolution;

    const tryAdd = (r: number, c: number) => {
      if (r < 0 || r >= resolution || c < 0 || c >= resolution) {
        return;
      }

      const neighbor = r * resolution + c;
      if (candidate[neighbor] === 0 || mask[neighbor] !== 0) {
        return;
      }

      mask[neighbor] = 255;
      queue[tail++] = neighbor;
    };

    tryAdd(row - 1, col);
    tryAdd(row + 1, col);
    tryAdd(row, col - 1);
    tryAdd(row, col + 1);
  }

  let wetCellCount = 0;
  for (const value of mask) {
    if (value !== 0) {
      wetCellCount += 1;
    }
  }

  return {
    mask,
    wetCellCount,
    touchesBoundary: touchesMaskBoundary(mask, resolution)
  };
}

export async function sampleWaterBasin(
  view: SceneView,
  seed: Point,
  dam: DamBarrier,
  initialSize = 420,
  resolution = 128,
  freeboard = 1
): Promise<SampledWaterBasin> {
  if (!seed.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  const startElevation = dam.start.z;
  const endElevation = dam.end.z;

  if (
    startElevation === undefined ||
    endElevation === undefined ||
    !Number.isFinite(startElevation) ||
    !Number.isFinite(endElevation)
  ) {
    throw new Error("Unable to determine the dam crest elevation.");
  }

  // The reservoir cannot stand above the lower dam abutment. A small
  // freeboard keeps the POC water surface below the crest.
  const waterElevation =
    Math.min(startElevation, endElevation) - Math.max(freeboard, 0);

  const seedElevation = seed.z;
  if (
    seedElevation === undefined ||
    !Number.isFinite(seedElevation) ||
    seedElevation >= waterElevation
  ) {
    throw new Error(
      "Place the basin seed upstream on terrain below the dam crest elevation."
    );
  }

  const damLength = Math.hypot(
    dam.end.x - dam.start.x,
    dam.end.y - dam.start.y
  );

  if (damLength < 10) {
    throw new Error("The dam barrier is too short.");
  }

  const maxSize = 2400;
  let size = initialSize;
  let sampled: BasinSample;

  while (true) {
    sampled = await sampleConnectedMask(
      view,
      seed,
      dam,
      size,
      resolution,
      waterElevation
    );

    if (!sampled.touchesBoundary || size >= maxSize) {
      break;
    }

    size = Math.min(size * 1.5, maxSize);
  }

  const rotatedMask = rotateMaskClockwise(sampled.mask, resolution);

  return {
    center: seed.clone(),
    size,
    resolution,
    waterElevation,
    mask: rotatedMask,
    wetCellCount: sampled.wetCellCount,
    touchesBoundary: sampled.touchesBoundary,
    damLength
  };
}
