# GeoDynamics

**Experimental geospatial physics simulations on real-world 3D terrain.**

GeoDynamics explores how a GIS can become an interactive simulation environment by combining ArcGIS Maps SDK for JavaScript with WebGL rendering and rigid-body physics.

## Vision

The first scenario is a georeferenced rockfall: select a release point on mountainous terrain, simulate a boulder under gravity, let it collide and roll over the terrain, then study its trajectory and impact energy.

The next scenario will extend the experiment with a water basin and barrier, converting the impact into a GPU-driven wave and eventually producing GIS outputs such as inundation depth and hazard layers.

## Technology

- TypeScript + Vite
- ArcGIS Maps SDK for JavaScript 5.1
- Three.js geometry and matrix utilities
- ArcGIS RenderNode / WebGL2
- Rapier 3D (WASM)

## Milestones

1. **ArcGIS bootstrap** — SceneView, world elevation and terrain interaction. ✅
2. **Georeferenced WebGL rock** — Three.js boulder geometry rendered through ArcGIS RenderNode. 🚧
3. **Rockfall physics** — terrain sampling, local heightfield, Rapier rigid body and trajectory.
4. **Water impact** — GPU height-field water simulation and impact impulse.
5. **Barrier / overtopping** — simplified overflow propagation.
6. **GIS outputs** — trajectories, impact energy and hazard surfaces.

## Current POC

Click anywhere on the 3D terrain. GeoDynamics creates an irregular Three.js boulder in local metric coordinates and places it in the ArcGIS render coordinate system through a custom `RenderNode`.

The custom object is rendered into the `opaque-color` stage so it shares the SceneView depth buffer instead of being drawn as a disconnected HTML/WebGL overlay.

## Run locally

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Project structure

```text
src/
  arcgis/       ArcGIS SceneView, terrain and geographic coordinates
  rendering/    Three.js geometry + ArcGIS RenderNode integration
  physics/      Rapier rigid bodies and terrain collision
  simulation/   Scenario orchestration
  ui/           Controls and telemetry
```

## Rendering architecture

```text
ArcGIS SceneView
      |
      +-- world-elevation
      |
      +-- RenderNode (opaque-color)
              |
              +-- ArcGIS render-coordinate transform
              +-- Three.js IcosahedronGeometry
              +-- custom WebGL2 shader
              +-- shared SceneView depth buffer
```

## Status

Experimental. `RenderNode` is an expert-level ArcGIS API and is intentionally isolated in the rendering module.

## License

MIT
