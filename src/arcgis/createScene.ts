import Map from "@arcgis/core/Map";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import { createRockRenderNode } from "../rendering/RockRenderNode";
import { RockfallSimulation } from "../simulation/RockfallSimulation";

export async function createScene(container: string): Promise<SceneView> {
  const map = new Map({
    basemap: "satellite",
    ground: "world-elevation"
  });

  const view = new SceneView({
    container,
    map,
    qualityProfile: "high",
    camera: {
      position: {
        longitude: 9.95,
        latitude: 46.02,
        z: 5500
      },
      tilt: 72,
      heading: 0
    },
    environment: {
      atmosphereEnabled: true,
      starsEnabled: true
    }
  });

  await view.when();

  const rockNode = createRockRenderNode(view);
  const status = document.querySelector<HTMLDivElement>("#status");
  const writeStatus = (message: string) => {
    if (status) {
      status.textContent = message;
    }
  };

  const simulation = new RockfallSimulation(view, rockNode, writeStatus);

  view.on("click", (event) => {
    const point = view.toMap({ x: event.x, y: event.y }) as Point | null;
    if (!point) {
      return;
    }

    void simulation.release(point).catch((error: unknown) => {
      console.error("Rockfall simulation failed:", error);

      writeStatus(
        error instanceof Error
          ? `Simulation error: ${error.message}`
          : "Simulation error. See the browser console for details."
      );
    });
  });

  return view;
}
