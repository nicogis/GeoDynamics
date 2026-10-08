import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RenderNode from "@arcgis/core/views/3d/webgl/RenderNode";
import * as webgl from "@arcgis/core/views/3d/webgl";
import { Matrix4, Vector3 } from "three";

const WATER_TEXTURE_SIZE = 128;
const WATER_GRID_RESOLUTION = 128;
const WATER_STEPS_PER_FRAME = 2;

type WaterNodeInternal = RenderNode & {
  waterTransform: Float64Array | null;
  renderProgram: WebGLProgram | null;
  simulationProgram: WebGLProgram | null;
  impactProgram: WebGLProgram | null;
  meshBuffer: WebGLBuffer | null;
  quadBuffer: WebGLBuffer | null;
  stateTextures: [WebGLTexture | null, WebGLTexture | null];
  stateFramebuffers: [WebGLFramebuffer | null, WebGLFramebuffer | null];
  maskTexture: WebGLTexture | null;
  depthTexture: WebGLTexture | null;
  basinMask: Uint8Array | null;
  basinDepth: Float32Array | null;
  basinResolution: number;
  activeState: number;
  vertexCount: number;
  initializedResources: boolean;
  meshSize: number;
  size: number;
  center: Point | null;
  surfaceElevation: number | null;
  pendingImpact: { u: number; v: number; strength: number } | null;
  damSamples: { u: number; v: number; t: number }[];
  damFreeboard: number;
  overtoppingCallback:
    | ((state: {
        overtopping: boolean;
        maxWaveHeight: number;
        freeboard: number;
        sourceT: number | null;
        overtoppingWidthFraction: number;
        overtoppingSampleCount: number;
      }) => void)
    | null;
  lastOvertoppingRead: number;
  sceneViewport: Int32Array | null;
  viewMatrix: Matrix4;
  modelMatrix: Matrix4;
  modelViewMatrix: Matrix4;
  setBasin(
    center: Point,
    size: number,
    elevation: number,
    mask: Uint8Array,
    depth: Float32Array,
    resolution: number
  ): void;
  setDamMonitor(
    start: Point,
    end: Point,
    crestElevation: number,
    callback: (
      state: {
        overtopping: boolean;
        maxWaveHeight: number;
        freeboard: number;
        sourceT: number | null;
        overtoppingWidthFraction: number;
        overtoppingSampleCount: number;
      }
    ) => void
  ): void;
  containsPoint(point: Point): boolean;
  addImpact(point: Point, speed: number): void;
  getSurface(): { center: Point; size: number; elevation: number } | null;
  resetDynamics(): void;
  clearBasin(): void;
  ensureResources(): void;
  rebuildMesh(): void;
  uploadBasinMask(): void;
  uploadBasinDepth(): void;
  resetWaterState(): void;
  updateOvertoppingMonitor(): void;
  runImpactPass(): void;
  runSimulationStep(): void;
  drawWater(): void;
};

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create water shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown water shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  if (!program) {
    throw new Error("Unable to create water program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message =
      gl.getProgramInfoLog(program) ?? "Unknown water program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

function createStateTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Unable to create water state texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    WATER_TEXTURE_SIZE,
    WATER_TEXTURE_SIZE,
    0,
    gl.RGBA,
    gl.HALF_FLOAT,
    null
  );

  return texture;
}

function createMaskTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Unable to create water mask texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

function createDepthTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Unable to create reservoir depth texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

function createStateFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture
): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    throw new Error("Unable to create water framebuffer.");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Floating-point water framebuffer is incomplete.");
  }

  return framebuffer;
}

function createWaterMesh(
  view: SceneView,
  center: Point,
  size: number,
  elevation: number,
  localToRender: ArrayLike<number>
): Float32Array {
  const half = size / 2;
  const cells = WATER_GRID_RESOLUTION;
  const gridSize = cells + 1;
  const gridVertexCount = gridSize * gridSize;
  const source = new Float64Array(gridVertexCount * 3);

  for (let row = 0; row < gridSize; row += 1) {
    const v = row / cells;
    const y = center.y - half + v * size;

    for (let col = 0; col < gridSize; col += 1) {
      const u = col / cells;
      const x = center.x - half + u * size;
      const index = (row * gridSize + col) * 3;
      source[index] = x;
      source[index + 1] = y;
      source[index + 2] = elevation;
    }
  }

  const render = new Float64Array(gridVertexCount * 3);
  const transformed = webgl.toRenderCoordinates(
    view,
    source,
    0,
    center.spatialReference,
    render,
    0,
    gridVertexCount
  );

  if (!transformed) {
    throw new Error("Unable to transform water mesh into ArcGIS render coordinates.");
  }

  const renderToLocal = new Matrix4()
    .fromArray(Array.from(localToRender))
    .invert();
  const local = new Float64Array(gridVertexCount * 3);
  const point = new Vector3();

  for (let i = 0; i < gridVertexCount; i += 1) {
    const index = i * 3;
    point
      .set(render[index], render[index + 1], render[index + 2])
      .applyMatrix4(renderToLocal);
    local[index] = point.x;
    local[index + 1] = point.y;
    local[index + 2] = point.z;
  }

  const floatsPerVertex = 14;
  const data = new Float32Array(cells * cells * 6 * floatsPerVertex);
  let offset = 0;

  const writeVertex = (col: number, row: number) => {
    const u = col / cells;
    const v = row / cells;
    const index = (row * gridSize + col) * 3;

    data[offset++] = local[index];
    data[offset++] = local[index + 1];
    data[offset++] = local[index + 2];
    data[offset++] = u;
    data[offset++] = v;

    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 1;

    data[offset++] = 1;
    data[offset++] = 0;
    data[offset++] = 0;

    data[offset++] = 0;
    data[offset++] = 1;
    data[offset++] = 0;
  };

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      writeVertex(col, row);
      writeVertex(col + 1, row);
      writeVertex(col + 1, row + 1);

      writeVertex(col, row);
      writeVertex(col + 1, row + 1);
      writeVertex(col, row + 1);
    }
  }

  return data;
}

const fullscreenVertexSource = `#version 300 es
  precision highp float;

  in vec2 aPosition;
  out vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const simulationFragmentSource = `#version 300 es
  precision highp float;

  uniform sampler2D uState;
  uniform sampler2D uMask;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 outState;

  void main() {
    vec2 state = texture(uState, vUv).rg;
    float wet = texture(uMask, vUv).r;

    if (wet < 0.5) {
      outState = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float height = state.r;
    float velocity = state.g;

    vec2 leftUv = vUv - vec2(uTexel.x, 0.0);
    vec2 rightUv = vUv + vec2(uTexel.x, 0.0);
    vec2 downUv = vUv - vec2(0.0, uTexel.y);
    vec2 upUv = vUv + vec2(0.0, uTexel.y);

    float left = texture(uMask, leftUv).r > 0.5
      ? texture(uState, leftUv).r
      : height;
    float right = texture(uMask, rightUv).r > 0.5
      ? texture(uState, rightUv).r
      : height;
    float down = texture(uMask, downUv).r > 0.5
      ? texture(uState, downUv).r
      : height;
    float up = texture(uMask, upUv).r > 0.5
      ? texture(uState, upUv).r
      : height;

    float average = (left + right + down + up) * 0.25;

    velocity += (average - height) * 1.65;
    velocity *= 0.992;
    height += velocity * 0.48;

    outState = vec4(height, velocity, 0.0, 1.0);
  }
`;

const impactFragmentSource = `#version 300 es
  precision highp float;

  const float PI = 3.141592653589793;

  uniform sampler2D uState;
  uniform sampler2D uMask;
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform float uStrength;

  in vec2 vUv;
  out vec4 outState;

  void main() {
    vec2 state = texture(uState, vUv).rg;

    if (texture(uMask, vUv).r < 0.5) {
      outState = vec4(state, 0.0, 1.0);
      return;
    }

    float normalizedDistance = distance(vUv, uCenter) / uRadius;
    float drop = max(0.0, 1.0 - normalizedDistance);
    drop = 0.5 - cos(drop * PI) * 0.5;

    state.r += drop * uStrength;
    state.g += drop * uStrength * 0.16;

    outState = vec4(state, 0.0, 1.0);
  }
`;

const renderVertexSource = `#version 300 es
  precision highp float;

  in vec3 aPosition;
  in vec2 aUv;
  in vec3 aUp;
  in vec3 aEast;
  in vec3 aNorth;

  uniform sampler2D uState;
  uniform sampler2D uMask;
  uniform mat4 uProjection;
  uniform mat4 uModelView;
  uniform vec2 uTexel;
  uniform float uTime;

  out float vHeight;
  out float vSurfaceMotion;
  out vec2 vUv;
  out vec3 vNormal;

  float ambientWave(vec2 uv, float t) {
    float w1 = sin(dot(uv, vec2(37.0, 21.0)) + t * 0.00115);
    float w2 = sin(dot(uv, vec2(-18.0, 43.0)) - t * 0.00082 + 1.7);
    float w3 = sin(dot(uv, vec2(71.0, -29.0)) + t * 0.00155 + 0.6);
    return w1 * 0.50 + w2 * 0.32 + w3 * 0.18;
  }

  void main() {
    float height = texture(uState, aUv).r;
    float wet = texture(uMask, aUv).r;
    vUv = aUv;

    float left = texture(uState, aUv - vec2(uTexel.x, 0.0)).r;
    float right = texture(uState, aUv + vec2(uTexel.x, 0.0)).r;
    float down = texture(uState, aUv - vec2(0.0, uTexel.y)).r;
    float up = texture(uState, aUv + vec2(0.0, uTexel.y)).r;

    // Purely visual background motion. Physics/overtopping still use only
    // the simulated state texture, so this never changes hydraulic results.
    float ambient = wet > 0.5 ? ambientWave(aUv, uTime) * 0.14 : 0.0;
    float visualHeight = height + ambient;

    vec3 p = aPosition + aUp * visualHeight;
    vHeight = height;
    vSurfaceMotion = ambient;

    // Blend physical wave slope with small procedural surface ripples.
    vec2 physicalSlope = vec2(left - right, down - up) * 3.2;
    float phaseA = dot(aUv, vec2(37.0, 21.0)) + uTime * 0.00115;
    float phaseB = dot(aUv, vec2(-18.0, 43.0)) - uTime * 0.00082 + 1.7;
    vec2 ambientSlope =
      vec2(cos(phaseA) * 37.0, cos(phaseA) * 21.0) * 0.006 +
      vec2(cos(phaseB) * -18.0, cos(phaseB) * 43.0) * 0.004;

    vec2 slope = physicalSlope + ambientSlope;
    vNormal = normalize(
      aUp +
      aEast * slope.x +
      aNorth * slope.y
    );

    gl_Position = uProjection * uModelView * vec4(p, 1.0);
  }
`;

const renderFragmentSource = `#version 300 es
  precision highp float;

  uniform sampler2D uMask;
  uniform sampler2D uDepth;
  uniform float uTime;

  in float vHeight;
  in float vSurfaceMotion;
  in vec2 vUv;
  in vec3 vNormal;
  out vec4 fragColor;

  void main() {
    // Clip at fragment resolution rather than interpolating a wet/dry flag
    // from the 128x128 render mesh. This keeps a 256/512 DEM mask aligned
    // with the terrain shoreline and prevents triangles from bleeding across
    // the dam or smoothing over narrow terrain features.
    if (texture(uMask, vUv).r < 0.5) {
      discard;
    }

    vec3 normal = normalize(vNormal);
    vec3 lightDirection = normalize(vec3(0.30, -0.25, 0.92));
    vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));

    float diffuse = max(dot(normal, lightDirection), 0.0);
    float specular = pow(max(dot(normal, halfVector), 0.0), 72.0);
    float slope = clamp(length(normal.xy) * 1.8, 0.0, 1.0);
    float basinDepth = max(texture(uDepth, vUv).r, 0.0);

    // Approximate view-angle Fresnel from the local geographic up component.
    // It is intentionally subtle because ArcGIS still owns the scene
    // illumination and render target.
    float facing = clamp(abs(normal.z), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.0);

    // Procedural micro-ripples add small-scale variation without introducing
    // external texture assets or another renderer/context.
    float rippleA = sin(vUv.x * 190.0 + uTime * 0.0017);
    float rippleB = sin(vUv.y * 157.0 - uTime * 0.0013);
    float rippleC = sin((vUv.x + vUv.y) * 113.0 + uTime * 0.0011);
    float rippleD = sin((vUv.x * 0.73 - vUv.y) * 247.0 - uTime * 0.0015);
    float microRipple =
      rippleA * 0.34 +
      rippleB * 0.28 +
      rippleC * 0.22 +
      rippleD * 0.16;

    vec3 shallowColor = vec3(0.055, 0.34, 0.40);
    vec3 deepColor = vec3(0.012, 0.075, 0.16);
    vec3 crestColor = vec3(0.46, 0.82, 0.86);

    float depthMix = smoothstep(0.5, 18.0, basinDepth);
    vec3 color = mix(shallowColor, deepColor, depthMix);

    float positiveCrest = smoothstep(0.06, 1.15, vHeight);
    float negativeTrough = smoothstep(0.06, 1.0, -vHeight);
    color = mix(color, crestColor, positiveCrest * 0.68);
    color *= 1.0 - negativeTrough * 0.22;

    // Shoreline foam is derived from the actual basin depth texture, so it
    // follows terrain instead of forming an artificial rectangular border.
    float shorelineFoam =
      (1.0 - smoothstep(0.08, 1.1, basinDepth)) *
      (0.45 + 0.55 * smoothstep(0.02, 0.35, abs(vHeight) + slope));
    float crestFoam = positiveCrest * smoothstep(0.08, 0.42, slope);
    float foam = clamp(shorelineFoam + crestFoam, 0.0, 1.0);

    color += slope * vec3(0.028, 0.060, 0.075);
    color += microRipple * 0.010;
    color += vSurfaceMotion * vec3(0.010, 0.022, 0.030);
    color *= 0.78 + diffuse * 0.30;
    color += specular * 0.42 * vec3(0.72, 0.86, 0.92);
    color = mix(color, vec3(0.82, 0.93, 0.94), foam * 0.72);
    color = mix(color, vec3(0.16, 0.34, 0.44), fresnel * 0.28);

    float alpha =
      mix(0.62, 0.88, smoothstep(0.2, 12.0, basinDepth)) +
      foam * 0.07 +
      fresnel * 0.035;
    fragColor = vec4(color, clamp(alpha, 0.62, 0.94));
  }
`;

const WaterRenderNodeClass = RenderNode.createSubclass({
  declaredClass: "geodynamics.rendering.WaterRenderNode",

  waterTransform: null,
  renderProgram: null,
  simulationProgram: null,
  impactProgram: null,
  meshBuffer: null,
  quadBuffer: null,
  stateTextures: [null, null],
  stateFramebuffers: [null, null],
  maskTexture: null,
  depthTexture: null,
  basinMask: null,
  basinDepth: null,
  basinResolution: WATER_TEXTURE_SIZE,
  activeState: 0,
  vertexCount: 0,
  initializedResources: false,
  meshSize: 0,
  size: 420,
  center: null,
  surfaceElevation: null,
  pendingImpact: null,
  damSamples: [],
  damFreeboard: 0,
  overtoppingCallback: null,
  lastOvertoppingRead: 0,
  sceneViewport: null,

  viewMatrix: new Matrix4(),
  modelMatrix: new Matrix4(),
  modelViewMatrix: new Matrix4(),

  initialize(this: WaterNodeInternal) {
    this.consumes.required.push("opaque-color");
    this.produces = "opaque-color";
  },

  setBasin(
    this: WaterNodeInternal,
    center: Point,
    size: number,
    elevation: number,
    mask: Uint8Array,
    depth: Float32Array,
    resolution: number
  ) {
    this.size = size;
    this.center = center.clone();
    this.surfaceElevation = elevation;
    this.basinMask = mask.slice();
    this.basinDepth = depth.slice();
    this.basinResolution = resolution;
    this.damSamples = [];
    this.overtoppingCallback = null;
    this.lastOvertoppingRead = 0;

    const transform = webgl.renderCoordinateTransformAt(
      this.view,
      [center.x, center.y, elevation],
      center.spatialReference,
      new Float64Array(16)
    );

    if (!transform) {
      this.waterTransform = null;
      throw new Error(
        "Unable to create the reservoir local render transform."
      );
    }

    this.waterTransform = new Float64Array(transform);
    this.pendingImpact = null;

    if (this.initializedResources) {
      // Center/elevation can change even when size is unchanged, so always
      // rebuild the GIS-aligned mesh when a basin is replaced/regenerated.
      this.rebuildMesh();
      this.uploadBasinMask();
      this.uploadBasinDepth();
      this.resetWaterState();
    }

    this.requestRender();
  },

  setDamMonitor(
    this: WaterNodeInternal,
    start: Point,
    end: Point,
    crestElevation: number,
    callback: (
      state: {
        overtopping: boolean;
        maxWaveHeight: number;
        freeboard: number;
        sourceT: number | null;
        overtoppingWidthFraction: number;
        overtoppingSampleCount: number;
      }
    ) => void
  ) {
    if (!this.center || this.surfaceElevation === null) {
      return;
    }

    const half = this.size / 2;
    const sampleCount = 65;
    this.damSamples = [];

    for (let i = 0; i < sampleCount; i += 1) {
      const t = i / (sampleCount - 1);
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      const u = (x - this.center.x + half) / this.size;
      const v = (y - this.center.y + half) / this.size;

      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        this.damSamples.push({ u, v, t });
      }
    }

    this.damFreeboard = Math.max(
      crestElevation - this.surfaceElevation,
      0
    );
    this.overtoppingCallback = callback;
    this.lastOvertoppingRead = 0;
  },

  containsPoint(this: WaterNodeInternal, point: Point) {
    if (!this.center || !this.basinMask) {
      return false;
    }

    const half = this.size / 2;
    const mapU = (point.x - this.center.x + half) / this.size;
    const mapV = (point.y - this.center.y + half) / this.size;

    if (mapU < 0 || mapU >= 1 || mapV < 0 || mapV >= 1) {
      return false;
    }

    const col = Math.min(
      Math.floor(mapU * this.basinResolution),
      this.basinResolution - 1
    );
    const row = Math.min(
      Math.floor(mapV * this.basinResolution),
      this.basinResolution - 1
    );

    return this.basinMask[row * this.basinResolution + col] !== 0;
  },

  addImpact(this: WaterNodeInternal, point: Point, speed: number) {
    if (!this.center) {
      return;
    }

    const half = this.size / 2;
    const mapU = (point.x - this.center.x + half) / this.size;
    const mapV = (point.y - this.center.y + half) / this.size;

    this.pendingImpact = {
      u: Math.min(Math.max(mapU, 0), 1),
      v: Math.min(Math.max(mapV, 0), 1),
      strength: Math.min(Math.max(speed * 0.055, 0.6), 3.5)
    };

    this.requestRender();
  },

  getSurface(this: WaterNodeInternal) {
    if (!this.center || this.surfaceElevation === null) {
      return null;
    }

    return {
      center: this.center.clone(),
      size: this.size,
      elevation: this.surfaceElevation
    };
  },

  resetDynamics(this: WaterNodeInternal) {
    this.pendingImpact = null;
    this.lastOvertoppingRead = 0;

    if (this.initializedResources) {
      this.resetWaterState();
    }

    this.requestRender();
  },

  clearBasin(this: WaterNodeInternal) {
    this.center = null;
    this.surfaceElevation = null;
    this.basinMask = null;
    this.basinDepth = null;
    this.damSamples = [];
    this.overtoppingCallback = null;
    this.pendingImpact = null;
    this.lastOvertoppingRead = 0;
    this.requestRender();
  },

  ensureResources(this: WaterNodeInternal) {
    if (this.initializedResources) {
      return;
    }

    const gl = this.gl;

    const floatColorBuffer = gl.getExtension("EXT_color_buffer_float");

    if (!floatColorBuffer) {
      throw new Error(
        "GPU water simulation requires floating-point color-buffer support."
      );
    }

    this.renderProgram = createProgram(
      gl,
      renderVertexSource,
      renderFragmentSource
    );
    this.simulationProgram = createProgram(
      gl,
      fullscreenVertexSource,
      simulationFragmentSource
    );
    this.impactProgram = createProgram(
      gl,
      fullscreenVertexSource,
      impactFragmentSource
    );

    this.meshBuffer = gl.createBuffer();
    this.rebuildMesh();

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
         1,  1,
        -1, -1,
         1,  1,
        -1,  1
      ]),
      gl.STATIC_DRAW
    );

    const textureA = createStateTexture(gl);
    const textureB = createStateTexture(gl);
    this.stateTextures = [textureA, textureB];
    this.stateFramebuffers = [
      createStateFramebuffer(gl, textureA),
      createStateFramebuffer(gl, textureB)
    ];
    this.maskTexture = createMaskTexture(gl);
    this.depthTexture = createDepthTexture(gl);

    this.initializedResources = true;
    this.uploadBasinMask();
    this.uploadBasinDepth();
    this.resetWaterState();
  },

  rebuildMesh(this: WaterNodeInternal) {
    if (
      !this.meshBuffer ||
      !this.center ||
      this.surfaceElevation === null ||
      !this.waterTransform
    ) {
      return;
    }

    const mesh = createWaterMesh(
      this.view,
      this.center,
      this.size,
      this.surfaceElevation,
      this.waterTransform
    );
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    this.vertexCount = mesh.length / 14;
    this.meshSize = this.size;
  },

  uploadBasinMask(this: WaterNodeInternal) {
    if (!this.maskTexture) {
      return;
    }

    const gl = this.gl;
    const resolution = this.basinResolution;
    const data =
      this.basinMask ??
      new Uint8Array(resolution * resolution).fill(255);

    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      resolution,
      resolution,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      data
    );
  },

  uploadBasinDepth(this: WaterNodeInternal) {
    if (!this.depthTexture) {
      return;
    }

    const gl = this.gl;
    const resolution = this.basinResolution;
    const data =
      this.basinDepth ??
      new Float32Array(resolution * resolution);

    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      resolution,
      resolution,
      0,
      gl.RED,
      gl.FLOAT,
      data
    );
  },

  resetWaterState(this: WaterNodeInternal) {
    const gl = this.gl;
    const previousClear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;

    for (const framebuffer of this.stateFramebuffers) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, WATER_TEXTURE_SIZE, WATER_TEXTURE_SIZE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.clearColor(
      previousClear[0],
      previousClear[1],
      previousClear[2],
      previousClear[3]
    );
    this.activeState = 0;
    this.resetWebGLState();
  },

  runImpactPass(this: WaterNodeInternal) {
    if (
      !this.pendingImpact ||
      !this.impactProgram ||
      !this.quadBuffer
    ) {
      return;
    }

    const gl = this.gl;
    const source = this.activeState;
    const target = 1 - source;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFramebuffers[target]);
    gl.viewport(0, 0, WATER_TEXTURE_SIZE, WATER_TEXTURE_SIZE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.impactProgram);

    const positionLocation = gl.getAttribLocation(
      this.impactProgram,
      "aPosition"
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[source]);
    gl.uniform1i(gl.getUniformLocation(this.impactProgram, "uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(gl.getUniformLocation(this.impactProgram, "uMask"), 1);
    gl.uniform2f(
      gl.getUniformLocation(this.impactProgram, "uCenter"),
      this.pendingImpact.u,
      this.pendingImpact.v
    );
    gl.uniform1f(
      gl.getUniformLocation(this.impactProgram, "uRadius"),
      0.055
    );
    gl.uniform1f(
      gl.getUniformLocation(this.impactProgram, "uStrength"),
      this.pendingImpact.strength
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(positionLocation);

    this.activeState = target;
    this.pendingImpact = null;
  },

  runSimulationStep(this: WaterNodeInternal) {
    if (!this.simulationProgram || !this.quadBuffer) {
      return;
    }

    const gl = this.gl;
    const source = this.activeState;
    const target = 1 - source;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFramebuffers[target]);
    gl.viewport(0, 0, WATER_TEXTURE_SIZE, WATER_TEXTURE_SIZE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.simulationProgram);

    const positionLocation = gl.getAttribLocation(
      this.simulationProgram,
      "aPosition"
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[source]);
    gl.uniform1i(
      gl.getUniformLocation(this.simulationProgram, "uState"),
      0
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(
      gl.getUniformLocation(this.simulationProgram, "uMask"),
      1
    );
    gl.uniform2f(
      gl.getUniformLocation(this.simulationProgram, "uTexel"),
      1 / WATER_TEXTURE_SIZE,
      1 / WATER_TEXTURE_SIZE
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(positionLocation);

    this.activeState = target;
  },

  updateOvertoppingMonitor(this: WaterNodeInternal) {
    if (
      !this.overtoppingCallback ||
      this.damSamples.length === 0 ||
      !this.stateFramebuffers[this.activeState]
    ) {
      return;
    }

    const now = performance.now();
    if (now - this.lastOvertoppingRead < 250) {
      return;
    }
    this.lastOvertoppingRead = now;

    const gl = this.gl;
    const pixels = new Float32Array(
      WATER_TEXTURE_SIZE * WATER_TEXTURE_SIZE * 4
    );

    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      this.stateFramebuffers[this.activeState]
    );
    gl.readPixels(
      0,
      0,
      WATER_TEXTURE_SIZE,
      WATER_TEXTURE_SIZE,
      gl.RGBA,
      gl.FLOAT,
      pixels
    );

    let maxWaveHeight = 0;
    let sourceT: number | null = null;
    let peakSampleIndex = -1;
    const waveHeights = new Float32Array(this.damSamples.length);

    for (let sampleIndex = 0; sampleIndex < this.damSamples.length; sampleIndex += 1) {
      const sample = this.damSamples[sampleIndex];
      const col = Math.min(
        Math.max(Math.floor(sample.u * WATER_TEXTURE_SIZE), 0),
        WATER_TEXTURE_SIZE - 1
      );
      const row = Math.min(
        Math.max(Math.floor(sample.v * WATER_TEXTURE_SIZE), 0),
        WATER_TEXTURE_SIZE - 1
      );
      const index = (row * WATER_TEXTURE_SIZE + col) * 4;
      const waveHeight = pixels[index] ?? 0;
      waveHeights[sampleIndex] = waveHeight;

      if (waveHeight > maxWaveHeight) {
        maxWaveHeight = waveHeight;
        sourceT = sample.t;
        peakSampleIndex = sampleIndex;
      }
    }

    // Use only the contiguous overtopping segment that contains the peak.
    // This avoids inflating the hydraulic source width when isolated crest
    // samples or multiple disconnected wave lobes exceed freeboard.
    let overtoppingStartIndex = -1;
    let overtoppingEndIndex = -1;
    let overtoppingSampleCount = 0;

    if (
      peakSampleIndex >= 0 &&
      waveHeights[peakSampleIndex] > this.damFreeboard
    ) {
      overtoppingStartIndex = peakSampleIndex;
      overtoppingEndIndex = peakSampleIndex;

      while (
        overtoppingStartIndex > 0 &&
        waveHeights[overtoppingStartIndex - 1] > this.damFreeboard
      ) {
        overtoppingStartIndex -= 1;
      }

      while (
        overtoppingEndIndex < this.damSamples.length - 1 &&
        waveHeights[overtoppingEndIndex + 1] > this.damFreeboard
      ) {
        overtoppingEndIndex += 1;
      }

      overtoppingSampleCount =
        overtoppingEndIndex - overtoppingStartIndex + 1;
    }

    const sampleSpacingFraction =
      this.damSamples.length > 1
        ? 1 / (this.damSamples.length - 1)
        : 1;
    const overtoppingWidthFraction =
      overtoppingSampleCount > 0
        ? Math.min(
            Math.max(
              overtoppingSampleCount * sampleSpacingFraction,
              sampleSpacingFraction
            ),
            1
          )
        : 0;

    this.overtoppingCallback({
      overtopping: maxWaveHeight > this.damFreeboard,
      maxWaveHeight,
      freeboard: this.damFreeboard,
      sourceT,
      overtoppingWidthFraction,
      overtoppingSampleCount
    });

    this.resetWebGLState();
  },

  drawWater(this: WaterNodeInternal) {
    if (
      !this.renderProgram ||
      !this.meshBuffer ||
      !this.waterTransform
    ) {
      return;
    }

    const gl = this.gl;
    this.resetWebGLState();
    this.bindRenderTarget();

    if (this.sceneViewport) {
      gl.viewport(
        this.sceneViewport[0],
        this.sceneViewport[1],
        this.sceneViewport[2],
        this.sceneViewport[3]
      );
    }

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.renderProgram);

    const positionLocation = gl.getAttribLocation(
      this.renderProgram,
      "aPosition"
    );
    const uvLocation = gl.getAttribLocation(this.renderProgram, "aUv");
    const upLocation = gl.getAttribLocation(this.renderProgram, "aUp");
    const eastLocation = gl.getAttribLocation(this.renderProgram, "aEast");
    const northLocation = gl.getAttribLocation(this.renderProgram, "aNorth");
    const stride = 14 * 4;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(upLocation);
    gl.vertexAttribPointer(upLocation, 3, gl.FLOAT, false, stride, 5 * 4);
    gl.enableVertexAttribArray(eastLocation);
    gl.vertexAttribPointer(eastLocation, 3, gl.FLOAT, false, stride, 8 * 4);
    gl.enableVertexAttribArray(northLocation);
    gl.vertexAttribPointer(northLocation, 3, gl.FLOAT, false, stride, 11 * 4);

    this.viewMatrix.fromArray(this.camera.viewMatrix);
    this.modelMatrix.fromArray(this.waterTransform);
    this.modelViewMatrix.multiplyMatrices(this.viewMatrix, this.modelMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[this.activeState]);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uMask"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uDepth"), 2);
    gl.uniform1f(
      gl.getUniformLocation(this.renderProgram, "uTime"),
      performance.now()
    );
    gl.uniform2f(
      gl.getUniformLocation(this.renderProgram, "uTexel"),
      1 / WATER_TEXTURE_SIZE,
      1 / WATER_TEXTURE_SIZE
    );
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.renderProgram, "uProjection"),
      false,
      new Float32Array(this.camera.projectionMatrix)
    );
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.renderProgram, "uModelView"),
      false,
      new Float32Array(this.modelViewMatrix.elements)
    );

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.disableVertexAttribArray(positionLocation);
    gl.disableVertexAttribArray(uvLocation);
    gl.disableVertexAttribArray(upLocation);
    gl.disableVertexAttribArray(eastLocation);
    gl.disableVertexAttribArray(northLocation);
    gl.disable(gl.BLEND);
  },

  render(this: WaterNodeInternal) {
    this.resetWebGLState();
    const output = this.bindRenderTarget();
    this.sceneViewport = new Int32Array(
      this.gl.getParameter(this.gl.VIEWPORT) as Int32Array
    );

    if (!this.center || this.surfaceElevation === null) {
      return output;
    }

    const transform = webgl.renderCoordinateTransformAt(
      this.view,
      [this.center.x, this.center.y, this.surfaceElevation],
      this.center.spatialReference,
      new Float64Array(16)
    );
    if (!transform) {
      return output;
    }

    const transformChanged =
      !this.waterTransform ||
      transform.some(
        (value, index) =>
          Math.abs(value - (this.waterTransform?.[index] ?? Number.NaN)) > 1e-6
      );

    if (transformChanged) {
      this.waterTransform = new Float64Array(transform);
      if (this.initializedResources) {
        this.rebuildMesh();
      }
    }

    this.ensureResources();
    this.runImpactPass();

    for (let i = 0; i < WATER_STEPS_PER_FRAME; i += 1) {
      this.runSimulationStep();
    }

    this.updateOvertoppingMonitor();
    this.drawWater();
    this.requestRender();

    return output;
  }
} as any) as any;

export type WaterRenderNode = WaterNodeInternal;

export function createWaterRenderNode(view: SceneView): WaterRenderNode {
  return new WaterRenderNodeClass({ view }) as WaterRenderNode;
}
