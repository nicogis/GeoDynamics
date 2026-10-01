import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";
import RAPIER from "@dimforge/rapier3d-compat";

import type { RockRenderNode } from "../rendering/RockRenderNode";
import { sampleTerrainMesh } from "../physics/TerrainHeightfield";

const ROCK_RADIUS = 9;
const RELEASE_HEIGHT = 30;
const FIXED_TIMESTEP = 1 / 60;

type StatusWriter = (message: string) => void;

export class RockfallSimulation {
  private readonly rapierReady = RAPIER.init();
  private readonly view: SceneView;
  private readonly rockNode: RockRenderNode;
  private readonly writeStatus: StatusWriter;

  private world: RAPIER.World | null = null;
  private body: RAPIER.RigidBody | null = null;
  private origin: Point | null = null;

  private runId = 0;
  private frameId: number | null = null;
  private previousFrameTime = 0;
  private accumulator = 0;
  private lastStatusUpdate = 0;

  constructor(
    view: SceneView,
    rockNode: RockRenderNode,
    writeStatus: StatusWriter
  ) {
    this.view = view;
    this.rockNode = rockNode;
    this.writeStatus = writeStatus;
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

    world.createCollider(
      RAPIER.ColliderDesc.ball(ROCK_RADIUS)
        .setDensity(2.6)
        .setFriction(0.8)
        .setRestitution(0.12),
      body
    );

    this.world = world;
    this.body = body;
    this.origin = terrain.origin;
    this.previousFrameTime = performance.now();
    this.accumulator = 0;
    this.lastStatusUpdate = 0;

    const triangles = terrain.indices.length / 3;

    this.writeStatus(
      `Rapier ready — terrain ${terrain.span.toFixed(0)} m × ${terrain.span.toFixed(0)} m, ${terrain.rows}×${terrain.cols} samples, ${triangles} triangles. Rock released ${RELEASE_HEIGHT} m above ground.`
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

      if (time - this.lastStatusUpdate > 250) {
        const velocity = this.body.linvel();
        const speed = Math.hypot(velocity.x, velocity.y, velocity.z);

        this.writeStatus(
          `Rockfall — z ${point.z?.toFixed(1) ?? "n/a"} m · speed ${speed.toFixed(1)} m/s`
        );

        this.lastStatusUpdate = time;
      }

      const horizontalDistance = Math.hypot(translation.x, translation.z);
      if (
        horizontalDistance > 500 ||
        translation.y < -500
      ) {
        this.writeStatus(
          "Rock left the sampled physics area. Click the terrain to start a new simulation."
        );
        this.stopAnimation();
        return;
      }

      this.frameId = requestAnimationFrame(tick);
    };

    this.frameId = requestAnimationFrame(tick);
  }

  private stopAnimation(): void {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }
}
