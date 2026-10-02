import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

const TARGET_CELL_SIZE = 5;
const MIN_RESOLUTION = 128;
const MAX_RESOLUTION = 512;
const MAX_DOMAIN_SIZE = 2400;
const ELEVATION_BATCH_SIZE = 16384;
const DOMAIN_MARGIN = 180;

export interface DamBarrier {
  start: Point;
  end: Point;
}

export interface SampledWaterBasin {
  center: Point;
  size: number;
  resolution: number;
  cellSize: number;
  waterElevation: number;
  damCrestElevation: number;
  maxDamHeight: number;
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
  damLength: number;
  areaM2: number;
  volumeM3: number;
}

interface BasinSample {
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
  areaM2: number;
  volumeM3: number;
}

interface DamProfile {
  crestElevation: number;
  valleyFloorElevation: number;
  maxDamHeight: number;
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

function sideOfLine(
  x: number,
  y: number,
  dam: DamBarrier
): number {
  return (
    (dam.end.x - dam.start.x) * (y - dam.start.y) -
    (dam.end.y - dam.start.y) * (x - dam.start.x)
  );
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, 1)));
}

function resolutionForSize(size: number): number {
  const desired = nextPowerOfTwo(Math.ceil(size / TARGET_CELL_SIZE));
  return Math.min(Math.max(desired, MIN_RESOLUTION), MAX_RESOLUTION);
}

function createSamplingCenter(
  seed: Point,
  dam: DamBarrier
): Point {
  const minX = Math.min(seed.x, dam.start.x, dam.end.x);
  const maxX = Math.max(seed.x, dam.start.x, dam.end.x);
  const minY = Math.min(seed.y, dam.start.y, dam.end.y);
  const maxY = Math.max(seed.y, dam.start.y, dam.end.y);

  return new Point({
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: seed.z,
    spatialReference: seed.spatialReference
  });
}

function initialDomainSize(
  seed: Point,
  dam: DamBarrier
): number {
  const minX = Math.min(seed.x, dam.start.x, dam.end.x);
  const maxX = Math.max(seed.x, dam.start.x, dam.end.x);
  const minY = Math.min(seed.y, dam.start.y, dam.end.y);
  const maxY = Math.max(seed.y, dam.start.y, dam.end.y);

  return Math.max(
    420,
    maxX - minX + DOMAIN_MARGIN * 2,
    maxY - minY + DOMAIN_MARGIN * 2
  );
}

async function queryElevations(
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
    const samples = new Multipoint({
      spatialReference,
      points: batch
    });

    const result = await map.ground.queryElevation(samples, {
      demResolution: "finest-contiguous"
    });

    for (const sampledPoint of result.geometry.points) {
      const elevation = sampledPoint[2];
      elevations.push(
        elevation !== undefined && Number.isFinite(elevation)
          ? elevation
          : Number.NaN
      );
    }
  }

  return elevations;
}

async function sampleDamProfile(
  view: SceneView,
  dam: DamBarrier,
  sampleCount = 65
): Promise<DamProfile> {
  const points: number[][] = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / (sampleCount - 1);
    points.push([
      dam.start.x + (dam.end.x - dam.start.x) * t,
      dam.start.y + (dam.end.y - dam.start.y) * t
    ]);
  }

  const elevations = await queryElevations(
    view,
    points,
    dam.start.spatialReference
  );

  if (
    elevations.length !== sampleCount ||
    elevations.some((elevation) => !Number.isFinite(elevation))
  ) {
    throw new Error("Unable to sample the terrain profile along the dam.");
  }

  const startElevation = elevations[0];
  const endElevation = elevations[elevations.length - 1];

  if (
    startElevation === undefined ||
    endElevation === undefined
  ) {
    throw new Error("Unable to determine the dam abutment elevations.");
  }

  const crestElevation = Math.min(startElevation, endElevation);
  const valleyFloorElevation = Math.min(...elevations);

  return {
    crestElevation,
    valleyFloorElevation,
    maxDamHeight: Math.max(crestElevation - valleyFloorElevation, 0)
  };
}

async function sampleConnectedMask(
  view: SceneView,
  center: Point,
  seed: Point,
  dam: DamBarrier,
  size: number,
  resolution: number,
  waterElevation: number
): Promise<BasinSample> {
  const half = size / 2;
  const step = size / resolution;
  const cellArea = step * step;
  const points: number[][] = [];

  for (let row = 0; row < resolution; row += 1) {
    const y = center.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const x = center.x - half + (col + 0.5) * step;
      points.push([x, y]);
    }
  }

  const elevations = await queryElevations(
    view,
    points,
    center.spatialReference
  );

  const candidate = new Uint8Array(resolution * resolution);
  const seedSide = sideOfLine(seed.x, seed.y, dam);

  if (Math.abs(seedSide) < 0.001) {
    throw new Error("Place the reservoir seed clearly upstream from the dam.");
  }

  for (let row = 0; row < resolution; row += 1) {
    const y = center.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      const elevation = elevations[index];

      if (
        elevation === undefined ||
        !Number.isFinite(elevation) ||
        elevation > waterElevation
      ) {
        continue;
      }

      const x = center.x - half + (col + 0.5) * step;
      const cellSide = sideOfLine(x, y, dam);

      if (cellSide * seedSide >= 0) {
        candidate[index] = 255;
      }
    }
  }

  const seedCol = Math.floor(
    (seed.x - (center.x - half)) / step
  );
  const seedRow = Math.floor(
    (seed.y - (center.y - half)) / step
  );

  if (
    seedCol < 0 ||
    seedCol >= resolution ||
    seedRow < 0 ||
    seedRow >= resolution
  ) {
    throw new Error("The reservoir seed is outside the sampled domain.");
  }

  const seedIndex = seedRow * resolution + seedCol;

  if (candidate[seedIndex] === 0) {
    throw new Error(
      "The upstream seed is above the reservoir level. Move it lower in the valley."
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
  let volumeM3 = 0;

  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) {
      continue;
    }

    wetCellCount += 1;
    const terrainElevation = elevations[i];

    if (terrainElevation !== undefined && Number.isFinite(terrainElevation)) {
      volumeM3 +=
        Math.max(waterElevation - terrainElevation, 0) * cellArea;
    }
  }

  return {
    mask,
    wetCellCount,
    touchesBoundary: touchesMaskBoundary(mask, resolution),
    areaM2: wetCellCount * cellArea,
    volumeM3
  };
}

export async function sampleWaterBasin(
  view: SceneView,
  seed: Point,
  dam: DamBarrier,
  freeboard = 1
): Promise<SampledWaterBasin> {
  if (!seed.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  const damLength = Math.hypot(
    dam.end.x - dam.start.x,
    dam.end.y - dam.start.y
  );

  if (damLength < 10) {
    throw new Error("The dam barrier is too short.");
  }

  const profile = await sampleDamProfile(view, dam);
  const waterElevation =
    profile.crestElevation - Math.max(freeboard, 0);

  const seedElevation = seed.z;
  if (
    seedElevation === undefined ||
    !Number.isFinite(seedElevation) ||
    seedElevation >= waterElevation
  ) {
    throw new Error(
      "Place the reservoir seed upstream on terrain below the dam water level."
    );
  }

  const center = createSamplingCenter(seed, dam);
  let size = Math.min(initialDomainSize(seed, dam), MAX_DOMAIN_SIZE);
  let resolution = resolutionForSize(size);
  let sampled: BasinSample;

  while (true) {
    resolution = resolutionForSize(size);

    sampled = await sampleConnectedMask(
      view,
      center,
      seed,
      dam,
      size,
      resolution,
      waterElevation
    );

    if (!sampled.touchesBoundary || size >= MAX_DOMAIN_SIZE) {
      break;
    }

    size = Math.min(size * 1.5, MAX_DOMAIN_SIZE);
  }

  return {
    center,
    size,
    resolution,
    cellSize: size / resolution,
    waterElevation,
    damCrestElevation: profile.crestElevation,
    maxDamHeight: profile.maxDamHeight,
    mask: sampled.mask,
    wetCellCount: sampled.wetCellCount,
    touchesBoundary: sampled.touchesBoundary,
    damLength,
    areaM2: sampled.areaM2,
    volumeM3: sampled.volumeM3
  };
}
