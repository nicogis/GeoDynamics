import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

export interface SampledTerrain {
  origin: Point;
  heights: Float32Array;
  rows: number;
  cols: number;
  span: number;
  minElevation: number;
  maxElevation: number;
}

export async function sampleTerrainHeightfield(
  view: SceneView,
  center: Point,
  span = 900,
  size = 41
): Promise<SampledTerrain> {
  if (!center.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  if (size < 3 || size % 2 === 0) {
    throw new Error("Heightfield size must be an odd number greater than or equal to 3.");
  }

  const half = span / 2;
  const step = span / (size - 1);
  const points: number[][] = [];

  // Rapier heightfields use a column-major height matrix.
  // Rows advance along local Z (ArcGIS Y / north), columns along local X (east).
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
  const centerIndex = Math.floor(size / 2) * size + Math.floor(size / 2);
  const centerElevation = sampledPoints[centerIndex]?.[2];

  if (!Number.isFinite(centerElevation)) {
    throw new Error("Unable to sample terrain elevation at the release point.");
  }

  const heights = new Float32Array(size * size);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sampledPoints.length; i += 1) {
    const elevation = sampledPoints[i]?.[2];

    if (!Number.isFinite(elevation)) {
      throw new Error("Terrain sampling returned a no-data elevation.");
    }

    heights[i] = elevation - centerElevation;
    minElevation = Math.min(minElevation, elevation);
    maxElevation = Math.max(maxElevation, elevation);
  }

  const origin = new Point({
    x: center.x,
    y: center.y,
    z: centerElevation,
    spatialReference: center.spatialReference
  });

  return {
    origin,
    heights,
    rows: size,
    cols: size,
    span,
    minElevation,
    maxElevation
  };
}
