import Map from "@arcgis/core/Map";
import SceneView from "@arcgis/core/views/SceneView";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";

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

  const status = document.querySelector<HTMLDivElement>("#status");

  view.on("click", async (event) => {
    const point = view.toMap({ x: event.x, y: event.y }) as Point | null;
    if (!point) return;

    view.graphics.removeAll();
    view.graphics.add(new Graphic({
      geometry: point,
      symbol: {
        type: "point-3d",
        symbolLayers: [{
          type: "object",
          resource: { primitive: "sphere" },
          material: { color: "#ff6b35" },
          width: 18,
          height: 18,
          depth: 18
        }]
      } as __esri.PointSymbol3DProperties
    }));

    if (status) {
      status.textContent =
        `Release point: ${point.latitude?.toFixed(5)}, ${point.longitude?.toFixed(5)} — physics coming next.`;
    }
  });

  return view;
}
