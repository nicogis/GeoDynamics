import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Map from "@arcgis/core/Map";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import SceneView from "@arcgis/core/views/SceneView";
import SimpleLineSymbol from "@arcgis/core/symbols/SimpleLineSymbol";
import SimpleMarkerSymbol from "@arcgis/core/symbols/SimpleMarkerSymbol";

import { createRockRenderNode } from "../rendering/RockRenderNode";
import { createWaterRenderNode } from "../rendering/WaterRenderNode";
import { RockfallSimulation } from "../simulation/RockfallSimulation";

export async function createScene(container: string): Promise<SceneView> {
  const trajectoryLayer = new GraphicsLayer({
    title: "Rockfall trajectory",
    elevationInfo: {
      mode: "absolute-height"
    }
  });

  const resultLayer = new GraphicsLayer({
    title: "Rockfall results",
    elevationInfo: {
      mode: "absolute-height"
    }
  });

  const map = new Map({
    basemap: "satellite",
    ground: "world-elevation",
    layers: [trajectoryLayer, resultLayer]
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
  const waterNode = createWaterRenderNode(view);
  const status = document.querySelector<HTMLDivElement>("#status");
  const writeStatus = (message: string) => {
    if (status) {
      status.textContent = message;
    }
  };

  let trajectoryGraphic: Graphic | null = null;

  const simulation = new RockfallSimulation(
    view,
    rockNode,
    writeStatus,
    (points, telemetry) => {
      const geometry = new Polyline({
        spatialReference: view.spatialReference,
        paths: [points]
      });

      if (!trajectoryGraphic) {
        trajectoryGraphic = new Graphic({
          geometry,
          symbol: new SimpleLineSymbol({
            width: 3
          }),
          attributes: {
            elapsedSeconds: telemetry.elapsedSeconds,
            totalDistance: telemetry.totalDistance,
            maxSpeed: telemetry.maxSpeed
          }
        });
        trajectoryLayer.add(trajectoryGraphic);
      } else {
        trajectoryGraphic.geometry = geometry;
        trajectoryGraphic.attributes = {
          elapsedSeconds: telemetry.elapsedSeconds,
          totalDistance: telemetry.totalDistance,
          maxSpeed: telemetry.maxSpeed
        };
      }
    },
    (result) => {
      resultLayer.removeAll();

      const energyMj = result.peakKineticEnergyJ / 1_000_000;
      const massTonnes = result.rockMassKg / 1000;

      const markerPoint = result.point.clone();
      markerPoint.z = (markerPoint.z ?? 0) + 18;

      const resultGraphic = new Graphic({
        geometry: markerPoint,
        symbol: new SimpleMarkerSymbol({
          size: 18,
          color: [220, 45, 45, 0.95],
          outline: {
            color: [255, 255, 255, 1],
            width: 2
          }
        }),
        attributes: {
          runoutM: result.horizontalDistance,
          pathM: result.totalDistance,
          elevationDropM: result.elevationDrop,
          maxSpeedMs: result.maxSpeed,
          elapsedSeconds: result.elapsedSeconds,
          rockMassTonnes: massTonnes,
          peakEnergyMj: energyMj,
          endReason: result.reason
        },
        popupTemplate: {
          title: "Rockfall result",
          content: [
            {
              type: "fields",
              fieldInfos: [
                { fieldName: "runoutM", label: "Runout", format: { digitSeparator: true, places: 0 } },
                { fieldName: "pathM", label: "Path length", format: { digitSeparator: true, places: 0 } },
                { fieldName: "elevationDropM", label: "Elevation drop", format: { digitSeparator: true, places: 0 } },
                { fieldName: "maxSpeedMs", label: "Max speed (m/s)", format: { digitSeparator: true, places: 1 } },
                { fieldName: "elapsedSeconds", label: "Simulation time (s)", format: { digitSeparator: true, places: 1 } },
                { fieldName: "rockMassTonnes", label: "Rock mass (t)", format: { digitSeparator: true, places: 0 } },
                { fieldName: "peakEnergyMj", label: "Peak kinetic energy (MJ)", format: { digitSeparator: true, places: 1 } },
                { fieldName: "endReason", label: "End condition" }
              ]
            }
          ]
        }
      });

      resultLayer.add(resultGraphic);
    },
    {
      getSurface: () => waterNode.getSurface(),
      addImpact: (point, speed) => waterNode.addImpact(point, speed)
    }
  );

  view.on("click", (event) => {
    void (async () => {
      const hit = await view.hitTest(event);

      const resultHit = hit.results.some(
        (item) =>
          item.type === "graphic" &&
          item.graphic.layer === resultLayer
      );

      if (resultHit) {
        return;
      }

      const point = view.toMap({ x: event.x, y: event.y }) as Point | null;
      if (!point) {
        return;
      }

      if (event.native.shiftKey) {
        waterNode.setWater(point, 420);
        writeStatus(
          `Water basin set — z ${(point.z ?? 0).toFixed(1)} m. Click normally to release the rock.`
        );
        return;
      }

      trajectoryLayer.removeAll();
      resultLayer.removeAll();
      trajectoryGraphic = null;

      await simulation.release(point);
    })().catch((error: unknown) => {
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
