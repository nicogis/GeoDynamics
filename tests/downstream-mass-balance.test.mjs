import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceConservativeFlowStep,
  auditMassBalance,
  drainOutletBoundary,
  expectedTriangularHydrographVolumeM3,
  triangularHydrographFactor
} from "../.test-dist/src/physics/DownstreamSolverCore.js";

const GRAVITY = 9.81;
const MANNING_N = 0.045;
const MIN_WET_DEPTH_M = 0.03;

function options(resolutionX, resolutionY, cellSize = 20, dtSeconds = 1) {
  return {
    resolutionX,
    resolutionY,
    cellSize,
    dtSeconds,
    gravity: GRAVITY,
    manningN: MANNING_N,
    minWetDepthM: MIN_WET_DEPTH_M
  };
}

function sumVolume(depth, cellArea) {
  let total = 0;
  for (const value of depth) total += Math.max(value, 0) * cellArea;
  return total;
}

test("closed conservative step preserves total water volume", () => {
  const resolutionX = 32;
  const resolutionY = 32;
  const cellSize = 20;
  const count = resolutionX * resolutionY;
  const terrain = new Float32Array(count);
  const depth = new Float32Array(count);
  const nextDepth = new Float32Array(count);
  const maxVelocity = new Float32Array(count);

  for (let row = 0; row < resolutionY; row += 1) {
    for (let col = 0; col < resolutionX; col += 1) {
      const i = row * resolutionX + col;
      terrain[i] =
        120 +
        Math.abs(col - resolutionX / 2) * 0.12 +
        Math.abs(row - resolutionY / 2) * 0.08;
    }
  }

  depth[(resolutionY / 2) * resolutionX + resolutionX / 2] = 3.5;
  const before = sumVolume(depth, cellSize * cellSize);

  let current = depth;
  let next = nextDepth;
  const stepOptions = options(resolutionX, resolutionY, cellSize, 1);

  for (let step = 0; step < 400; step += 1) {
    advanceConservativeFlowStep(
      current,
      next,
      terrain,
      maxVelocity,
      stepOptions
    );
    const swap = current;
    current = next;
    next = swap;
  }

  const after = sumVolume(current, cellSize * cellSize);
  const relativeError = Math.abs(after - before) / before;

  assert.ok(
    relativeError < 2e-5,
    `closed-grid volume drift too large: ${relativeError}`
  );
});

test("tracked outlet drainage closes the mass balance", () => {
  const resolutionX = 40;
  const resolutionY = 24;
  const cellSize = 20;
  const count = resolutionX * resolutionY;
  const terrain = new Float32Array(count);
  const depthA = new Float32Array(count);
  const depthB = new Float32Array(count);
  const maxVelocity = new Float32Array(count);
  const stepOptions = options(resolutionX, resolutionY, cellSize, 1);

  for (let row = 0; row < resolutionY; row += 1) {
    for (let col = 0; col < resolutionX; col += 1) {
      terrain[row * resolutionX + col] =
        150 - col * 0.7 + Math.abs(row - resolutionY / 2) * 0.04;
    }
  }

  let current = depthA;
  let next = depthB;
  let inputVolumeM3 = 0;
  let outflowVolumeM3 = 0;
  const cellArea = cellSize * cellSize;
  const sourceIndex =
    Math.floor(resolutionY / 2) * resolutionX + 4;

  for (let step = 0; step < 900; step += 1) {
    if (step < 120) {
      const injectedVolume = 18;
      current[sourceIndex] += injectedVolume / cellArea;
      inputVolumeM3 += injectedVolume;
    }

    advanceConservativeFlowStep(
      current,
      next,
      terrain,
      maxVelocity,
      stepOptions
    );

    const boundary = drainOutletBoundary(
      next,
      terrain,
      stepOptions,
      "right"
    );
    outflowVolumeM3 += boundary.outflowVolumeM3;

    const swap = current;
    current = next;
    next = swap;
  }

  const audit = auditMassBalance(
    inputVolumeM3,
    outflowVolumeM3,
    current,
    cellArea
  );

  assert.ok(
    audit.errorPct < 0.02,
    `mass-balance error too large: ${audit.errorPct}% (${audit.residualVolumeM3} m3)`
  );
  assert.ok(audit.storedVolumeM3 >= 0);
  assert.ok(outflowVolumeM3 >= 0);
});

test("mass conservation remains stable across raster resolutions", () => {
  for (const resolution of [24, 48, 96]) {
    const cellSize = 20;
    const count = resolution * resolution;
    const terrain = new Float32Array(count);
    const current = new Float32Array(count);
    const next = new Float32Array(count);
    const velocity = new Float32Array(count);

    for (let row = 0; row < resolution; row += 1) {
      for (let col = 0; col < resolution; col += 1) {
        terrain[row * resolution + col] =
          100 - col * 0.25 + Math.abs(row - resolution / 2) * 0.03;
      }
    }

    const source = Math.floor(resolution / 2) * resolution + 3;
    current[source] = 2.25;
    const cellArea = cellSize * cellSize;
    const inputVolume = current[source] * cellArea;

    let a = current;
    let b = next;
    const stepOptions = options(resolution, resolution, cellSize, 1);
    let outflow = 0;

    for (let step = 0; step < 300; step += 1) {
      advanceConservativeFlowStep(a, b, terrain, velocity, stepOptions);
      const drained = drainOutletBoundary(
        b,
        terrain,
        stepOptions,
        "right"
      );
      outflow += drained.outflowVolumeM3;
      const swap = a;
      a = b;
      b = swap;
    }

    const audit = auditMassBalance(inputVolume, outflow, a, cellArea);
    assert.ok(
      audit.errorPct < 0.02,
      `resolution ${resolution}: mass error ${audit.errorPct}%`
    );
  }
});

test("triangular hydrograph integrates to half peak times duration", () => {
  const peak = 25;
  const duration = 180;
  const expected = expectedTriangularHydrographVolumeM3(peak, duration);
  assert.equal(expected, 2250);

  const dt = 0.1;
  let integrated = 0;
  for (let time = 0; time <= duration; time += dt) {
    integrated +=
      peak * triangularHydrographFactor(time, duration) * dt;
  }

  const errorPct = Math.abs(integrated - expected) / expected * 100;
  assert.ok(errorPct < 0.1, `hydrograph integration error ${errorPct}%`);
});

test("hydrograph factor is zero outside event and peaks at one", () => {
  assert.equal(triangularHydrographFactor(-1, 100), 0);
  assert.equal(triangularHydrographFactor(101, 100), 0);
  assert.ok(Math.abs(triangularHydrographFactor(35, 100) - 1) < 1e-12);
  assert.equal(triangularHydrographFactor(0, 100), 0);
  assert.equal(triangularHydrographFactor(100, 100), 0);
});
