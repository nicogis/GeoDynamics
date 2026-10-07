import type { DownstreamShallowWaterResult } from "../physics/DownstreamShallowWater";

export type FloodHazardClass = "low" | "moderate" | "high" | "extreme";

const DISPLAY_WET_DEPTH_M = 0.01;
const EARTH_RADIUS_M = 6378137;

export function floodHazardIndex(depthM: number, velocityMs: number): number {
  return Math.max(depthM, 0) * Math.max(velocityMs, 0);
}

export function classifyFloodHazard(index: number): FloodHazardClass {
  if (index < 0.5) return "low";
  if (index < 1.5) return "moderate";
  if (index < 3) return "high";
  return "extreme";
}

export interface FloodHazardSummary {
  lowAreaM2: number;
  moderateAreaM2: number;
  highAreaM2: number;
  extremeAreaM2: number;
  maxHazardIndex: number;
}

export function summarizeFloodHazard(
  result: DownstreamShallowWaterResult
): FloodHazardSummary {
  const summary: FloodHazardSummary = {
    lowAreaM2: 0,
    moderateAreaM2: 0,
    highAreaM2: 0,
    extremeAreaM2: 0,
    maxHazardIndex: 0
  };
  const cellArea = result.cellSize * result.cellSize;

  for (let i = 0; i < result.maxDepth.length; i += 1) {
    if (result.maxDepth[i] <= DISPLAY_WET_DEPTH_M) continue;

    const index = floodHazardIndex(
      result.maxDepth[i],
      result.maxVelocity[i]
    );
    summary.maxHazardIndex = Math.max(summary.maxHazardIndex, index);

    switch (classifyFloodHazard(index)) {
      case "low":
        summary.lowAreaM2 += cellArea;
        break;
      case "moderate":
        summary.moderateAreaM2 += cellArea;
        break;
      case "high":
        summary.highAreaM2 += cellArea;
        break;
      case "extreme":
        summary.extremeAreaM2 += cellArea;
        break;
    }
  }

  return summary;
}

function webMercatorToLonLat(x: number, y: number): [number, number] {
  const longitude = (x / EARTH_RADIUS_M) * (180 / Math.PI);
  const latitude =
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) *
    (180 / Math.PI);
  return [longitude, latitude];
}

export function buildHazardGeoJson(
  result: DownstreamShallowWaterResult
): Record<string, unknown> {
  const half = result.cellSize * 0.5;
  const features: Record<string, unknown>[] = [];

  for (let row = 0; row < result.resolutionY; row += 1) {
    for (let col = 0; col < result.resolutionX; col += 1) {
      const index = row * result.resolutionX + col;
      const depth = result.maxDepth[index];
      if (depth <= DISPLAY_WET_DEPTH_M) continue;

      const velocity = result.maxVelocity[index];
      const hazardIndex = floodHazardIndex(depth, velocity);
      const x = result.minX + col * result.cellSize;
      const y = result.minY + row * result.cellSize;

      const ring = [
        webMercatorToLonLat(x - half, y - half),
        webMercatorToLonLat(x + half, y - half),
        webMercatorToLonLat(x + half, y + half),
        webMercatorToLonLat(x - half, y + half),
        webMercatorToLonLat(x - half, y - half)
      ];

      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [ring]
        },
        properties: {
          maxDepthM: depth,
          peakVelocityMs: velocity,
          arrivalTimeS:
            result.arrivalTime[index] >= 0
              ? result.arrivalTime[index]
              : null,
          thinSheet: result.arrivalTime[index] < 0,
          hazardIndex,
          hazardClass: classifyFloodHazard(hazardIndex),
          cellSizeM: result.cellSize
        }
      });
    }
  }

  return {
    type: "FeatureCollection",
    name: "GeoDynamics downstream hazard",
    features,
    geodynamics: {
      cellSizeM: result.cellSize,
      overtoppingHeadM: result.overtoppingHeadM,
      peakDischargeM3s: result.peakDischargeM3s,
      overflowWidthM: result.effectiveOverflowWidthM,
      manningN: result.manningN,
      stopReason: result.stopReason,
      frontStillAdvancing: result.frontStillAdvancing
    }
  };
}

export function downloadHazardGeoJson(
  result: DownstreamShallowWaterResult
): void {
  const blob = new Blob(
    [JSON.stringify(buildHazardGeoJson(result), null, 2)],
    { type: "application/geo+json" }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "geodynamics-hazard.geojson";
  anchor.click();
  URL.revokeObjectURL(url);
}
