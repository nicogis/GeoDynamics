import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RAPIER from "@dimforge/rapier3d-compat";

import type { RockRenderNode } from "../rendering/RockRenderNode";
import { sampleTerrainMesh } from "../physics/TerrainHeightfield";

const ROCK_RADIUS = 9;
const ROCK_DENSITY = 2600;

const ROCK_HULL_VERTICES = new Float32Array([
  -8.5, -6.5, -5.5,
   7.8, -7.2, -4.2,
   8.9,  5.8, -3.8,
  -7.2,  7.6, -4.7,
  -6.1, -5.4,  7.9,
   6.9, -4.8,  8.6,
   7.1,  6.7,  6.3,
  -8.8,  5.9,  5.1,
   0.8,  9.4,  0.6,
  -0.7, -9.0,  1.1,
   9.5,  0.9,  1.8,
  -9.2, -0.6, -0.8
]);
const RELEASE_HEIGHT = 30;
const FIXED_TIMESTEP = 1 / 60;
const TRAJECTORY_MIN_STEP = 5;
const STATUS_INTERVAL_MS = 250;
const REST_SPEED_THRESHOLD = 0.35;
const REST_DURATION_SECONDS = 2.5;

type StatusWriter = (message: string) => void;

export interface RockfallTelemetry {
  elapsedSeconds: number;
  horizontalDistance: number;
  totalDistance: number;
  maxSpeed: number;
  currentSpeed: number;
}

export interface RockfallResult {
  point: Point;
  elapsedSeconds: number;
  horizontalDistance: number;
  totalDistance: number;
  elevationDrop: number;
  maxSpeed: number;
  rockMassKg: number;
  peakKineticEnergyJ: number;
  reason: "rested" | "boundary" | "fell-below-domain";
}

export type TrajectoryWriter = (
  points: number[][],
  telemetry: RockfallTelemetry
) => void;

export type ResultWriter = (result: RockfallResult) => void;

export class RockfallSimulation {
  private readonly rapierReady = RAPIER.init();
  private readonly view: SceneView;
  private readonly rockNode: RockRenderNode;
  private readonly writeStatus: StatusWriter;
  private readonly writeTrajectory: TrajectoryWriter;
  private readonly writeResult: ResultWriter;

  private world: RAPIER.World | null = null;
  private body: RAPIER.RigidBody | null = null;
  private origin: Point | null = null;
  private terrainSpan = 0;

  private runId = 0;
  private frameId: number | null = null;
  private previousFrameTime = 0;
  private accumulator = 0;
  private lastStatusUpdate = 0;
  private elapsedSeconds = 0;
  private maxSpeed = 0;
  private totalDistance = 0;
  private restSeconds = 0;
  private trajectoryPoints: number[][] = [];
  private lastTrajectoryPoint: Point | null = null;

  constructor(
    view: SceneView,
    rockNode: RockRenderNode,
    writeStatus: StatusWriter,
    writeTrajectory: TrajectoryWriter,
    writeResult: ResultWriter
  ) {
    this.view = view;
    this.rockNode = rockNode;
    this.writeStatus = writeStatus;
    this.writeTrajectory = writeTrajectory;
    this.writeResult = writeResult;
  }

  async release(point: Point): Promise<void> {
    const runId = ++this.runId;
    this.stopAnimation();

    this.writeStatus("Sampling ArcGIS terrain around the release point...");

    await this.rapierReady;

    const terrain = await sampleTerrainMesh(this.view, point);

    if (runId !== this.runId) {
      return;
    }

    this.world?.free();

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = FIXED_TIMESTEP;

    const terrainCollider = RAPIER.ColliderDesc.trimesh(
      terrain.vertices,
      terrain.indices
    )
      .setFriction(0.9)
      .setRestitution(0.05);

    world.createCollider(terrainCollider);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(
        0,
        ROCK_RADIUS + RELEASE_HEIGHT,
        0
      )
    );

    const rockCollider = RAPIER.ColliderDesc.convexHull(ROCK_HULL_VERTICES);

    if (!rockCollider) {
      throw new Error("Unable to create the irregular rock convex hull.");
    }

    world.createCollider(
      rockCollider
        .setDensity(ROCK_DENSITY)
        .setFriction(0.8)
        .setRestitution(0.12),
      body
    );

    this.world = world;
    this.body = body;
    this.origin = terrain.origin;
    this.terrainSpan = terrain.span;
    this.previousFrameTime = performance.now();
    this.accumulator = 0;
    this.lastStatusUpdate = 0;
    this.elapsedSeconds = 0;
    this.maxSpeed = 0;
    this.totalDistance = 0;
    this.restSeconds = 0;
    this.trajectoryPoints = [];
    this.lastTrajectoryPoint = null;

    const triangles = terrain.indices.length / 3;

    this.writeStatus(
      `Rapier ready — terrain ${terrain.span.toFixed(0)} m × ${terrain.span.toFixed(0)} m, ${terrain.rows}×${terrain.cols} samples, ${triangles} triangles. Irregular convex rock released ${RELEASE_HEIGHT} m above ground.`
    );

    this.animate(runId);
  }

  private animate(runId: number): void {
    const tick = (time: number) => {
      if (
        runId !== this.runId ||
        !this.world ||
        !this.body ||
        !this.origin
      ) {
        return;
      }

      const frameDelta = Math.min(
        Math.max((time - this.previousFrameTime) / 1000, 0),
        0.1
      );

      this.previousFrameTime = time;
      this.accumulator += frameDelta;
      this.elapsedSeconds += frameDelta;

      while (this.accumulator >= FIXED_TIMESTEP) {
        this.world.step();
        this.accumulator -= FIXED_TIMESTEP;
      }

      const translation = this.body.translation();
      const rotation = this.body.rotation();

      const point = new Point({
        x: this.origin.x + translation.x,
        y: this.origin.y + translation.z,
        z: (this.origin.z ?? 0) + translation.y,
        spatialReference: this.origin.spatialReference
      });

      this.rockNode.setRockPose(point, rotation);

      const velocity = this.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      this.maxSpeed = Math.max(this.maxSpeed, speed);

      if (speed < REST_SPEED_THRESHOLD && this.elapsedSeconds > 2) {
        this.restSeconds += frameDelta;
      } else {
        this.restSeconds = 0;
      }

      const horizontalDistance = Math.hypot(translation.x, translation.z);
      this.captureTrajectory(point, {
        elapsedSeconds: this.elapsedSeconds,
        horizontalDistance,
        totalDistance: this.totalDistance,
        maxSpeed: this.maxSpeed,
        currentSpeed: speed
      });

      if (time - this.lastStatusUpdate > STATUS_INTERVAL_MS) {
        this.writeStatus(
          `Rockfall — z ${point.z?.toFixed(1) ?? "n/a"} m · speed ${speed.toFixed(1)} m/s · runout ${horizontalDistance.toFixed(0)} m · path ${this.totalDistance.toFixed(0)} m`
        );

        this.lastStatusUpdate = time;
      }

      const boundary = Math.max(this.terrainSpan / 2 - 75, 100);

      if (this.restSeconds >= REST_DURATION_SECONDS) {
        this.completeSimulation(point, horizontalDistance, "rested");
        return;
      }

      if (horizontalDistance > boundary) {
        this.completeSimulation(point, horizontalDistance, "boundary");
        return;
      }

      if (translation.y < -1000) {
        this.completeSimulation(point, horizontalDistance, "fell-below-domain");
        return;
      }

      this.frameId = requestAnimationFrame(tick);
    };

    this.frameId = requestAnimationFrame(tick);
  }

  private captureTrajectory(point: Point, telemetry: RockfallTelemetry): void {
    if (!this.lastTrajectoryPoint) {
      this.lastTrajectoryPoint = point.clone();
      this.trajectoryPoints = [[point.x, point.y, point.z ?? 0]];
      this.writeTrajectory(this.trajectoryPoints, telemetry);
      return;
    }

    const dx = point.x - this.lastTrajectoryPoint.x;
    const dy = point.y - this.lastTrajectoryPoint.y;
    const dz = (point.z ?? 0) - (this.lastTrajectoryPoint.z ?? 0);
    const distance = Math.hypot(dx, dy, dz);

    if (distance < TRAJECTORY_MIN_STEP) {
      return;
    }

    this.totalDistance += distance;
    this.lastTrajectoryPoint = point.clone();
    this.trajectoryPoints.push([point.x, point.y, point.z ?? 0]);

    this.writeTrajectory(this.trajectoryPoints, {
      ...telemetry,
      totalDistance: this.totalDistance
    });
  }

  private completeSimulation(
    point: Point,
    horizontalDistance: number,
    reason: RockfallResult["reason"]
  ): void {
    if (!this.origin) {
      return;
    }

    const rockVolume = (4 / 3) * Math.PI * ROCK_RADIUS ** 3;
    const rockMassKg = rockVolume * ROCK_DENSITY;
    const peakKineticEnergyJ = 0.5 * rockMassKg * this.maxSpeed ** 2;
    const elevationDrop = (this.origin.z ?? 0) - (point.z ?? 0);

    const result: RockfallResult = {
      point: point.clone(),
      elapsedSeconds: this.elapsedSeconds,
      horizontalDistance,
      totalDistance: this.totalDistance,
      elevationDrop,
      maxSpeed: this.maxSpeed,
      rockMassKg,
      peakKineticEnergyJ,
      reason
    };

    this.writeResult(result);

    this.writeStatus(
      `Simulation complete — runout ${horizontalDistance.toFixed(0)} m · path ${this.totalDistance.toFixed(0)} m · drop ${elevationDrop.toFixed(0)} m · max speed ${this.maxSpeed.toFixed(1)} m/s · peak KE ${(peakKineticEnergyJ / 1_000_000).toFixed(1)} MJ.`
    );

    this.stopAnimation();
  }

  private stopAnimation(): void {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }
}
