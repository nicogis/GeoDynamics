import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

export interface SampledWaterBasin {
  center: Point;
  size: number;
  resolution: number;
  waterElevation: number;
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
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

async function sampleConnectedMask(
  view: SceneView,
  seed: Point,
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

  for (let i = 0; i < candidate.length; i += 1) {
    const elevation = elevations[i]?.[2];

    if (Number.isFinite(elevation) && elevation <= waterElevation) {
      candidate[i] = 255;
    }
  }

  const centerCell = Math.floor(resolution / 2);
  const seedIndex = centerCell * resolution + centerCell;
  candidate[seedIndex] = 255;

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
  initialSize = 420,
  resolution = 128,
  waterDepth = 12
): Promise<SampledWaterBasin> {
  if (!seed.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  const seedElevation = seed.z;
  if (seedElevation === undefined || !Number.isFinite(seedElevation)) {
    throw new Error("Unable to determine the water seed elevation.");
  }

  const waterElevation = seedElevation + waterDepth;
  const maxSize = 1680;
  let size = initialSize;
  let sampled: BasinSample;

  while (true) {
    sampled = await sampleConnectedMask(
      view,
      seed,
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
    touchesBoundary: sampled.touchesBoundary
  };
}
