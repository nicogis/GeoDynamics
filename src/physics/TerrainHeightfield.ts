import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

const DEFAULT_TERRAIN_SPAN = 4800;
const TARGET_TERRAIN_CELL_SIZE = 18.75;
const MIN_TERRAIN_GRID_SIZE = 129;
const MAX_TERRAIN_GRID_SIZE = 257;
const ELEVATION_BATCH_SIZE = 16384;

export interface SampledTerrainMesh {
  origin: Point;
  vertices: Float32Array;
  indices: Uint32Array;
  rows: number;
  cols: number;
  span: number;
  minElevation: number;
  maxElevation: number;
  lowestPoint: Point;
}

function adaptiveGridSize(span: number): number {
  const intervals = Math.ceil(span / TARGET_TERRAIN_CELL_SIZE);
  let size = intervals + 1;

  // Keep a true center sample so the release point remains an exact grid node.
  if (size % 2 === 0) {
    size += 1;
  }

  return Math.min(
    Math.max(size, MIN_TERRAIN_GRID_SIZE),
    MAX_TERRAIN_GRID_SIZE
  );
}

async function queryElevations(
  view: SceneView,
  points: number[][],
  spatialReference: Point["spatialReference"]
): Promise<number[][]> {
  const map = view.map;

  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const sampledPoints: number[][] = [];

  for (let offset = 0; offset < points.length; offset += ELEVATION_BATCH_SIZE) {
    const batch = points.slice(offset, offset + ELEVATION_BATCH_SIZE);
    const samples = new Multipoint({
      spatialReference,
      points: batch
    });

    const result = await map.ground.queryElevation(samples, {
      demResolution: "finest-contiguous"
    });

    sampledPoints.push(...result.geometry.points);
  }

  return sampledPoints;
}

export async function sampleTerrainMesh(
  view: SceneView,
  center: Point,
  span = DEFAULT_TERRAIN_SPAN,
  size?: number
): Promise<SampledTerrainMesh> {
  if (!center.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  const gridSize = size ?? adaptiveGridSize(span);

  if (gridSize < 3 || gridSize % 2 === 0) {
    throw new Error(
      "Terrain grid size must be an odd number greater than or equal to 3."
    );
  }

  const half = span / 2;
  const step = span / (gridSize - 1);
  const points: number[][] = [];

  for (let col = 0; col < gridSize; col += 1) {
    const x = center.x - half + col * step;

    for (let row = 0; row < gridSize; row += 1) {
      const y = center.y - half + row * step;
      points.push([x, y]);
    }
  }

  const sampledPoints = await queryElevations(
    view,
    points,
    center.spatialReference
  );

  if (sampledPoints.length !== points.length) {
    throw new Error("Terrain sampling returned an incomplete elevation grid.");
  }

  const centerOffset = Math.floor(gridSize / 2);
  const centerIndex = centerOffset * gridSize + centerOffset;
  const centerElevation = sampledPoints[centerIndex]?.[2];

  if (!Number.isFinite(centerElevation)) {
    throw new Error("Unable to sample terrain elevation at the release point.");
  }

  const vertices = new Float32Array(gridSize * gridSize * 3);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  let minSampleIndex = -1;

  for (let col = 0; col < gridSize; col += 1) {
    for (let row = 0; row < gridSize; row += 1) {
      const sampleIndex = col * gridSize + row;
      const elevation = sampledPoints[sampleIndex]?.[2];

      if (!Number.isFinite(elevation)) {
        throw new Error("Terrain sampling returned a no-data elevation.");
      }

      const vertexIndex = sampleIndex * 3;
      vertices[vertexIndex] = -half + col * step;
      vertices[vertexIndex + 1] = elevation - centerElevation;
      vertices[vertexIndex + 2] = -half + row * step;

      if (elevation < minElevation) {
        minElevation = elevation;
        minSampleIndex = sampleIndex;
      }

      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  const triangleCount = (gridSize - 1) * (gridSize - 1) * 2;
  const indices = new Uint32Array(triangleCount * 3);
  let indexOffset = 0;

  for (let col = 0; col < gridSize - 1; col += 1) {
    for (let row = 0; row < gridSize - 1; row += 1) {
      const a = col * gridSize + row;
      const b = (col + 1) * gridSize + row;
      const c = col * gridSize + row + 1;
      const d = (col + 1) * gridSize + row + 1;

      indices[indexOffset++] = a;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;

      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = d;
    }
  }

  const minSample = sampledPoints[minSampleIndex];

  if (!minSample) {
    throw new Error("Unable to determine the lowest sampled terrain point.");
  }

  const lowestPoint = new Point({
    x: minSample[0],
    y: minSample[1],
    z: minSample[2],
    spatialReference: center.spatialReference
  });

  const origin = new Point({
    x: center.x,
    y: center.y,
    z: centerElevation,
    spatialReference: center.spatialReference
  });

  return {
    origin,
    vertices,
    indices,
    rows: gridSize,
    cols: gridSize,
    span,
    minElevation,
    maxElevation,
    lowestPoint
  };
}
