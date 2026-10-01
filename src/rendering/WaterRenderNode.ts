import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RenderNode from "@arcgis/core/views/3d/webgl/RenderNode";
import * as webgl from "@arcgis/core/views/3d/webgl";
import { Matrix4 } from "three";

type WaterNodeInternal = RenderNode & {
  waterTransform: Float64Array | null;
  program: WebGLProgram | null;
  positionBuffer: WebGLBuffer | null;
  vertexCount: number;
  positionLocation: number;
  projectionLocation: WebGLUniformLocation | null;
  modelViewLocation: WebGLUniformLocation | null;
  timeLocation: WebGLUniformLocation | null;
  initializedResources: boolean;
  size: number;
  viewMatrix: Matrix4;
  modelMatrix: Matrix4;
  modelViewMatrix: Matrix4;
  setWater(center: Point, size?: number): void;
  ensureResources(): void;
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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexSource = `#version 300 es
    precision highp float;

    in vec3 aPosition;

    uniform mat4 uProjection;
    uniform mat4 uModelView;
    uniform float uTime;

    out float vWave;

    void main() {
      vec3 p = aPosition;
      float wave =
        sin((p.x + uTime * 5.0) * 0.045) * 0.55 +
        cos((p.y - uTime * 3.2) * 0.038) * 0.35;

      p.z += wave;
      vWave = wave;

      gl_Position = uProjection * uModelView * vec4(p, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;

    in float vWave;
    out vec4 fragColor;

    void main() {
      vec3 deep = vec3(0.03, 0.18, 0.28);
      vec3 shallow = vec3(0.10, 0.42, 0.52);
      float t = clamp(vWave * 0.35 + 0.5, 0.0, 1.0);
      vec3 color = mix(deep, shallow, t);
      fragColor = vec4(color, 0.72);
    }
  `;

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
    const message = gl.getProgramInfoLog(program) ?? "Unknown water program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

const WaterRenderNodeClass = RenderNode.createSubclass({
  declaredClass: "geodynamics.rendering.WaterRenderNode",

  waterTransform: null,
  program: null,
  positionBuffer: null,
  vertexCount: 0,
  positionLocation: -1,
  projectionLocation: null,
  modelViewLocation: null,
  timeLocation: null,
  initializedResources: false,
  size: 420,

  viewMatrix: new Matrix4(),
  modelMatrix: new Matrix4(),
  modelViewMatrix: new Matrix4(),

  initialize(this: WaterNodeInternal) {
    this.consumes.required.push("opaque-color");
    this.produces = "opaque-color";
  },

  setWater(this: WaterNodeInternal, center: Point, size = 420) {
    this.size = size;

    const surfacePoint = center.clone();
    surfacePoint.z = (surfacePoint.z ?? 0) + 4;

    const transform = webgl.renderCoordinateTransformAt(
      this.view,
      [surfacePoint.x, surfacePoint.y, surfacePoint.z ?? 0],
      surfacePoint.spatialReference,
      new Float64Array(16)
    );

    this.waterTransform = transform ?? null;
    this.requestRender();
  },

  ensureResources(this: WaterNodeInternal) {
    if (this.initializedResources) {
      return;
    }

    const gl = this.gl;
    const half = this.size / 2;
    const vertices = new Float32Array([
      -half, -half, 0,
       half, -half, 0,
       half,  half, 0,
      -half, -half, 0,
       half,  half, 0,
      -half,  half, 0
    ]);

    this.program = createProgram(gl);
    this.positionLocation = gl.getAttribLocation(this.program, "aPosition");
    this.projectionLocation = gl.getUniformLocation(this.program, "uProjection");
    this.modelViewLocation = gl.getUniformLocation(this.program, "uModelView");
    this.timeLocation = gl.getUniformLocation(this.program, "uTime");

    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.vertexCount = 6;
    this.initializedResources = true;
  },

  render(this: WaterNodeInternal) {
    this.resetWebGLState();
    const output = this.bindRenderTarget();

    if (!this.waterTransform) {
      return output;
    }

    this.ensureResources();

    const gl = this.gl;
    if (!this.program || !this.positionBuffer) {
      return output;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 3, gl.FLOAT, false, 0, 0);

    this.viewMatrix.fromArray(this.camera.viewMatrix);
    this.modelMatrix.fromArray(this.waterTransform);
    this.modelViewMatrix.multiplyMatrices(this.viewMatrix, this.modelMatrix);

    gl.uniformMatrix4fv(
      this.projectionLocation,
      false,
      new Float32Array(this.camera.projectionMatrix)
    );
    gl.uniformMatrix4fv(
      this.modelViewLocation,
      false,
      new Float32Array(this.modelViewMatrix.elements)
    );
    gl.uniform1f(this.timeLocation, performance.now() / 1000);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.positionLocation);
    gl.disable(gl.BLEND);

    this.requestRender();
    return output;
  }
} as any) as any;

export type WaterRenderNode = WaterNodeInternal;

export function createWaterRenderNode(view: SceneView): WaterRenderNode {
  return new WaterRenderNodeClass({ view }) as WaterRenderNode;
}
