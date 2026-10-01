import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

export interface SampledTerrainMesh {
  origin: Point;
  vertices: Float32Array;
  indices: Uint32Array;
  rows: number;
  cols: number;
  span: number;
  minElevation: number;
  maxElevation: number;
}

export async function sampleTerrainMesh(
  view: SceneView,
  center: Point,
  span = 2400,
  size = 65
): Promise<SampledTerrainMesh> {
  if (!center.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  if (size < 3 || size % 2 === 0) {
    throw new Error("Terrain grid size must be an odd number greater than or equal to 3.");
  }

  const half = span / 2;
  const step = span / (size - 1);
  const points: number[][] = [];

  for (let col = 0; col < size; col += 1) {
    const x = center.x - half + col * step;

    for (let row = 0; row < size; row += 1) {
      const y = center.y - half + row * step;
      points.push([x, y]);
    }
  }

  const samples = new Multipoint({
    spatialReference: center.spatialReference,
    points
  });

  const map = view.map;

  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const result = await map.ground.queryElevation(samples, {
    demResolution: "finest-contiguous"
  });

  const sampledPoints = result.geometry.points;
  const centerOffset = Math.floor(size / 2);
  const centerIndex = centerOffset * size + centerOffset;
  const centerElevation = sampledPoints[centerIndex]?.[2];

  if (!Number.isFinite(centerElevation)) {
    throw new Error("Unable to sample terrain elevation at the release point.");
  }

  const vertices = new Float32Array(size * size * 3);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size; row += 1) {
      const sampleIndex = col * size + row;
      const elevation = sampledPoints[sampleIndex]?.[2];

      if (!Number.isFinite(elevation)) {
        throw new Error("Terrain sampling returned a no-data elevation.");
      }

      const vertexIndex = sampleIndex * 3;
      vertices[vertexIndex] = -half + col * step;
      vertices[vertexIndex + 1] = elevation - centerElevation;
      vertices[vertexIndex + 2] = -half + row * step;

      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  const triangleCount = (size - 1) * (size - 1) * 2;
  const indices = new Uint32Array(triangleCount * 3);
  let indexOffset = 0;

  for (let col = 0; col < size - 1; col += 1) {
    for (let row = 0; row < size - 1; row += 1) {
      const a = col * size + row;
      const b = (col + 1) * size + row;
      const c = col * size + row + 1;
      const d = (col + 1) * size + row + 1;

      // Counter-clockwise winding when viewed from above (positive local Y).
      indices[indexOffset++] = a;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;

      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = d;
    }
  }

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
    rows: size,
    cols: size,
    span,
    minElevation,
    maxElevation
  };
}
