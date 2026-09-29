import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RenderNode from "@arcgis/core/views/3d/webgl/RenderNode";
import * as webgl from "@arcgis/core/views/3d/webgl";
import {
  IcosahedronGeometry,
  Matrix3,
  Matrix4
} from "three";

type RockNodeInternal = RenderNode & {
  radius: number;
  rockTransform: Float64Array | null;
  program: WebGLProgram | null;
  positionBuffer: WebGLBuffer | null;
  normalBuffer: WebGLBuffer | null;
  vertexCount: number;
  positionLocation: number;
  normalLocation: number;
  projectionLocation: WebGLUniformLocation | null;
  modelViewLocation: WebGLUniformLocation | null;
  normalMatrixLocation: WebGLUniformLocation | null;
  colorLocation: WebGLUniformLocation | null;
  initializedResources: boolean;
  viewMatrix: Matrix4;
  modelMatrix: Matrix4;
  modelViewMatrix: Matrix4;
  normalMatrix: Matrix3;
  setRock(point: Point): void;
  ensureResources(): void;
};

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create WebGL shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexSource = `#version 300 es
    precision highp float;

    in vec3 aPosition;
    in vec3 aNormal;

    uniform mat4 uProjection;
    uniform mat4 uModelView;
    uniform mat3 uNormalMatrix;

    out vec3 vNormal;

    void main() {
      vNormal = normalize(uNormalMatrix * aNormal);
      gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;

    in vec3 vNormal;
    uniform vec3 uColor;

    out vec4 fragColor;

    void main() {
      vec3 lightDirection = normalize(vec3(0.45, 0.65, 0.75));
      float diffuse = max(dot(normalize(vNormal), lightDirection), 0.0);
      float lighting = 0.28 + 0.72 * diffuse;
      fragColor = vec4(uColor * lighting, 1.0);
    }
  `;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  if (!program) {
    throw new Error("Unable to create WebGL program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

const RockRenderNodeClass = RenderNode.createSubclass({
  declaredClass: "geodynamics.rendering.RockRenderNode",

  radius: 9,
  rockTransform: null,
  program: null,
  positionBuffer: null,
  normalBuffer: null,
  vertexCount: 0,
  positionLocation: -1,
  normalLocation: -1,
  projectionLocation: null,
  modelViewLocation: null,
  normalMatrixLocation: null,
  colorLocation: null,
  initializedResources: false,

  viewMatrix: new Matrix4(),
  modelMatrix: new Matrix4(),
  modelViewMatrix: new Matrix4(),
  normalMatrix: new Matrix3(),

  initialize(this: RockNodeInternal) {
    this.consumes.required.push("opaque-color");
    this.produces = "opaque-color";
  },

  setRock(this: RockNodeInternal, point: Point) {
    const z = (point.z ?? 0) + this.radius;
    const position = [point.x, point.y, z];

    this.rockTransform = webgl.renderCoordinateTransformAt(
      this.view,
      position,
      point.spatialReference,
      new Float64Array(16)
    ) ?? null;

    this.requestRender();
  },

  ensureResources(this: RockNodeInternal) {
    if (this.initializedResources) {
      return;
    }

    const gl = this.gl;
    const geometry = new IcosahedronGeometry(this.radius, 2).toNonIndexed();
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");

    this.program = createProgram(gl);
    this.positionLocation = gl.getAttribLocation(this.program, "aPosition");
    this.normalLocation = gl.getAttribLocation(this.program, "aNormal");
    this.projectionLocation = gl.getUniformLocation(this.program, "uProjection");
    this.modelViewLocation = gl.getUniformLocation(this.program, "uModelView");
    this.normalMatrixLocation = gl.getUniformLocation(this.program, "uNormalMatrix");
    this.colorLocation = gl.getUniformLocation(this.program, "uColor");

    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(positions.array as ArrayLike<number>),
      gl.STATIC_DRAW
    );

    this.normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(normals.array as ArrayLike<number>),
      gl.STATIC_DRAW
    );

    this.vertexCount = positions.count;
    this.initializedResources = true;
    geometry.dispose();
  },

  render(this: RockNodeInternal) {
    this.resetWebGLState();
    const output = this.bindRenderTarget();

    if (!this.rockTransform) {
      return output;
    }

    this.ensureResources();

    const gl = this.gl;
    if (!this.program || !this.positionBuffer || !this.normalBuffer) {
      return output;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(this.normalLocation);
    gl.vertexAttribPointer(this.normalLocation, 3, gl.FLOAT, false, 0, 0);

    this.viewMatrix.fromArray(this.camera.viewMatrix);
    this.modelMatrix.fromArray(this.rockTransform);
    this.modelViewMatrix.multiplyMatrices(this.viewMatrix, this.modelMatrix);
    this.normalMatrix.getNormalMatrix(this.modelViewMatrix);

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
    gl.uniformMatrix3fv(
      this.normalMatrixLocation,
      false,
      new Float32Array(this.normalMatrix.elements)
    );
    gl.uniform3f(this.colorLocation, 0.36, 0.20, 0.10);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.positionLocation);
    gl.disableVertexAttribArray(this.normalLocation);

    return output;
  }
} as any) as any;

export type RockRenderNode = RockNodeInternal;

export function createRockRenderNode(view: SceneView): RockRenderNode {
  return new RockRenderNodeClass({ view }) as RockRenderNode;
}
