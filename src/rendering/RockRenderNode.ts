import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RenderNode from "@arcgis/core/views/3d/webgl/RenderNode";
import * as webgl from "@arcgis/core/views/3d/webgl";
import {
  IcosahedronGeometry,
  Matrix3,
  Matrix4,
  Quaternion
} from "three";

type RotationLike = {
  x: number;
  y: number;
  z: number;
  w: number;
};

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
  poseMatrix: Matrix4;
  rotationMatrix: Matrix4;
  rockQuaternion: Quaternion;
  setRadius(radius: number): void;
  setRock(point: Point): void;
  setRockPose(point: Point, rotation?: RotationLike): void;
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
    out vec3 vLocalPosition;

    void main() {
      vNormal = normalize(uNormalMatrix * aNormal);
      vLocalPosition = aPosition;
      gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;

    in vec3 vNormal;
    in vec3 vLocalPosition;
    uniform vec3 uColor;

    out vec4 fragColor;

    float hash31(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    float valueNoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
      float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
      float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
      float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
      float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
      float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
      float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
      float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

      float nx00 = mix(n000, n100, f.x);
      float nx10 = mix(n010, n110, f.x);
      float nx01 = mix(n001, n101, f.x);
      float nx11 = mix(n011, n111, f.x);
      float nxy0 = mix(nx00, nx10, f.y);
      float nxy1 = mix(nx01, nx11, f.y);

      return mix(nxy0, nxy1, f.z);
    }

    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;

      for (int i = 0; i < 4; i++) {
        value += amplitude * valueNoise(p);
        p = p * 2.03 + vec3(11.7, 7.9, 13.1);
        amplitude *= 0.5;
      }

      return value;
    }

    void main() {
      vec3 normal = normalize(vNormal);
      vec3 lightDirection = normalize(vec3(0.45, 0.65, 0.75));
      float diffuse = max(dot(normal, lightDirection), 0.0);
      float lighting = 0.22 + 0.78 * diffuse;

      vec3 p = vLocalPosition * 0.34;
      float coarse = fbm(p);
      float fine = fbm(p * 3.7 + vec3(4.3, 1.2, 8.1));
      float veins = smoothstep(0.66, 0.86, abs(sin(
        vLocalPosition.x * 0.42 +
        vLocalPosition.y * 0.19 -
        vLocalPosition.z * 0.31 +
        coarse * 4.0
      )));

      vec3 darkStone = vec3(0.17, 0.15, 0.13);
      vec3 warmStone = vec3(0.37, 0.31, 0.24);
      vec3 paleStone = vec3(0.48, 0.45, 0.39);
      vec3 rockColor = mix(darkStone, warmStone, coarse);
      rockColor = mix(rockColor, paleStone, fine * 0.35);
      rockColor = mix(rockColor, vec3(0.12, 0.16, 0.08), smoothstep(0.72, 0.92, coarse) * 0.22);
      rockColor *= mix(0.78, 1.08, fine);
      rockColor = mix(rockColor, vec3(0.62, 0.59, 0.52), veins * 0.16);

      float rim = pow(1.0 - max(normal.z, 0.0), 2.0);
      float roughShade = mix(0.92, 1.05, fine) - rim * 0.05;

      fragColor = vec4(rockColor * lighting * roughShade, 1.0);
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
  poseMatrix: new Matrix4(),
  rotationMatrix: new Matrix4(),
  rockQuaternion: new Quaternion(),

  initialize(this: RockNodeInternal) {
    this.consumes.required.push("opaque-color");
    this.produces = "opaque-color";
  },

  setRadius(this: RockNodeInternal, radius: number) {
    const nextRadius = Math.max(radius, 0.5);
    if (Math.abs(nextRadius - this.radius) < 0.001) {
      return;
    }

    this.radius = nextRadius;

    if (this.initializedResources) {
      const gl = this.gl;
      if (this.positionBuffer) {
        gl.deleteBuffer(this.positionBuffer);
      }
      if (this.normalBuffer) {
        gl.deleteBuffer(this.normalBuffer);
      }
      if (this.program) {
        gl.deleteProgram(this.program);
      }

      this.positionBuffer = null;
      this.normalBuffer = null;
      this.program = null;
      this.initializedResources = false;
      this.vertexCount = 0;
    }

    this.requestRender();
  },

  setRock(this: RockNodeInternal, point: Point) {
    const center = point.clone();
    center.z = (point.z ?? 0) + this.radius;
    this.setRockPose(center);
  },

  setRockPose(
    this: RockNodeInternal,
    point: Point,
    rotation?: RotationLike
  ) {
    const transform = webgl.renderCoordinateTransformAt(
      this.view,
      [point.x, point.y, point.z ?? 0],
      point.spatialReference,
      new Float64Array(16)
    );

    if (!transform) {
      this.rockTransform = null;
      return;
    }

    this.poseMatrix.fromArray(transform);

    if (rotation) {
      this.rockQuaternion.set(
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w
      );

      this.rotationMatrix.makeRotationFromQuaternion(this.rockQuaternion);
      this.poseMatrix.multiply(this.rotationMatrix);
    }

    this.rockTransform = new Float64Array(this.poseMatrix.elements);
    this.requestRender();
  },

  ensureResources(this: RockNodeInternal) {
    if (this.initializedResources) {
      return;
    }

    const gl = this.gl;
    const geometry = new IcosahedronGeometry(this.radius, 2).toNonIndexed();
    const positions = geometry.getAttribute("position");

    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);

      const directionalScale =
        1 +
        0.10 * Math.sin(x * 0.31 + z * 0.17) +
        0.07 * Math.cos(y * 0.27 - x * 0.13);

      positions.setXYZ(
        i,
        x * directionalScale * 1.04,
        y * directionalScale * 0.96,
        z * directionalScale
      );
    }

    geometry.computeVertexNormals();
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
