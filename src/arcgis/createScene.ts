import Map from "@arcgis/core/Map";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import { createRockRenderNode } from "../rendering/RockRenderNode";

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

  view.on("click", (event) => {
    const point = view.toMap({ x: event.x, y: event.y }) as Point | null;
    if (!point) {
      return;
    }

    rockNode.setRock(point);

    if (status) {
      status.textContent =
        `Three.js rock: ${point.latitude?.toFixed(5)}, ${point.longitude?.toFixed(5)}, z ${point.z?.toFixed(1) ?? "n/a"} m`;
    }
  });

  return view;
}
