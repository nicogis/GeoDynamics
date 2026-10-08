# GeoDynamics

**Experimental geospatial physics simulations on real-world 3D terrain.**

**Release target:** GeoDynamics 1.0.0

**Live demo:** GitHub Pages deployment is included in the release workflow and will be available at `https://nicogis.github.io/GeoDynamics/` once Pages is enabled for GitHub Actions.

<p align="center">
  <img src="docs/media/geodynamics-demo.gif" alt="GeoDynamics demo" width="900">
</p>

<p align="center"><em>GeoDynamics live simulation.</em></p>

GeoDynamics explores how a GIS can become an interactive simulation environment by combining ArcGIS Maps SDK for JavaScript with terrain sampling, custom WebGL2 rendering, rigid-body physics, reduced-order and experimental 2D shallow-water hydraulics, reproducible scenario persistence and GIS-native analysis outputs.

## Vision

GeoDynamics starts from a simple question: what happens if the geographic scene is not only visualized, but also used as the physical domain of an interactive simulation?

The current proof of concept links four systems:

1. **ArcGIS SceneView** provides the real-world terrain, camera and GIS interaction.
2. **Rapier 3D** simulates a georeferenced rockfall in a local metric frame.
3. **ArcGIS RenderNode / WebGL2** renders the rock and a persistent GPU water surface inside the SceneView rendering pipeline.
4. **Downstream raster simulation** converts overtopping into depth, velocity, arrival-time and hazard outputs that can be inspected and exported.

The project is intentionally experimental. The downstream stage can run either the established reduced-order raster solver or an experimental 2D shallow-water-equation (SWE) solver. The SWE path evolves depth and horizontal momentum with CFL-controlled time stepping, while the reduced-order solver remains the stable reference/fallback. Numerical accounting, topology, mass conservation and frozen A/B events are used to keep solver comparisons reproducible.

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
6. **Higher-fidelity rockfall physics** — adaptive ArcGIS terrain sampling up to 257 × 257 over a 4.8 km domain, batched DEM queries and an irregular convex rock collider. ✅
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
19. **Water/dam visual realism** — depth-aware GPU water, dynamic height-field motion, Fresnel/specular shading, micro-ripples and cleaner dam visualization. ✅
20. **Mass-conservation validation** — conservative transfer core, outflow accounting, signed residual and hydrograph integration checks. ✅
21. **Experimental SWE 2D solver** — depth + horizontal momentum, CFL-controlled stepping, frozen-event A/B comparison and reduced-order fallback. ✅
22. **Scenario JSON persistence** — camera, parameters, dam, reservoir seed/source and downstream display/solver state can be saved and restored reproducibly. ✅
23. **Extended rockfall domain** — 4.8 km terrain window with batched elevation sampling and ~2.3 km usable runout radius. ✅

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
- downstream solver (reduced-order or experimental SWE 2D);
- downstream raster metric and opacity;
- scenario JSON save/load for reproducible test cases.

The rockfall runs in a local metric Rapier frame built from an adaptive ArcGIS terrain sample. By default the terrain window spans 4.8 km and uses up to 257 × 257 samples, queried in batches while preserving roughly the previous ~18.75 m grid spacing. The usable runout boundary is about 2.325 km from the release point. The water basin is constrained by the sampled dam and DEM topology. If an impact wave exceeds the available freeboard, overtopping is detected along the crest and the selected downstream solver is executed.

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

## Scenario persistence

GeoDynamics scenarios can be saved to and restored from JSON. The versioned schema currently persists:

- SceneView camera position, heading and tilt;
- all simulation settings;
- dam start/end points;
- reservoir seed and whether it came from automatic or manual selection;
- downstream solver mode;
- downstream raster metric and opacity.

Scenario loading validates the nested JSON before applying it, cancels active rockfall work, clears transient reservoir/downstream state, restores the camera and then deterministically regenerates the saved reservoir. This is primarily intended for reproducing camera-, terrain- and geometry-sensitive test cases while development continues.

Scenarios saved by the 1.0.0 release also include an `engineVersion` field. The field is optional when loading, so JSON scenarios created by earlier development builds remain compatible with schema version 1.

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

- DEM-derived basin depth and wet mask;
- persistent ping-pong GPU height/velocity state;
- rock-impact disturbance injection;
- dynamic height-field displacement;
- normals derived from the physical wave field plus subtle procedural micro-ripples;
- depth-dependent colour, Fresnel/specular response and shoreline/crest foam cues;
- ArcGIS local East/North/Up render transforms;
- explicit WebGL texture-orientation state for the shared SceneView context;
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

## Downstream solvers

GeoDynamics now exposes two downstream solver modes.

### Reduced-order solver

The reduced-order solver remains the stable reference implementation. It uses:

- explicit overtopping input from a broad-crested-weir-style discharge estimate;
- a compact triangular hydrograph;
- terrain-controlled cell-to-cell transfer;
- Manning-based kinematic velocity;
- CFL-like transfer limiting;
- explicit downstream boundary drainage;
- adaptive domain expansion;
- wet/dry thresholds;
- mass accounting for input, storage and outflow.

### Experimental SWE 2D solver

The experimental SWE path evolves water depth and horizontal momentum on a raster domain with CFL-controlled time stepping. It is intentionally marked experimental: the same frozen overtopping event can be rerun through either solver for A/B comparison, and failures fall back to the reduced-order implementation instead of invalidating the interactive workflow.

This makes the reduced-order solver the reproducible baseline while the SWE implementation can be advanced incrementally toward a more complete Saint-Venant treatment.

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

## GitHub Pages deployment

The repository includes a GitHub Actions workflow that builds and deploys `dist` to GitHub Pages on every push to `main`.

The Vite configuration uses relative asset paths, so the application can run below the repository path:

```text
https://nicogis.github.io/GeoDynamics/
```

GitHub Pages must be configured to use **GitHub Actions** as its source. The deployment workflow runs the test suite before publishing and uploads only the generated `dist` artifact; the build output is not committed to `main`.

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
      +-- Downstream solvers
      |       |
      |       +-- frozen overtopping event
      |       +-- reduced-order raster solver
      |       +-- experimental SWE 2D solver
      |       +-- fallback / A-B comparison
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
- reduced-order + experimental SWE 2D comparison on frozen events;
- versioned JSON scenario persistence for reproducibility;
- explicit diagnostics and synthetic tests;
- integrated GIS visualization.

Current limitations:

- the SWE 2D path is still experimental and not a validated engineering solver;
- no formal production-grade Riemann solver / high-resolution shock-capturing scheme yet;
- no benchmark validation against laboratory or regulatory reference datasets yet;
- no uncertainty/calibration workflow yet;
- rockfall terrain is still a finite sampled window, currently 4.8 km across.

The next hydraulic milestones are stronger wet/dry treatment, higher-order/conservative fluxes, reference-benchmark validation and systematic comparison between the reduced-order and SWE 2D solvers.

## Notes

`RenderNode` is an advanced ArcGIS rendering API and is isolated in the rendering layer.

The GPU reservoir-wave simulation and downstream hydraulic solvers solve different problems: the former provides local visual/impact-wave behaviour inside the reservoir, while the latter estimate downstream propagation after overtopping. Procedural ambient water motion is visual only and does not modify hydraulic state or overtopping calculations.

## License

MIT
