import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Map from "@arcgis/core/Map";
import Point from "@arcgis/core/geometry/Point";
import Polygon from "@arcgis/core/geometry/Polygon";
import Polyline from "@arcgis/core/geometry/Polyline";
import SceneView from "@arcgis/core/views/SceneView";
import PolygonSymbol3D from "@arcgis/core/symbols/PolygonSymbol3D";
import FillSymbol3DLayer from "@arcgis/core/symbols/FillSymbol3DLayer";
import SimpleLineSymbol from "@arcgis/core/symbols/SimpleLineSymbol";
import SimpleMarkerSymbol from "@arcgis/core/symbols/SimpleMarkerSymbol";

import {
  findAutomaticBasinSeed,
  resolveDamEndAtCrest,
  sampleWaterBasin,
  type DamBarrier
} from "../physics/WaterBasin";
import { createRockRenderNode } from "../rendering/RockRenderNode";
import { createWaterRenderNode } from "../rendering/WaterRenderNode";
import { RockfallSimulation } from "../simulation/RockfallSimulation";
import { createSimulationSettings } from "../config/SimulationSettings";

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

  const damGroundPreviewLayer = new GraphicsLayer({
    title: "Dam ground projection",
    elevationInfo: {
      mode: "on-the-ground"
    }
  });

  const damLayer = new GraphicsLayer({
    title: "Dam barrier",
    elevationInfo: {
      mode: "absolute-height"
    }
  });

  const damFaceLayer = new GraphicsLayer({
    title: "Dam face",
    elevationInfo: {
      mode: "absolute-height"
    }
  });

  const map = new Map({
    basemap: "satellite",
    ground: "world-elevation",
    layers: [
      trajectoryLayer,
      resultLayer,
      damGroundPreviewLayer,
      damFaceLayer,
      damLayer
    ]
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
  const settings = createSimulationSettings();
  rockNode.setRadius(settings.rockRadius);

  const status = document.querySelector<HTMLDivElement>("#status");
  const help = document.querySelector<HTMLDivElement>("#help");
  const writeStatus = (
    message: string,
    kind: "normal" | "error" = "normal"
  ) => {
    if (status) {
      status.textContent = message;
      status.style.color = kind === "error" ? "#d32f2f" : "";
      status.style.fontWeight = kind === "error" ? "700" : "";
    }
  };

  let trajectoryGraphic: Graphic | null = null;
  let damStart: Point | null = null;
  let damBarrier: DamBarrier | null = null;
  let damPreviewGraphic: Graphic | null = null;
  let damGroundPreviewGraphic: Graphic | null = null;
  let damWaterLevelGraphic: Graphic | null = null;
  let basinRequestId = 0;

  const writeHelp = (message: string) => {
    if (help) {
      help.textContent = message;
    }
  };

  const applyBasin = async (
    seed: Point,
    source: "automatic" | "manual"
  ) => {
    if (!damBarrier) {
      return;
    }

    const requestId = ++basinRequestId;
    writeStatus(
      source === "automatic"
        ? "Detecting upstream reservoir..."
        : "Sampling reservoir behind dam barrier..."
    );

    const basin = await sampleWaterBasin(
      view,
      seed,
      damBarrier,
      settings
    );

    if (requestId !== basinRequestId) {
      return;
    }

    waterNode.setBasin(
      basin.center,
      basin.size,
      basin.waterElevation,
      basin.mask,
      basin.resolution
    );

    const crestElevation = basin.damCrestElevation;
    const profile = basin.damProfilePoints;

    if (profile.length >= 2) {
      const ring: number[][] = [];

      for (const pointOnTerrain of profile) {
        ring.push([
          pointOnTerrain[0],
          pointOnTerrain[1],
          crestElevation
        ]);
      }

      for (let i = profile.length - 1; i >= 0; i -= 1) {
        const pointOnTerrain = profile[i];
        ring.push([
          pointOnTerrain[0],
          pointOnTerrain[1],
          pointOnTerrain[2]
        ]);
      }

      ring.push(ring[0]);

      damFaceLayer.removeAll();
      damFaceLayer.add(
        new Graphic({
          geometry: new Polygon({
            spatialReference: view.spatialReference,
            rings: [ring]
          }),
          symbol: new PolygonSymbol3D({
            symbolLayers: [
              new FillSymbol3DLayer({
                material: {
                  color: [120, 105, 90, 0.88]
                }
              })
            ]
          })
        })
      );

      const waterLevelLine = new Polyline({
        spatialReference: view.spatialReference,
        paths: [[
          basin.waterLevelStart,
          basin.waterLevelEnd
        ]]
      });

      if (!damWaterLevelGraphic) {
        damWaterLevelGraphic = new Graphic({
          geometry: waterLevelLine,
          symbol: new SimpleLineSymbol({
            color: [80, 220, 255, 1],
            width: 4
          })
        });
        damLayer.add(damWaterLevelGraphic);
      } else {
        damWaterLevelGraphic.geometry = waterLevelLine;
      }
    }

    const areaHa = basin.areaM2 / 10_000;
    const volumeHm3 = basin.volumeM3 / 1_000_000;

    writeStatus(
      `Reservoir generated${source === "automatic" ? " automatically" : ""} — level ${basin.waterElevation.toFixed(1)} m · crest ${basin.damCrestElevation.toFixed(1)} m · max dam height ${basin.maxDamHeight.toFixed(1)} m · dam ${basin.damLength.toFixed(0)} m · grid ${basin.resolution}×${basin.resolution} · ${basin.cellSize.toFixed(1)} m/cell · area ${areaHa.toFixed(1)} ha · volume ${volumeHm3.toFixed(3)} hm³. Click normally to release the rock.`
    );

    writeHelp(
      "Ctrl+click twice to draw a new dam. The reservoir is generated automatically when the upstream side can be detected. Shift+click upstream only as a manual fallback."
    );
  };

  const bindNumberSetting = (
    id: string,
    key: keyof typeof settings,
    min: number,
    max: number
  ) => {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) {
      return;
    }

    input.value = String(settings[key]);

    const update = () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        input.value = String(settings[key]);
        return;
      }

      const value = Math.min(Math.max(parsed, min), max);
      input.value = String(value);
      settings[key] = value;

      if (key === "rockRadius") {
        rockNode.setRadius(value);
      }

      writeHelp(
        "Parameters updated. Basin settings apply to the next reservoir generation; rockfall settings apply to the next release."
      );
    };

    input.addEventListener("change", update);
  };

  const bindResolutionSetting = () => {
    const input = document.querySelector<HTMLSelectElement>(
      "#maxBasinResolution"
    );
    if (!input) {
      return;
    }

    input.value = String(settings.maxBasinResolution);
    input.addEventListener("change", () => {
      settings.maxBasinResolution = Number(input.value);
      writeHelp(
        "Parameters updated. Basin settings apply to the next reservoir generation."
      );
    });
  };

  bindNumberSetting("reservoirFreeboard", "reservoirFreeboard", 0, 50);
  bindNumberSetting("maxBasinExtent", "maxBasinExtent", 500, 8000);
  bindNumberSetting("targetDemCellSize", "targetDemCellSize", 1, 25);
  bindNumberSetting("rockRadius", "rockRadius", 1, 50);
  bindNumberSetting("rockDensity", "rockDensity", 500, 6000);
  bindNumberSetting("releaseHeight", "releaseHeight", 0, 250);
  bindNumberSetting("waterDragRate", "waterDragRate", 0, 10);
  bindResolutionSetting();

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
      containsPoint: (point) => waterNode.containsPoint(point),
      addImpact: (point, speed) => waterNode.addImpact(point, speed)
    },
    settings
  );

  view.on("pointer-move", (event) => {
    if (!damStart) {
      return;
    }

    const point = view.toMap({ x: event.x, y: event.y }) as Point | null;
    if (!point) {
      return;
    }

    const crestElevation = damStart.z ?? point.z ?? 0;

    const crestPreview = new Polyline({
      spatialReference: view.spatialReference,
      paths: [[
        [damStart.x, damStart.y, crestElevation],
        [point.x, point.y, crestElevation]
      ]]
    });

    const groundPreview = new Polyline({
      spatialReference: view.spatialReference,
      paths: [[
        [damStart.x, damStart.y],
        [point.x, point.y]
      ]]
    });

    if (!damPreviewGraphic) {
      damPreviewGraphic = new Graphic({
        geometry: crestPreview,
        symbol: new SimpleLineSymbol({
          color: [255, 170, 0, 0.9],
          width: 4
        })
      });
      damLayer.add(damPreviewGraphic);
    } else {
      damPreviewGraphic.geometry = crestPreview;
    }

    if (!damGroundPreviewGraphic) {
      damGroundPreviewGraphic = new Graphic({
        geometry: groundPreview,
        symbol: new SimpleLineSymbol({
          color: [255, 255, 255, 0.75],
          width: 2,
          style: "dash"
        })
      });
      damGroundPreviewLayer.add(damGroundPreviewGraphic);
    } else {
      damGroundPreviewGraphic.geometry = groundPreview;
    }
  });

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

      if (event.native.ctrlKey) {
        if (!damStart) {
          damStart = point.clone();
          damBarrier = null;
          damLayer.removeAll();
          damGroundPreviewLayer.removeAll();
          damFaceLayer.removeAll();
          damWaterLevelGraphic = null;
          damPreviewGraphic = null;
          damGroundPreviewGraphic = null;

          damLayer.add(
            new Graphic({
              geometry: damStart,
              symbol: new SimpleMarkerSymbol({
                size: 12,
                color: [255, 170, 0, 0.95],
                outline: {
                  color: [255, 255, 255, 1],
                  width: 1.5
                }
              })
            })
          );

          writeStatus(
            "Dam start set. Ctrl+click the opposite valley side to close the barrier."
          );
          return;
        }

        const lockedEnd = await resolveDamEndAtCrest(
          view,
          damStart,
          point
        );

        damBarrier = {
          start: damStart.clone(),
          end: lockedEnd
        };
        damBarrier.start.z = damStart.z ?? lockedEnd.z ?? 0;

        const damLine = new Polyline({
          spatialReference: view.spatialReference,
          paths: [[
            [damBarrier.start.x, damBarrier.start.y, damBarrier.start.z ?? 0],
            [damBarrier.end.x, damBarrier.end.y, damBarrier.end.z ?? 0]
          ]]
        });

        damLayer.removeAll();
        damGroundPreviewLayer.removeAll();
        damPreviewGraphic = null;
        damGroundPreviewGraphic = null;
        damLayer.add(
          new Graphic({
            geometry: damLine,
            symbol: new SimpleLineSymbol({
              color: [255, 170, 0, 0.95],
              width: 5
            })
          })
        );

        damStart = null;

        const damLength = Math.hypot(
          damBarrier.end.x - damBarrier.start.x,
          damBarrier.end.y - damBarrier.start.y
        );

        writeStatus(
          `Dam barrier set — ${damLength.toFixed(0)} m. Detecting upstream side...`
        );
        writeHelp(
          "GeoDynamics is trying to determine the upstream side and generate the reservoir automatically."
        );

        const automaticSeed = await findAutomaticBasinSeed(
          view,
          damBarrier,
          settings
        );

        if (automaticSeed) {
          try {
            await applyBasin(automaticSeed, "automatic");
          } catch (error: unknown) {
            console.warn("Automatic reservoir generation failed:", error);
            writeStatus(
              "Automatic reservoir detection was inconclusive. Shift+click a point in the upstream reservoir area.",
              "error"
            );
            writeHelp(
              "Shift+click a low point behind the dam to indicate the upstream reservoir area."
            );
          }
        } else {
          writeStatus(
            "Unable to determine the upstream side automatically. Shift+click a point in the upstream reservoir area.",
            "error"
          );
          writeHelp(
            "Shift+click a low point behind the dam to indicate the upstream reservoir area."
          );
        }
        return;
      }

      if (event.native.shiftKey) {
        if (!damBarrier) {
          writeStatus(
            "Define the dam first: Ctrl+click the two opposite valley sides.",
            "error"
          );
          writeHelp(
            "Ctrl+click the first side of the valley, then Ctrl+click the opposite side."
          );
          return;
        }

        await applyBasin(point, "manual");
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
          : "Simulation error. See the browser console for details.",
        "error"
      );
    });
  });

  return view;
}
