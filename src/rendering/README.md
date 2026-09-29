# Rendering

GeoDynamics injects custom geometry into the ArcGIS SceneView through the experimental `RenderNode` API.

The first integration deliberately does **not** let `THREE.WebGLRenderer` own the shared ArcGIS WebGL context. Instead:

1. Three.js creates the irregular boulder mesh (`IcosahedronGeometry`).
2. ArcGIS `renderCoordinateTransformAt()` georeferences the local mesh.
3. A custom `RenderNode` draws the geometry into ArcGIS' `opaque-color` render target.
4. ArcGIS depth testing therefore lets the boulder participate correctly in the 3D scene.

This keeps Three.js useful for geometry and math while respecting the framebuffer and WebGL-state requirements of SceneView.

Next: animate the model transform from Rapier rigid-body state.
