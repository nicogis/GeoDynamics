# GeoDynamics

**Experimental geospatial physics simulations on real-world 3D terrain.**

GeoDynamics explores how a GIS can become an interactive simulation environment by combining ArcGIS Maps SDK for JavaScript with terrain sampling, custom WebGL2 rendering, rigid-body physics, reduced-order hydraulic simulation and GIS-native analysis outputs.

## Vision

GeoDynamics starts from a simple question: what happens if the geographic scene is not only visualized, but also used as the physical domain of an interactive simulation?

The current proof of concept links four systems:

1. **ArcGIS SceneView** provides the real-world terrain, camera and GIS interaction.
2. **Rapier 3D** simulates a georeferenced rockfall in a local metric frame.
3. **ArcGIS RenderNode / WebGL2** renders the rock and a persistent GPU water surface inside the SceneView rendering pipeline.
4. **Downstream raster simulation** converts overtopping into depth, velocity, arrival-time and hazard outputs that can be inspected and exported.

The project is intentionally experimental. The downstream model is currently a reduced-order kinematic/diffusive raster solver, not a full 2D shallow-water-equation solver. Numerical accounting, topology and mass conservation are explicitly tested so that future solver upgrades have a reproducible baseline.

## Technology

- TypeScript + Vite
- ArcGIS Maps SDK for JavaScript 5.1
- ArcGIS SceneView + World Elevation
- ArcGIS RenderNode / shared WebGL2 context
- Three.js geometry and matrix utilities
- Rapier 3D (WASM)
- Synthetic Node test suite for reservoir topology and hydraulic accounting

## Milestones

1. **ArcGIS bootstrap** — SceneView, world elevation and terrain interaction. ✅
2. **Georeferenced WebGL rock** — Three.js boulder geometry rendered through ArcGIS RenderNode. ✅
3. **Rockfall physics** — ArcGIS terrain sampling, Rapier triangle-mesh collider, rigid body and rotation. ✅
4. **Trajectory GIS output** — 3D path, runout, distance and speed telemetry. ✅
5. **GIS rockfall result** — endpoint, elevation drop, mass and kinetic-energy attributes. ✅
6. **Higher-fidelity rockfall physics** — 129 × 129 terrain sampling and irregular convex rock collider. ✅
7. **Water surface base** — animated custom WebGL water surface. ✅
8. **Rock-water coupling** — impact-generated disturbance, drag and buoyancy. ✅
9. **Persistent GPU water state** — ping-pong floating-point textures for height and vertical velocity. ✅
10. **Terrain-aware reservoir** — DEM-based connected wet-cell mask around an upstream seed. ✅
11. **Dam-constrained reservoir** — explicit dam, crest-derived level, automatic upstream-side detection and manual fallback. ✅
12. **Rapier dam collider** — the rock can physically hit, stop at or clear the barrier. ✅
13. **Overtopping detection** — crest sampling, contiguous overflow width and overtopping head. ✅
14. **Downstream inundation foundation** — flow path and terrain-aware inundation surface. ✅
15. **Reduced-order downstream raster solver** — depth, velocity, arrival time and adaptive computational domain. ✅
16. **GIS raster visualization** — selectable max-depth, velocity, arrival-time and hazard metrics. ✅
17. **Hazard outputs** — experimental depth × velocity hazard index, classes, popups and GeoJSON export. ✅
18. **Reservoir topology validation** — synthetic valleys, oblique dams, closed depressions and zero-freeboard regression tests. ✅
19. **Water/dam visual realism** — depth-aware water rendering, micro-ripples and cleaner dam visualization. ✅
20. **Mass-conservation validation** — conservative transfer core, outflow accounting, signed residual and hydrograph integration checks. ✅
21. **Next step: 2D shallow-water equations** — conservative mass + momentum solver with CFL-controlled time stepping. 🚧

## Current POC workflow

Use **Ctrl + click** on one side of a valley to set the first dam abutment, then **Ctrl + click** on the opposite side to close the barrier. While positioning the second point, GeoDynamics previews the crest and its ground projection.

After the dam is created, GeoDynamics attempts to detect the upstream side automatically and generate the reservoir. If the automatic choice is not satisfactory, use **Shift + click** on a low point upstream to provide an authoritative reservoir seed.

Click normally to release the boulder.

The runtime panel exposes parameters such as:

- reservoir freeboard;
- maximum basin extent;
- DEM target cell size and resolution;
- rock radius and density;
- release height;
- water drag;
- downstream raster metric and opacity.

The rockfall runs in a local metric Rapier frame built from an ArcGIS terrain sample. The water basin is constrained by the sampled dam and DEM topology. If an impact wave exceeds the available freeboard, overtopping is detected along the crest and a downstream raster simulation is generated.

The downstream result currently includes:

- peak water depth;
- peak velocity;
- arrival time;
- wet area;
- front distance and speed;
- effective overtopping width;
- peak discharge;
- Manning roughness;
- hydrograph duration;
- adaptive-domain diagnostics;
- input, stored and outflow volumes;
- signed mass-balance residual;
- mass-balance error;
- analytical-vs-discrete hydrograph volume error;
- experimental hazard index and hazard classes.

## Physical coordinate systems

The rigid-body simulation intentionally uses a local coordinate system:

- Rapier X = east
- Rapier Y = elevation / up
- Rapier Z = north

Every physics frame is converted back into ArcGIS map coordinates and then into the SceneView render-coordinate system. The boulder's Rapier quaternion is applied to the Three.js-generated geometry before the custom RenderNode draws it.

This avoids applying rigid-body physics directly in global/ECEF coordinates, where floating-point precision would be inappropriate for the local-scale simulation.

## Rendering architecture

ArcGIS owns the WebGL context.

Three.js is used for geometry and matrix utilities, but **THREE.WebGLRenderer does not own or replace the SceneView context**. Rock and water rendering are implemented through ArcGIS RenderNode so they remain synchronized with the SceneView camera and depth buffer.

The water renderer uses:

- DEM-derived basin depth;
- persistent GPU height/velocity state;
- impact injection;
- depth-dependent water colour;
- procedural micro-ripples;
- shoreline/crest foam cues;
- shared SceneView depth.

## Reservoir topology

Reservoir generation is based on a terrain sample and a connected-component flood fill constrained to the upstream side of the dam.

Important safeguards include:

- same-half-plane filtering relative to the dam;
- diagonal traversal only when an orthogonal wet bridge exists;
- contact validation against the real dam span;
- automatic and manual seed handling;
- a small topology-only elevation epsilon so zero freeboard does not create crest-level connectivity artefacts;
- deterministic synthetic tests for simple, concave, branched, symmetric and oblique terrain.

## Downstream solver

The current downstream raster model is deliberately a **reduced-order hydraulic solver**.

It uses:

- explicit overtopping input from a broad-crested-weir-style discharge estimate;
- a compact triangular hydrograph;
- terrain-controlled cell-to-cell transfer;
- Manning-based kinematic velocity;
- CFL-like transfer limiting;
- explicit downstream boundary drainage;
- adaptive domain expansion;
- wet/dry thresholds;
- mass accounting for input, storage and outflow.

It is not yet a complete Saint-Venant / full 2D SWE implementation because horizontal momentum is not evolved as a conserved state.

### Mass accounting

The solver explicitly tracks:

```text
input volume = stored volume + outflow volume + residual
```

Synthetic tests verify:

- closed-domain water-volume conservation;
- conservation with tracked outlet drainage;
- stability across multiple raster resolutions;
- numerical integration of the triangular hydrograph;
- consistency of the production solver core.

The UI reports both the signed residual and percentage mass-balance error.

## Experimental hazard output

Each downstream raster cell can expose:

- depth;
- velocity;
- arrival time;
- depth × velocity hazard index;
- hazard class;
- thin-sheet flag.

The current experimental classes are:

- low: < 0.5
- moderate: < 1.5
- high: < 3
- extreme: >= 3

These classes are an experimental visualization aid, not a regulatory flood-risk classification.

A WGS84 GeoJSON export is available for downstream hazard cells.

## Run locally

```bash
npm install
npm run dev
```

Run the synthetic validation suite:

```bash
npm test
```

Production build:

```bash
npm run build
```

The Vite build uses relative asset URLs and copies `public/web.config` into `dist`, so the result can be deployed directly to an IIS application or virtual directory.

## Project structure

```text
src/
  arcgis/       SceneView interaction, layers and GIS presentation
  rendering/    custom RenderNode rock/water rendering
  physics/      terrain, reservoir and downstream hydraulic logic
  simulation/   Rapier world and rockfall orchestration
  ui/           controls and telemetry

tests/
  reservoir topology synthetic scenarios
  downstream mass-conservation / hydrograph validation
```

## High-level architecture

```text
ArcGIS SceneView
      |
      +-- Ground.queryElevation
      |       |
      |       +-- rockfall terrain mesh
      |       +-- reservoir DEM
      |       +-- downstream raster terrain
      |
      +-- Rapier World
      |       |
      |       +-- static terrain collider
      |       +-- static dam collider
      |       +-- dynamic irregular boulder
      |
      +-- RockRenderNode
      |       +-- Rapier pose -> ArcGIS render coordinates
      |
      +-- WaterRenderNode
      |       |
      |       +-- reservoir wet mask
      |       +-- GPU height/velocity textures
      |       +-- rock impact injection
      |       +-- overtopping detection
      |
      +-- Downstream raster solver
      |       |
      |       +-- overtopping hydrograph
      |       +-- Manning / terrain routing
      |       +-- adaptive domain
      |       +-- mass accounting
      |
      +-- GIS outputs
              |
              +-- trajectory/result graphics
              +-- depth/velocity/arrival/hazard cells
              +-- popups and diagnostics
              +-- GeoJSON export
```

## Numerical scope

GeoDynamics is a research-oriented POC, not an engineering-certification hydraulic package.

Current strengths:

- real-world ArcGIS terrain coupling;
- reproducible geospatial/physics coordinate transforms;
- conservative water-volume accounting;
- explicit diagnostics and synthetic tests;
- integrated GIS visualization.

Current limitations:

- downstream hydraulics use a reduced-order model;
- no conserved horizontal momentum field yet;
- no formal 2D Riemann flux;
- no benchmark validation against laboratory or regulatory reference datasets yet;
- no uncertainty/calibration workflow yet.

The next hydraulic milestone is a full conservative 2D SWE foundation with explicit wet/dry treatment and CFL-controlled time stepping.

## Notes

`RenderNode` is an advanced ArcGIS rendering API and is isolated in the rendering layer.

The GPU reservoir-wave simulation and downstream raster simulation solve different problems: the former provides local visual/impact-wave behaviour inside the reservoir, while the latter estimates downstream propagation after overtopping.

## License

MIT
