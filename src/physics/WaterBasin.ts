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
}

export async function sampleWaterBasin(
  view: SceneView,
  seed: Point,
  size = 420,
  resolution = 128,
  waterDepth = 12
): Promise<SampledWaterBasin> {
  if (!seed.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

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
  const seedElevation = seed.z;

  if (!Number.isFinite(seedElevation)) {
    throw new Error("Unable to determine the water seed elevation.");
  }

  const waterElevation = seedElevation + waterDepth;
  const candidate = new Uint8Array(resolution * resolution);

  for (let i = 0; i < candidate.length; i += 1) {
    const elevation = elevations[i]?.[2];

    if (!Number.isFinite(elevation)) {
      continue;
    }

    if (elevation <= waterElevation) {
      candidate[i] = 255;
    }
  }

  const centerCell = Math.floor(resolution / 2);
  const seedIndex = centerCell * resolution + centerCell;

  if (candidate[seedIndex] === 0) {
    candidate[seedIndex] = 255;
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
    center: seed.clone(),
    size,
    resolution,
    waterElevation,
    mask,
    wetCellCount
  };
}
