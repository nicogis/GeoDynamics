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
import {
  buildDownstreamInundationSurface,
  traceDownstreamFlow
} from "../physics/DownstreamInundation";
import {
  simulateDownstreamShallowWater,
  type DownstreamShallowWaterResult
} from "../physics/DownstreamShallowWater";
import {
  getDownstreamRasterLegend,
  renderDownstreamRaster,
  type DownstreamRasterMetric
} from "./DownstreamRasterVisualization";

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

  const downstreamLayer = new GraphicsLayer({
    title: "Downstream inundation path",
    elevationInfo: {
      mode: "absolute-height"
    }
  });

  const downstreamRasterLayer = new GraphicsLayer({
    title: "Downstream hydraulic raster",
    elevationInfo: {
      mode: "on-the-ground"
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
      damLayer,
      downstreamLayer,
      downstreamRasterLayer
    ]
  });

  const view = new SceneView({
    container,
    map,
    qualityProfile: "high",
    camera: {
      position: {
        longitude: 10.091749988193236,
        latitude: 46.00360512569807,
        z: 5045.430256512016
      },
      tilt: 74.91662881403597,
      heading: 319.8271406668986
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
  const overtopping = document.querySelector<HTMLDivElement>("#overtopping");
  const downstream = document.querySelector<HTMLDivElement>("#downstream");
  const downstreamRasterMetric = document.querySelector<HTMLSelectElement>(
    "#downstreamRasterMetric"
  );
  const downstreamRasterOpacity = document.querySelector<HTMLInputElement>(
    "#downstreamRasterOpacity"
  );
  const downstreamLegend = document.querySelector<HTMLDivElement>(
    "#downstreamLegend"
  );
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
  let lastDamProfilePoints: number[][] | null = null;
  let lastDamCrestElevation: number | null = null;
  let basinRequestId = 0;
  let downstreamTraceGeneration = 0;
  let downstreamTraceStarted = false;
  let overtoppingPeakHeight = 0;
  let overtoppingPeakSourceT: number | null = null;
  let overtoppingPeakWidthFraction = 0;
  let overtoppingPeakLastIncreaseAt = 0;
  let overtoppingEventActive = false;
  let lastBasinSeed: Point | null = null;
  let lastBasinSource: "automatic" | "manual" | null = null;
  let basinRegenerationTimer: number | null = null;
  let lastDownstreamRaster: DownstreamShallowWaterResult | null = null;
  let rasterMetric: DownstreamRasterMetric = "depth";
  let rasterOpacity = 0.65;

  const writeHelp = (message: string) => {
    if (help) {
      help.textContent = message;
    }
  };


  const refreshDownstreamPresentation = () => {
    const rasterActive =
      rasterMetric !== "off" && lastDownstreamRaster !== null;

    for (const graphic of downstreamLayer.graphics.toArray()) {
      const geometryType = graphic.geometry?.type;

      if (geometryType === "polyline") {
        graphic.symbol = new SimpleLineSymbol({
          color: rasterActive
            ? [0, 225, 255, 0.55]
            : [0, 225, 255, 0.95],
          width: rasterActive ? 1.25 : 4
        });
        graphic.visible = true;
      } else if (geometryType === "polygon") {
        graphic.visible = !rasterActive;
        if (!rasterActive) {
          graphic.symbol = new PolygonSymbol3D({
            symbolLayers: [
              new FillSymbol3DLayer({
                material: {
                  color: [0, 170, 235, 0.46]
                },
                outline: {
                  color: [70, 220, 255, 0.95],
                  size: 1.5
                }
              })
            ]
          });
        }
      }
    }
  };

  const refreshDownstreamRaster = () => {
    renderDownstreamRaster(
      downstreamRasterLayer,
      lastDownstreamRaster,
      rasterMetric,
      rasterOpacity
    );
    refreshDownstreamPresentation();

    if (!downstreamLegend) {
      return;
    }

    const legend = getDownstreamRasterLegend(
      lastDownstreamRaster,
      rasterMetric
    );

    if (!legend) {
      downstreamLegend.dataset.visible = "false";
      downstreamLegend.innerHTML = "";
      return;
    }

    downstreamLegend.dataset.visible = "true";
    downstreamLegend.innerHTML =
      `<strong>${legend.title}</strong>` +
      `<div class="raster-legend-bar" style="background:${legend.gradient}"></div>` +
      `<div class="raster-legend-labels"><span>${legend.minLabel}</span><span>${legend.maxLabel}</span></div>`;
  };

  if (downstreamRasterMetric) {
    downstreamRasterMetric.value = rasterMetric;
    downstreamRasterMetric.addEventListener("change", () => {
      rasterMetric =
        downstreamRasterMetric.value as DownstreamRasterMetric;
      refreshDownstreamRaster();
    });
  }

  if (downstreamRasterOpacity) {
    downstreamRasterOpacity.value = String(rasterOpacity);
    downstreamRasterOpacity.addEventListener("change", () => {
      const parsed = Number(downstreamRasterOpacity.value);
      rasterOpacity = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 0.1), 1)
        : 0.65;
      downstreamRasterOpacity.value = String(rasterOpacity);
      refreshDownstreamRaster();
    });
  }

  const applyBasin = async (
    seed: Point,
    source: "automatic" | "manual"
  ) => {
    if (!damBarrier) {
      return;
    }

    lastBasinSeed = seed.clone();
    lastBasinSource = source;

    const requestId = ++basinRequestId;
    downstreamTraceGeneration += 1;
    downstreamTraceStarted = false;
    overtoppingPeakHeight = 0;
    overtoppingPeakSourceT = null;
    overtoppingPeakWidthFraction = 0;
    overtoppingPeakLastIncreaseAt = 0;
    overtoppingEventActive = false;
    downstreamLayer.removeAll();
    downstreamRasterLayer.removeAll();
    lastDownstreamRaster = null;
    refreshDownstreamRaster();
    view.closePopup();
    writeStatus(
      source === "automatic"
        ? "Detecting upstream reservoir..."
        : "Sampling reservoir behind dam barrier..."
    );

    const basin = await sampleWaterBasin(
      view,
      seed,
      damBarrier,
      settings,
      { trustSeedSide: source === "manual" }
    );

    if (requestId !== basinRequestId) {
      return;
    }

    lastDamProfilePoints = basin.damProfilePoints.map((point) => [...point]);
    lastDamCrestElevation = basin.damCrestElevation;

    waterNode.setBasin(
      basin.center,
      basin.size,
      basin.waterElevation,
      basin.mask,
      basin.depth,
      basin.resolution
    );

    downstreamTraceStarted = false;
    downstreamLayer.removeAll();
    if (downstream) {
      downstream.textContent = "Downstream: waiting for overtopping.";
      downstream.dataset.state = "waiting";
    }

    waterNode.setDamMonitor(
      damBarrier.start,
      damBarrier.end,
      basin.damCrestElevation,
      (state) => {
        if (!overtopping) {
          return;
        }

        const margin = state.freeboard - state.maxWaveHeight;
        overtopping.textContent = state.overtopping
          ? `OVERTOPPING — wave +${state.maxWaveHeight.toFixed(2)} m exceeds freeboard ${state.freeboard.toFixed(2)} m by ${Math.abs(margin).toFixed(2)} m.`
          : `Dam wave monitor — max wave +${state.maxWaveHeight.toFixed(2)} m · freeboard ${state.freeboard.toFixed(2)} m · margin ${Math.max(margin, 0).toFixed(2)} m.`;
        overtopping.dataset.state = state.overtopping ? "alert" : "normal";

        const now = performance.now();

        if (
          !downstreamTraceStarted &&
          state.sourceT !== null &&
          state.overtopping
        ) {
          if (!overtoppingEventActive) {
            overtoppingEventActive = true;
            overtoppingPeakHeight = state.maxWaveHeight;
            overtoppingPeakSourceT = state.sourceT;
            overtoppingPeakWidthFraction =
              state.overtoppingWidthFraction;
            overtoppingPeakLastIncreaseAt = now;
          } else if (state.maxWaveHeight > overtoppingPeakHeight + 0.002) {
            overtoppingPeakHeight = state.maxWaveHeight;
            overtoppingPeakSourceT = state.sourceT;
            overtoppingPeakWidthFraction =
              state.overtoppingWidthFraction;
            overtoppingPeakLastIncreaseAt = now;
          }
        }

        const peakStable =
          overtoppingEventActive &&
          now - overtoppingPeakLastIncreaseAt >= 1000;

        if (
          overtoppingEventActive &&
          !downstreamTraceStarted &&
          damBarrier &&
          !peakStable &&
          downstream
        ) {
          const measuredHead = Math.max(
            overtoppingPeakHeight - state.freeboard,
            0
          );
          const measuredWidth = damBarrier
            ? Math.hypot(
                damBarrier.end.x - damBarrier.start.x,
                damBarrier.end.y - damBarrier.start.y
              ) * overtoppingPeakWidthFraction
            : 0;
          downstream.textContent =
            `Downstream: measuring overtopping peak — head ${measuredHead.toFixed(2)} m · crest width ${measuredWidth.toFixed(0)} m...`;
          downstream.dataset.state = "active";
        }

        if (
          overtoppingEventActive &&
          peakStable &&
          overtoppingPeakSourceT !== null &&
          !downstreamTraceStarted &&
          damBarrier
        ) {
          downstreamTraceStarted = true;
          const traceGeneration = ++downstreamTraceGeneration;
          if (downstream) {
            downstream.textContent = "Downstream: tracing overtopping flow...";
            downstream.dataset.state = "active";
          }

          const source = new Point({
            x:
              damBarrier.start.x +
              (damBarrier.end.x - damBarrier.start.x) * overtoppingPeakSourceT,
            y:
              damBarrier.start.y +
              (damBarrier.end.y - damBarrier.start.y) * overtoppingPeakSourceT,
            z: basin.damCrestElevation,
            spatialReference: damBarrier.start.spatialReference
          });

          void traceDownstreamFlow(
            view,
            damBarrier,
            basin.center,
            source
          )
            .then(async (flow) => {
              if (traceGeneration !== downstreamTraceGeneration) {
                return;
              }

              // Render the terrain-aware centerline immediately. Surface
              // construction is a second-stage operation and must not hide
              // the valid downstream trace when a cross-section fails.
              downstreamLayer.removeAll();
              downstreamLayer.add(
                new Graphic({
                  geometry: new Polyline({
                    spatialReference: view.spatialReference,
                    paths: [flow.points]
                  }),
                  symbol: new SimpleLineSymbol({
                    color: [0, 225, 255, 0.95],
                    width: 4
                  }),
                  attributes: {
                    lengthM: flow.lengthM,
                    elevationDropM: flow.elevationDropM
                  }
                })
              );
              refreshDownstreamPresentation();

              if (downstream) {
                downstream.textContent = `Downstream: path traced — ${flow.lengthM.toFixed(0)} m. Building inundation surface...`;
                downstream.dataset.state = "active";
              }

              const overtoppingHead = Math.max(
                overtoppingPeakHeight - state.freeboard,
                0
              );

              try {
                const surface = await buildDownstreamInundationSurface(
                  view,
                  flow,
                  overtoppingHead
                );

                if (traceGeneration !== downstreamTraceGeneration) {
                  return;
                }

                if (downstream) {
                  downstream.textContent =
                    "Downstream: running shallow-water raster foundation...";
                }

                let shallowWater:
                  | Awaited<ReturnType<typeof simulateDownstreamShallowWater>>
                  | null = null;

                try {
                  const activeDam = damBarrier;
                  if (!activeDam) {
                    throw new Error(
                      "Dam barrier is no longer available for downstream simulation."
                    );
                  }

                  const damLengthM = Math.hypot(
                    activeDam.end.x - activeDam.start.x,
                    activeDam.end.y - activeDam.start.y
                  );
                  const measuredOverflowWidthM =
                    overtoppingPeakWidthFraction > 0
                      ? damLengthM * overtoppingPeakWidthFraction
                      : undefined;
                  shallowWater = await simulateDownstreamShallowWater(
                    view,
                    flow,
                    overtoppingHead,
                    measuredOverflowWidthM
                  );
                  lastDownstreamRaster = shallowWater;
                  refreshDownstreamRaster();
                } catch (solverError: unknown) {
                  console.warn(
                    "Downstream shallow-water raster simulation failed:",
                    solverError
                  );
                }

                if (traceGeneration !== downstreamTraceGeneration) {
                  return;
                }

                if (
                  surface.ring.length >= 4 &&
                  surface.areaM2 > 1 &&
                  surface.maxWidthM > 0
                ) {
                  downstreamLayer.add(
                    new Graphic({
                      geometry: new Polygon({
                        spatialReference: view.spatialReference,
                        rings: [surface.ring]
                      }),
                      symbol: new PolygonSymbol3D({
                        symbolLayers: [
                          new FillSymbol3DLayer({
                            material: {
                              color: [0, 170, 235, 0.46]
                            },
                            outline: {
                              color: [70, 220, 255, 0.95],
                              size: 1.5
                            }
                          })
                        ]
                      }),
                      attributes: {
                        areaM2: surface.areaM2,
                        maxWidthM: surface.maxWidthM,
                        sourceStageM: surface.sourceStageM,
                        rasterWetAreaM2: shallowWater?.wetAreaM2 ?? null,
                        solverOvertoppingHeadM: shallowWater?.overtoppingHeadM ?? null,
                        sourceDepthM: shallowWater?.sourceDepthM ?? null,
                        peakDischargeM3s: shallowWater?.peakDischargeM3s ?? null,
                        effectiveOverflowWidthM: shallowWater?.effectiveOverflowWidthM ?? null,
                        manningN: shallowWater?.manningN ?? null,
                        hydrographDurationS: shallowWater?.hydrographDurationS ?? null,
                        inputVolumeM3: shallowWater?.inputVolumeM3 ?? null,
                        storedVolumeM3: shallowWater?.storedVolumeM3 ?? null,
                        outflowVolumeM3: shallowWater?.outflowVolumeM3 ?? null,
                        massBalanceErrorPct: shallowWater?.massBalanceErrorPct ?? null,
                        peakDepthM: shallowWater?.peakDepthM ?? null,
                        peakVelocityMs: shallowWater?.peakVelocityMs ?? null,
                        maxArrivalTimeS: shallowWater?.maxArrivalTimeS ?? null,
                        simulatedDurationS: shallowWater?.simulatedDurationS ?? null,
                        frontDistanceM: shallowWater?.frontDistanceM ?? null,
                        frontSpeedMs: shallowWater?.frontSpeedMs ?? null,
                        simulationBlocks: shallowWater?.simulationBlocks ?? null,
                        domainExpansionCount: shallowWater?.domainExpansionCount ?? null,
                        domainMarginM: shallowWater?.domainMarginM ?? null,
                        solverStopReason: shallowWater?.stopReason ?? null,
                        frontStillAdvancing: shallowWater?.frontStillAdvancing ?? null,
                        rasterCellSizeM: shallowWater?.cellSize ?? null
                      },
                      popupTemplate: {
                        title: "Downstream inundation surface",
                        content: [
                          {
                            type: "fields",
                            fieldInfos: [
                              {
                                fieldName: "areaM2",
                                label: "Inundated area (m²)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "maxWidthM",
                                label: "Maximum width (m)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "sourceStageM",
                                label: "Source hydraulic stage (m)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "rasterWetAreaM2",
                                label: "Raster wet area (m²)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "solverOvertoppingHeadM",
                                label: "Solver overtopping head (m)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "sourceDepthM",
                                label: "Source depth (m)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "peakDischargeM3s",
                                label: "Peak discharge (m³/s)",
                                format: { digitSeparator: true, places: 1 }
                              },
                              {
                                fieldName: "effectiveOverflowWidthM",
                                label: "Measured overflow width (m)",
                                format: { digitSeparator: true, places: 1 }
                              },
                              {
                                fieldName: "manningN",
                                label: "Manning n",
                                format: { digitSeparator: true, places: 3 }
                              },
                              {
                                fieldName: "hydrographDurationS",
                                label: "Hydrograph duration (s)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "domainExpansionCount",
                                label: "Domain expansions",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "domainMarginM",
                                label: "Final domain margin (m)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "inputVolumeM3",
                                label: "Input volume (m³)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "storedVolumeM3",
                                label: "Stored volume (m³)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "outflowVolumeM3",
                                label: "Outflow volume (m³)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "massBalanceErrorPct",
                                label: "Mass balance error (%)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "peakDepthM",
                                label: "Max downstream depth (m)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "peakVelocityMs",
                                label: "Raster peak velocity (m/s)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "maxArrivalTimeS",
                                label: "Latest arrival time (s)",
                                format: { digitSeparator: true, places: 1 }
                              },
                              {
                                fieldName: "simulatedDurationS",
                                label: "Simulated duration (s)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "frontDistanceM",
                                label: "Front distance (m)",
                                format: { digitSeparator: true, places: 0 }
                              },
                              {
                                fieldName: "frontSpeedMs",
                                label: "Front speed (m/s)",
                                format: { digitSeparator: true, places: 2 }
                              },
                              {
                                fieldName: "simulationBlocks",
                                label: "Simulation blocks"
                              },
                              {
                                fieldName: "solverStopReason",
                                label: "Solver stop reason"
                              },
                              {
                                fieldName: "frontStillAdvancing",
                                label: "Front still advancing"
                              },
                              {
                                fieldName: "rasterCellSizeM",
                                label: "Raster cell size (m)",
                                format: { digitSeparator: true, places: 1 }
                              }
                            ]
                          }
                        ]
                      }
                    })
                  );
                  refreshDownstreamPresentation();

                  if (shallowWater) {
                    writeHelp(
                      `Downstream raster foundation — wet ${(shallowWater.wetAreaM2 / 10_000).toFixed(2)} ha · solver head ${shallowWater.overtoppingHeadM.toFixed(2)} m · Qpeak ${shallowWater.peakDischargeM3s.toFixed(1)} m³/s · input ${shallowWater.inputVolumeM3.toFixed(0)} m³ · stored ${shallowWater.storedVolumeM3.toFixed(0)} m³ · out ${shallowWater.outflowVolumeM3.toFixed(0)} m³ · mass error ${shallowWater.massBalanceErrorPct.toFixed(2)}% · max downstream depth ${shallowWater.peakDepthM.toFixed(2)} m · peak velocity ${shallowWater.peakVelocityMs.toFixed(2)} m/s · latest arrival ${shallowWater.maxArrivalTimeS.toFixed(1)} s · simulated ${shallowWater.simulatedDurationS.toFixed(0)} s / ${shallowWater.simulationBlocks} blocks · front ${shallowWater.frontDistanceM.toFixed(0)} m @ ${shallowWater.frontSpeedMs.toFixed(2)} m/s · ${shallowWater.stopReason}${shallowWater.frontStillAdvancing ? " · front still advancing" : ""} · cell ${shallowWater.cellSize.toFixed(1)} m.`
                    );
                  } else {
                    writeHelp(
                      `Downstream inundation surface generated — ${(surface.areaM2 / 10_000).toFixed(2)} ha · max width ${surface.maxWidthM.toFixed(0)} m · source stage ${surface.sourceStageM.toFixed(2)} m · path ${flow.lengthM.toFixed(0)} m. Raster solver unavailable for this run.`
                    );
                  }
                  if (downstream) {
                    const thinSheetFlow =
                      shallowWater !== null &&
                      shallowWater.peakDepthM <= 0.15;
                    downstream.textContent = shallowWater
                      ? `Downstream: raster ready — ${shallowWater.resolutionX}×${shallowWater.resolutionY} · wet ${(shallowWater.wetAreaM2 / 10_000).toFixed(2)} ha · overflow ${shallowWater.effectiveOverflowWidthM.toFixed(0)} m · Manning ${shallowWater.manningN.toFixed(3)} · hydrograph ${shallowWater.hydrographDurationS.toFixed(0)} s · domain +${shallowWater.domainExpansionCount} (${shallowWater.domainMarginM.toFixed(0)} m) · ${shallowWater.stopReason}${shallowWater.frontStillAdvancing ? " / front advancing" : ""}${thinSheetFlow ? " · thin sheet flow (< 0.15 m peak); display extends to 0.01 m." : ""}.`
                      : `Downstream: surface ready — ${(surface.areaM2 / 10_000).toFixed(2)} ha · raster solver failed.`;
                    downstream.dataset.state = shallowWater ? "active" : "error";
                  }
                } else {
                  writeHelp(
                    `Downstream path generated (${flow.lengthM.toFixed(0)} m), but the first inundation envelope is too narrow to render reliably.`
                  );
                  if (downstream) {
                    downstream.textContent =
                      "Downstream: path ready, inundation surface too narrow.";
                    downstream.dataset.state = "error";
                  }
                }
              } catch (surfaceError: unknown) {
                console.warn(
                  "Downstream inundation surface generation failed:",
                  surfaceError
                );
                writeHelp(
                  surfaceError instanceof Error
                    ? `Downstream path generated, but inundation surface failed: ${surfaceError.message}`
                    : "Downstream path generated, but inundation surface failed."
                );
                if (downstream) {
                  downstream.textContent = "Downstream: inundation surface failed.";
                  downstream.dataset.state = "error";
                }
              }
            })
            .catch((error: unknown) => {
              if (traceGeneration !== downstreamTraceGeneration) {
                return;
              }

              downstreamTraceStarted = false;
              console.warn("Downstream flow tracing failed:", error);
              writeHelp(
                error instanceof Error
                  ? `Overtopping detected, but downstream tracing failed: ${error.message}`
                  : "Overtopping detected, but downstream tracing failed."
              );
              if (downstream) {
                downstream.textContent = "Downstream: flow tracing failed.";
                downstream.dataset.state = "error";
              }
            });
        }
      }
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
      `Reservoir generated${source === "automatic" ? " automatically" : ""} — level ${basin.waterElevation.toFixed(1)} m · crest ${basin.damCrestElevation.toFixed(1)} m · max depth ${basin.maxDepth.toFixed(1)} m · max dam height ${basin.maxDamHeight.toFixed(1)} m · dam ${basin.damLength.toFixed(0)} m · grid ${basin.resolution}×${basin.resolution} · ${basin.cellSize.toFixed(1)} m/cell · area ${areaHa.toFixed(1)} ha · volume ${volumeHm3.toFixed(3)} hm³. Click normally to release the rock.`
    );

    writeHelp(
      "Ctrl+click twice to draw a new dam. The reservoir is generated automatically when the upstream side can be detected. Shift+click upstream only as a manual fallback."
    );
  };

  const reservoirSettingKeys = new Set<keyof typeof settings>([
    "reservoirFreeboard",
    "maxBasinExtent",
    "targetDemCellSize",
    "maxBasinResolution"
  ]);

  const scheduleBasinRegeneration = () => {
    if (!lastBasinSeed || !lastBasinSource || !damBarrier) {
      return;
    }

    if (basinRegenerationTimer !== null) {
      window.clearTimeout(basinRegenerationTimer);
    }

    basinRegenerationTimer = window.setTimeout(() => {
      basinRegenerationTimer = null;
      const seed = lastBasinSeed?.clone();
      const source = lastBasinSource;

      if (!seed || !source) {
        return;
      }

      writeHelp("Reservoir parameters changed. Regenerating current basin...");

      void applyBasin(seed, source)
        .then(() => {
          writeHelp(
            "Reservoir regenerated with updated parameters. Rockfall settings apply to the next release."
          );
        })
        .catch((error: unknown) => {
          console.warn("Reservoir regeneration failed:", error);
          writeHelp(
            error instanceof Error
              ? `Reservoir regeneration failed: ${error.message}`
              : "Reservoir regeneration failed."
          );
        });
    }, 250);
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

      if (reservoirSettingKeys.has(key)) {
        scheduleBasinRegeneration();
      } else {
        writeHelp(
          "Rockfall parameter updated. It applies to the next release."
        );
      }
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
      scheduleBasinRegeneration();
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
    () => {
      if (
        lastDamCrestElevation === null ||
        !lastDamProfilePoints ||
        lastDamProfilePoints.length < 2
      ) {
        return null;
      }

      return {
        crestElevation: lastDamCrestElevation,
        profilePoints: lastDamProfilePoints
      };
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
          lastDamProfilePoints = null;
          lastDamCrestElevation = null;
          downstreamTraceGeneration += 1;
          downstreamLayer.removeAll();
          downstreamRasterLayer.removeAll();
          lastDownstreamRaster = null;
          refreshDownstreamRaster();
          downstreamTraceStarted = false;
          overtoppingPeakHeight = 0;
          overtoppingPeakSourceT = null;
          overtoppingPeakLastIncreaseAt = 0;
          overtoppingEventActive = false;
          if (downstream) {
            downstream.textContent = "Downstream: waiting for overtopping.";
            downstream.dataset.state = "waiting";
          }
          damWaterLevelGraphic = null;
          if (overtopping) {
            overtopping.textContent = "Dam wave monitor — waiting for reservoir.";
            overtopping.dataset.state = "normal";
          }
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
      downstreamTraceGeneration += 1;
      downstreamLayer.removeAll();
      downstreamRasterLayer.removeAll();
      lastDownstreamRaster = null;
      refreshDownstreamRaster();
      trajectoryGraphic = null;
      downstreamTraceStarted = false;
      overtoppingPeakHeight = 0;
      overtoppingPeakSourceT = null;
      overtoppingPeakLastIncreaseAt = 0;
      overtoppingEventActive = false;

      waterNode.resetDynamics();

      if (overtopping) {
        overtopping.textContent = "Dam wave monitor — waiting for new impact.";
        overtopping.dataset.state = "normal";
      }

      if (downstream) {
        downstream.textContent = "Downstream: waiting for overtopping.";
        downstream.dataset.state = "waiting";
      }

      view.closePopup();

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
