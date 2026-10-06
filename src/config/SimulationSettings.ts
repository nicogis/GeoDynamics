export interface SimulationSettings {
  reservoirFreeboard: number;
  maxBasinExtent: number;
  targetDemCellSize: number;
  maxBasinResolution: number;
  rockRadius: number;
  rockDensity: number;
  releaseHeight: number;
  waterDragRate: number;
}

export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  reservoirFreeboard: 0.5,
  maxBasinExtent: 4000,
  targetDemCellSize: 5,
  maxBasinResolution: 1024,
  rockRadius: 9,
  rockDensity: 2600,
  releaseHeight: 30,
  waterDragRate: 1.15
};

export function createSimulationSettings(): SimulationSettings {
  return { ...DEFAULT_SIMULATION_SETTINGS };
}
