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

export async function readScenarioJson(file: File): Promise<GeoDynamicsScenario> {
  const parsed = JSON.parse(await file.text()) as Partial<GeoDynamicsScenario>;

  if (
    parsed.schema !== "geodynamics-scenario" ||
    parsed.version !== 1 ||
    !parsed.camera ||
    !parsed.settings ||
    !parsed.downstream
  ) {
    throw new Error("Unsupported or invalid GeoDynamics scenario JSON.");
  }

  return parsed as GeoDynamicsScenario;
}
