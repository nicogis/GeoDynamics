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
2. **Georeferenced WebGL rock** — Three.js boulder geometry rendered through ArcGIS RenderNode. ✅
3. **Rockfall physics** — ArcGIS terrain sampling, Rapier triangle-mesh collider, rigid body and rotation. ✅
4. **Trajectory GIS output** — long-range path, runout, speed and distance metrics. ✅
5. **GIS rockfall result** — endpoint, elevation drop, mass and kinetic-energy attributes. ✅
6. **Higher-fidelity rockfall physics** — 129 × 129 terrain sampling and irregular convex rock collider. ✅
7. **Water surface base** — explicitly placed animated WebGL water patch. ✅
8. **Water impact** — rock/water intersection, impact-generated ripples, drag and buoyancy coupling. ✅
9. **Persistent GPU water state** — ping-pong floating-point textures storing wave height and vertical velocity. ✅
10. **Terrain-aware basin** — ArcGIS DEM mask + connected wet cells around the selected seed. ✅
11. **Dam-constrained reservoir** — explicit barrier across the valley closes the flood-fill and derives the reservoir level from the dam crest. 🚧
12. **Barrier / overtopping** — simplified overflow propagation.
13. **GIS outputs** — trajectories, impact energy and hazard surfaces.

## Current POC

Use **Ctrl + click** on one side of the valley to set the first dam abutment, then **Ctrl + click** on the opposite side to close the barrier. While positioning the second point, GeoDynamics previews both the horizontal crest and its ground projection. After the second Ctrl + click, GeoDynamics tries to detect the upstream side automatically and generate the reservoir. If automatic detection is inconclusive, use **Shift + click** on a low point behind the dam to provide the upstream reservoir seed manually. Click normally to release the boulder. GeoDynamics samples a 2400 × 2400 metre grid from ArcGIS World Elevation, converts it into a local Rapier triangle mesh, creates a dynamic irregular convex-hull collider for the boulder and advances the simulation at a fixed 60 Hz. The trajectory is recorded as a 3D ArcGIS polyline with live runout, path-length and speed telemetry. When the boulder comes to rest or leaves the sampled domain, GeoDynamics writes a result point with runout, elevation drop, maximum speed, estimated rock mass and peak kinetic energy.

The physical coordinate system is intentionally local:

- Rapier X = east
- Rapier Y = elevation / up
- Rapier Z = north

Every physics frame is converted back into ArcGIS map coordinates and then into the SceneView render coordinate system. The boulder's Rapier quaternion is applied to the Three.js-generated geometry before the custom RenderNode draws it.

## Run locally

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

The Vite build uses relative asset URLs and copies `public/web.config` into `dist`, so the output can be deployed directly to an IIS application or virtual directory.

## Project structure

```text
src/
  arcgis/       ArcGIS SceneView and geographic interaction
  rendering/    Three.js geometry + ArcGIS RenderNode integration
  physics/      ArcGIS elevation sampling / Rapier terrain data
  simulation/   Rapier world and rockfall orchestration
  ui/           Controls and telemetry
```

## Rockfall architecture

```text
ArcGIS SceneView
      |
      +-- click release point
      |
      +-- Ground.queryElevation(Multipoint)
      |       |
      |       +-- 129 × 129 DEM samples
      |       +-- local triangle mesh
      |
      +-- Rapier World
      |       |
      |       +-- static terrain collider
      |       +-- dynamic boulder collider
      |       +-- gravity / collision / rotation
      |
      +-- trajectory GraphicsLayer
      |       +-- 3D Polyline path
      |       +-- runout / distance / speed metrics
      |
      +-- result GraphicsLayer
      |       +-- endpoint / stop condition
      |       +-- elevation drop / rock mass
      |       +-- peak kinetic energy
      |
      +-- dam GraphicsLayer
      |       +-- Ctrl + click first abutment
      |       +-- live crest + terrain projection preview
      |       +-- Ctrl + click opposite abutment
      |       +-- horizontal crest / terrain intersection
      |
      +-- WaterRenderNode
      |       +-- automatic upstream-side detection
      |       +-- automatic reservoir generation
      |       +-- Shift + click manual upstream seed fallback
      |       +-- dam-constrained DEM flood fill
      |       +-- crest-derived water level
      |       +-- animated WebGL water surface
      |       +-- ArcGIS DEM sampling around the basin seed
      |       +-- connected wet-cell mask below the water level
      |       +-- floating-point ping-pong state textures
      |       +-- persistent height / velocity propagation
      |       +-- impact injection into GPU state
      |       +-- masked water physics / rendering
      |
      +-- RockRenderNode
              |
              +-- local physics position -> ArcGIS position
              +-- Rapier quaternion -> local model rotation
              +-- ArcGIS render-coordinate transform
              +-- shared SceneView depth buffer
```

## Notes

The current simulation area is intentionally local. This avoids floating-point precision issues that would arise if a physics engine operated directly on global/ECEF coordinates.

`RenderNode` is an experimental expert-level ArcGIS API and is isolated in the rendering module.

## License

MIT
