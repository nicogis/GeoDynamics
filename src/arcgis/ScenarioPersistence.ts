import type { SimulationSettings } from "../config/SimulationSettings";
import type { DownstreamRasterMetric } from "./DownstreamRasterVisualization";

export type DownstreamSolverMode = "reduced" | "swe2d";
export type BasinSource = "automatic" | "manual";

export interface ScenarioPoint {
  x: number;
  y: number;
  z?: number;
}

export interface ScenarioCamera {
  position: ScenarioPoint;
  heading: number;
  tilt: number;
}

export interface GeoDynamicsScenario {
  schema: "geodynamics-scenario";
  version: 1;
  savedAt: string;
  camera: ScenarioCamera;
  settings: SimulationSettings;
  dam: {
    start: ScenarioPoint;
    end: ScenarioPoint;
  } | null;
  basin: {
    seed: ScenarioPoint;
    source: BasinSource;
  } | null;
  downstream: {
    solver: DownstreamSolverMode;
    metric: DownstreamRasterMetric;
    opacity: number;
  };
}

export function downloadScenarioJson(scenario: GeoDynamicsScenario): void {
  const blob = new Blob([JSON.stringify(scenario, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `geodynamics-scenario-${scenario.savedAt.replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is ScenarioPoint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const point = value as Partial<ScenarioPoint>;
  return (
    isFiniteNumber(point.x) &&
    isFiniteNumber(point.y) &&
    (point.z === undefined || isFiniteNumber(point.z))
  );
}

function isSettings(value: unknown): value is SimulationSettings {
  if (!value || typeof value !== "object") {
    return false;
  }
  const s = value as Partial<SimulationSettings>;
  return (
    isFiniteNumber(s.reservoirFreeboard) && s.reservoirFreeboard >= 0 && s.reservoirFreeboard <= 50 &&
    isFiniteNumber(s.maxBasinExtent) && s.maxBasinExtent >= 500 && s.maxBasinExtent <= 8000 &&
    isFiniteNumber(s.targetDemCellSize) && s.targetDemCellSize >= 1 && s.targetDemCellSize <= 25 &&
    isFiniteNumber(s.maxBasinResolution) && [128, 256, 512, 1024].includes(s.maxBasinResolution) &&
    isFiniteNumber(s.rockRadius) && s.rockRadius >= 1 && s.rockRadius <= 50 &&
    isFiniteNumber(s.rockDensity) && s.rockDensity >= 500 && s.rockDensity <= 6000 &&
    isFiniteNumber(s.releaseHeight) && s.releaseHeight >= 0 && s.releaseHeight <= 250 &&
    isFiniteNumber(s.waterDragRate) && s.waterDragRate >= 0 && s.waterDragRate <= 10
  );
}

export async function readScenarioJson(file: File): Promise<GeoDynamicsScenario> {
  const parsed = JSON.parse(await file.text()) as Partial<GeoDynamicsScenario>;
  const camera = parsed.camera;
  const downstream = parsed.downstream;

  const damValid =
    parsed.dam === null ||
    (!!parsed.dam && isPoint(parsed.dam.start) && isPoint(parsed.dam.end));
  const basinValid =
    parsed.basin === null ||
    (!!parsed.basin &&
      isPoint(parsed.basin.seed) &&
      (parsed.basin.source === "automatic" || parsed.basin.source === "manual"));

  if (
    parsed.schema !== "geodynamics-scenario" ||
    parsed.version !== 1 ||
    typeof parsed.savedAt !== "string" ||
    !camera ||
    !isPoint(camera.position) ||
    !isFiniteNumber(camera.heading) ||
    !isFiniteNumber(camera.tilt) ||
    !isSettings(parsed.settings) ||
    !damValid ||
    !basinValid ||
    !downstream ||
    (downstream.solver !== "reduced" && downstream.solver !== "swe2d") ||
    !["depth", "velocity", "arrival", "hazard", "off"].includes(
      downstream.metric as string
    ) ||
    !isFiniteNumber(downstream.opacity) ||
    downstream.opacity < 0.1 ||
    downstream.opacity > 1
  ) {
    throw new Error("Unsupported or invalid GeoDynamics scenario JSON.");
  }

  return parsed as GeoDynamicsScenario;
}
