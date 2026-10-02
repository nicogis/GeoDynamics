import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RenderNode from "@arcgis/core/views/3d/webgl/RenderNode";
import * as webgl from "@arcgis/core/views/3d/webgl";
import { Matrix4 } from "three";

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
  basinMask: Uint8Array | null;
  basinResolution: number;
  activeState: number;
  vertexCount: number;
  initializedResources: boolean;
  meshSize: number;
  size: number;
  center: Point | null;
  surfaceElevation: number | null;
  pendingImpact: { u: number; v: number; strength: number } | null;
  sceneViewport: Int32Array | null;
  viewMatrix: Matrix4;
  modelMatrix: Matrix4;
  modelViewMatrix: Matrix4;
  setBasin(
    center: Point,
    size: number,
    elevation: number,
    mask: Uint8Array,
    resolution: number
  ): void;
  containsPoint(point: Point): boolean;
  addImpact(point: Point, speed: number): void;
  getSurface(): { center: Point; size: number; elevation: number } | null;
  ensureResources(): void;
  rebuildMesh(): void;
  uploadBasinMask(): void;
  resetWaterState(): void;
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

function createWaterMesh(size: number): Float32Array {
  const half = size / 2;
  const cells = WATER_GRID_RESOLUTION;
  const data = new Float32Array(cells * cells * 6 * 4);
  let offset = 0;

  const writeVertex = (col: number, row: number) => {
    const u = col / cells;
    const v = row / cells;
    data[offset++] = -half + u * size;
    data[offset++] = -half + v * size;
    data[offset++] = u;
    data[offset++] = v;
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

  in vec2 aPosition;
  in vec2 aUv;

  uniform sampler2D uState;
  uniform sampler2D uMask;
  uniform mat4 uProjection;
  uniform mat4 uModelView;
  uniform vec2 uTexel;

  out float vHeight;
  out vec2 vUv;
  out vec3 vNormal;

  void main() {
    float height = texture(uState, aUv).r;
    vUv = aUv;
    float left = texture(uState, aUv - vec2(uTexel.x, 0.0)).r;
    float right = texture(uState, aUv + vec2(uTexel.x, 0.0)).r;
    float down = texture(uState, aUv - vec2(0.0, uTexel.y)).r;
    float up = texture(uState, aUv + vec2(0.0, uTexel.y)).r;

    vec3 p = vec3(aPosition, height);
    vHeight = height;

    // Exaggerate the visual slope a little. The simulated height remains
    // untouched; this only makes wave normals easier to read at GIS scales.
    vec2 slope = vec2(left - right, down - up) * 3.2;
    vNormal = normalize(vec3(slope, 1.35));

    gl_Position = uProjection * uModelView * vec4(p, 1.0);
  }
`;

const renderFragmentSource = `#version 300 es
  precision highp float;

  uniform sampler2D uMask;

  in float vHeight;
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
    float specular = pow(max(dot(normal, halfVector), 0.0), 28.0);
    float slope = clamp(length(normal.xy) * 1.8, 0.0, 1.0);

    vec3 troughColor = vec3(0.018, 0.10, 0.18);
    vec3 baseColor = vec3(0.025, 0.22, 0.32);
    vec3 crestColor = vec3(0.30, 0.72, 0.78);

    float positiveCrest = smoothstep(0.08, 1.4, vHeight);
    float negativeTrough = smoothstep(0.08, 1.2, -vHeight);

    vec3 color = baseColor;
    color = mix(color, crestColor, positiveCrest * 0.72);
    color = mix(color, troughColor, negativeTrough * 0.78);

    // The slope term makes moving wave fronts visible even when the height
    // difference itself is small.
    color += slope * vec3(0.05, 0.12, 0.15);
    color *= 0.78 + diffuse * 0.32;
    color += specular * vec3(0.65, 0.80, 0.85);

    fragColor = vec4(color, 0.82);
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
  basinMask: null,
  basinResolution: WATER_TEXTURE_SIZE,
  activeState: 0,
  vertexCount: 0,
  initializedResources: false,
  meshSize: 0,
  size: 420,
  center: null,
  surfaceElevation: null,
  pendingImpact: null,
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
    resolution: number
  ) {
    this.size = size;
    this.center = center.clone();
    this.surfaceElevation = elevation;
    this.basinMask = mask.slice();
    this.basinResolution = resolution;

    const surfacePoint = center.clone();
    surfacePoint.z = elevation;

    const transform = webgl.renderCoordinateTransformAt(
      this.view,
      [surfacePoint.x, surfacePoint.y, surfacePoint.z ?? 0],
      surfacePoint.spatialReference,
      new Float64Array(16)
    );

    this.waterTransform = transform ?? null;
    this.pendingImpact = null;

    if (this.initializedResources) {
      if (this.meshSize !== this.size) {
        this.rebuildMesh();
      }
      this.uploadBasinMask();
      this.resetWaterState();
    }

    this.requestRender();
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

    this.initializedResources = true;
    this.uploadBasinMask();
    this.resetWaterState();
  },

  rebuildMesh(this: WaterNodeInternal) {
    if (!this.meshBuffer) {
      return;
    }

    const mesh = createWaterMesh(this.size);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    this.vertexCount = mesh.length / 4;
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

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);

    this.viewMatrix.fromArray(this.camera.viewMatrix);
    this.modelMatrix.fromArray(this.waterTransform);
    this.modelViewMatrix.multiplyMatrices(this.viewMatrix, this.modelMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[this.activeState]);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, "uMask"), 1);
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
    gl.disable(gl.BLEND);
  },

  render(this: WaterNodeInternal) {
    this.resetWebGLState();
    const output = this.bindRenderTarget();
    this.sceneViewport = new Int32Array(
      this.gl.getParameter(this.gl.VIEWPORT) as Int32Array
    );

    if (!this.waterTransform) {
      return output;
    }

    this.ensureResources();
    this.runImpactPass();

    for (let i = 0; i < WATER_STEPS_PER_FRAME; i += 1) {
      this.runSimulationStep();
    }

    this.drawWater();
    this.requestRender();

    return output;
  }
} as any) as any;

export type WaterRenderNode = WaterNodeInternal;

export function createWaterRenderNode(view: SceneView): WaterRenderNode {
  return new WaterRenderNodeClass({ view }) as WaterRenderNode;
}
