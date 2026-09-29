# GeoDynamics

**Experimental geospatial physics simulations on real-world 3D terrain.**

GeoDynamics explores how a GIS can become an interactive simulation environment by combining ArcGIS Maps SDK for JavaScript with WebGL rendering and rigid-body physics.

## Vision

The first scenario is a georeferenced rockfall: select a release point on mountainous terrain, simulate a boulder under gravity, let it collide and roll over the terrain, then study its trajectory and impact energy.

The next scenario will extend the experiment with a water basin and barrier, converting the impact into a GPU-driven wave and eventually producing GIS outputs such as inundation depth and hazard layers.

## Technology

- TypeScript + Vite
- ArcGIS Maps SDK for JavaScript
- Three.js / WebGL
- Rapier 3D (WASM)

## Milestones

1. **ArcGIS bootstrap** — SceneView, world elevation and terrain interaction.
2. **Rockfall physics** — terrain sampling, local heightfield, rigid-body boulder and trajectory.
3. **Water impact** — GPU height-field water simulation and impact impulse.
4. **Barrier / overtopping** — simplified overflow propagation.
5. **GIS outputs** — trajectories, impact energy and hazard surfaces.

## Current POC

The current bootstrap opens a 3D ArcGIS scene and lets you click the terrain to place a candidate rock-release point.

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
  rendering/    Three.js / custom WebGL integration
  physics/      Rapier rigid bodies and terrain collision
  simulation/   Scenario orchestration
  ui/           Controls and telemetry
```

## Status

Experimental. The project intentionally starts with a small vertical slice before introducing custom WebGL rendering and physics.

## License

MIT
