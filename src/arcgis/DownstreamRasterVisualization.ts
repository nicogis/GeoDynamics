import Graphic from "@arcgis/core/Graphic";
import Polygon from "@arcgis/core/geometry/Polygon";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";

import type { DownstreamShallowWaterResult } from "../physics/DownstreamShallowWater";

export type DownstreamRasterMetric = "depth" | "velocity" | "arrival" | "off";

export interface DownstreamRasterLegend {
  title: string;
  minLabel: string;
  maxLabel: string;
  gradient: string;
}

const MIN_WET_DEPTH_M = 0.03;

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  const p = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * p),
    Math.round(a[1] + (b[1] - a[1]) * p),
    Math.round(a[2] + (b[2] - a[2]) * p)
  ];
}

function threeStopColor(
  low: readonly [number, number, number],
  mid: readonly [number, number, number],
  high: readonly [number, number, number],
  t: number
): [number, number, number] {
  const p = clamp01(t);
  return p <= 0.5
    ? mix(low, mid, p * 2)
    : mix(mid, high, (p - 0.5) * 2);
}

function metricValue(
  result: DownstreamShallowWaterResult,
  metric: Exclude<DownstreamRasterMetric, "off">,
  index: number
): number {
  switch (metric) {
    case "depth":
      return result.maxDepth[index];
    case "velocity":
      return result.maxVelocity[index];
    case "arrival":
      return result.arrivalTime[index];
  }
}

function metricMaximum(
  result: DownstreamShallowWaterResult,
  metric: Exclude<DownstreamRasterMetric, "off">
): number {
  switch (metric) {
    case "depth":
      return Math.max(result.peakDepthM, MIN_WET_DEPTH_M);
    case "velocity":
      return Math.max(result.peakVelocityMs, 0.1);
    case "arrival":
      return Math.max(result.maxArrivalTimeS, 1);
  }
}

function metricColor(
  metric: Exclude<DownstreamRasterMetric, "off">,
  normalized: number
): [number, number, number] {
  switch (metric) {
    case "depth":
      return threeStopColor(
        [145, 235, 255],
        [25, 145, 225],
        [5, 45, 120],
        normalized
      );
    case "velocity":
      return threeStopColor(
        [255, 235, 120],
        [255, 145, 35],
        [190, 25, 25],
        normalized
      );
    case "arrival":
      return threeStopColor(
        [80, 55, 150],
        [45, 185, 185],
        [245, 220, 75],
        normalized
      );
  }
}

function isRenderableCell(
  result: DownstreamShallowWaterResult,
  metric: Exclude<DownstreamRasterMetric, "off">,
  index: number
): boolean {
  if (result.maxDepth[index] <= MIN_WET_DEPTH_M) {
    return false;
  }

  if (metric === "arrival") {
    return result.arrivalTime[index] >= 0;
  }

  return metricValue(result, metric, index) > 0;
}

export function renderDownstreamRaster(
  layer: GraphicsLayer,
  result: DownstreamShallowWaterResult | null,
  metric: DownstreamRasterMetric,
  opacity: number
): void {
  layer.removeAll();

  if (!result || metric === "off") {
    return;
  }

  const maxValue = metricMaximum(result, metric);
  const half = result.cellSize * 0.5;
  const graphics: Graphic[] = [];

  for (let row = 0; row < result.resolutionY; row += 1) {
    for (let col = 0; col < result.resolutionX; col += 1) {
      const index = row * result.resolutionX + col;

      if (!isRenderableCell(result, metric, index)) {
        continue;
      }

      const x = result.minX + col * result.cellSize;
      const y = result.minY + row * result.cellSize;
      const value = metricValue(result, metric, index);
      const normalized = clamp01(value / maxValue);
      const [r, g, b] = metricColor(metric, normalized);

      const polygon = new Polygon({
        spatialReference: result.center.spatialReference,
        rings: [[
          [x - half, y - half],
          [x + half, y - half],
          [x + half, y + half],
          [x - half, y + half],
          [x - half, y - half]
        ]]
      });

      graphics.push(
        new Graphic({
          geometry: polygon,
          symbol: new SimpleFillSymbol({
            color: [r, g, b, Math.round(clamp01(opacity) * 255)],
            outline: {
              color: [0, 0, 0, 0],
              width: 0
            }
          }),
          attributes: {
            maxDepthM: result.maxDepth[index],
            peakVelocityMs: result.maxVelocity[index],
            arrivalTimeS: result.arrivalTime[index],
            cellSizeM: result.cellSize
          },
          popupTemplate: {
            title: "Downstream raster cell",
            content: [
              {
                type: "fields",
                fieldInfos: [
                  {
                    fieldName: "maxDepthM",
                    label: "Max depth (m)",
                    format: { digitSeparator: true, places: 2 }
                  },
                  {
                    fieldName: "peakVelocityMs",
                    label: "Peak velocity (m/s)",
                    format: { digitSeparator: true, places: 2 }
                  },
                  {
                    fieldName: "arrivalTimeS",
                    label: "Arrival time (s)",
                    format: { digitSeparator: true, places: 1 }
                  },
                  {
                    fieldName: "cellSizeM",
                    label: "Cell size (m)",
                    format: { digitSeparator: true, places: 1 }
                  }
                ]
              }
            ]
          }
        })
      );
    }
  }

  layer.addMany(graphics);
}

export function getDownstreamRasterLegend(
  result: DownstreamShallowWaterResult | null,
  metric: DownstreamRasterMetric
): DownstreamRasterLegend | null {
  if (!result || metric === "off") {
    return null;
  }

  switch (metric) {
    case "depth":
      return {
        title: "Max depth",
        minLabel: "0.03 m",
        maxLabel: `${result.peakDepthM.toFixed(2)} m`,
        gradient: "linear-gradient(90deg, rgb(145,235,255), rgb(25,145,225), rgb(5,45,120))"
      };
    case "velocity":
      return {
        title: "Peak velocity",
        minLabel: "0 m/s",
        maxLabel: `${result.peakVelocityMs.toFixed(2)} m/s`,
        gradient: "linear-gradient(90deg, rgb(255,235,120), rgb(255,145,35), rgb(190,25,25))"
      };
    case "arrival":
      return {
        title: "Arrival time",
        minLabel: "0 s",
        maxLabel: `${result.maxArrivalTimeS.toFixed(1)} s`,
        gradient: "linear-gradient(90deg, rgb(80,55,150), rgb(45,185,185), rgb(245,220,75))"
      };
  }
}
