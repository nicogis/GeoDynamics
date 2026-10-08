import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceSwe2D,
  computeSwe2DVolumeM3,
  createSwe2DState,
  validateSwe2DState
} from "../.test-dist/src/physics/ShallowWater2D.js";
import {
  computeErrorNorms,
  computeMirrorSymmetryMetrics,
  computeRadialSymmetrySpread,
  estimateObservedOrder,
  ritterDamBreakDepth
} from "../.test-dist/src/physics/Swe2DBenchmarks.js";

function flatGrid(nx, ny, dx, dy = dx) {
  return {
    nx,
    ny,
    dx,
    dy,
    bed: new Float64Array(nx * ny)
  };
}

function runRitterBenchmark(nx, targetTimeS = 6) {
  const ny = 6;
  const length = 480;
  const dx = length / nx;
  const grid = flatGrid(nx, ny, dx);
  const state = createSwe2DState(nx * ny);
  const upstreamDepth = 2;
  const damX = length * 0.4;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const x = (col + 0.5) * dx;
      state.h[row * nx + col] = x < damX ? upstreamDepth : 0;
    }
  }

  let time = 0;
  while (time < targetTimeS) {
    const diagnostics = advanceSwe2D(state, grid, {
      cfl: 0.32,
      dryDepth: 1e-6,
      maxDtSeconds: Math.min(0.2, targetTimeS - time)
    });
    time += diagnostics.dtSeconds;

    if (time > targetTimeS + 0.2) {
      break;
    }
  }

  const numerical = [];
  const reference = [];

  const sampleRow = Math.floor(ny / 2);
  for (let col = 4; col < nx - 4; col += 1) {
    const x = (col + 0.5) * dx - damX;
    numerical.push(state.h[sampleRow * nx + col]);
    reference.push(
      ritterDamBreakDepth(x, time, upstreamDepth)
    );
  }

  return {
    norms: computeErrorNorms(numerical, reference),
    state,
    grid,
    time
  };
}

test("Ritter dry-bed dam-break error decreases with refinement", () => {
  const coarse = runRitterBenchmark(120);
  const medium = runRitterBenchmark(240);
  const fine = runRitterBenchmark(480);

  assert.ok(
    medium.norms.l1 < coarse.norms.l1,
    `120->240 did not reduce L1: ${coarse.norms.l1} -> ${medium.norms.l1}`
  );
  assert.ok(
    fine.norms.l1 < medium.norms.l1,
    `240->480 did not reduce L1: ${medium.norms.l1} -> ${fine.norms.l1}`
  );

  const order1 = estimateObservedOrder(coarse.norms.l1, medium.norms.l1);
  const order2 = estimateObservedOrder(medium.norms.l1, fine.norms.l1);

  assert.ok(Number.isFinite(order1));
  assert.ok(Number.isFinite(order2));
  assert.ok(
    order1 > 0.2 && order2 > 0.2,
    `observed convergence too weak: p=${order1}, ${order2}`
  );
});

test("Ritter benchmark remains finite, non-negative and mass conservative", () => {
  const result = runRitterBenchmark(240, 5);
  const validation = validateSwe2DState(result.state);
  assert.equal(validation.valid, true, validation.reason);

  const initialVolume = 2 * (480 * 0.4) * (result.grid.ny * result.grid.dy);
  const finalVolume = computeSwe2DVolumeM3(result.state, result.grid);
  const relativeMassError =
    Math.abs(finalVolume - initialVolume) / initialVolume;

  // The dry-bed solver intentionally zeroes depths below dryDepth=1e-6.
  // That positivity/wet-dry cutoff can discard trace volumes at the advancing
  // front, so require conservation at 1e-7 relative rather than machine
  // precision. The observed regression is typically around 5e-8.
  assert.ok(
    relativeMassError < 1e-7,
    `Ritter closed-domain mass error too large: ${relativeMassError}`
  );

  for (const h of result.state.h) {
    assert.ok(h >= 0);
    assert.ok(Number.isFinite(h));
  }
});

test("symmetric 2D disturbance preserves mirror symmetry", () => {
  const nx = 81;
  const ny = 81;
  const dx = 4;
  const grid = flatGrid(nx, ny, dx);
  const state = createSwe2DState(nx * ny);
  const centerCol = (nx - 1) / 2;
  const centerRow = (ny - 1) / 2;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const r = Math.hypot(col - centerCol, row - centerRow);
      state.h[row * nx + col] =
        0.5 + 1.5 * Math.exp(-(r * r) / 30);
    }
  }

  for (let step = 0; step < 80; step += 1) {
    advanceSwe2D(state, grid, {
      cfl: 0.3,
      dryDepth: 1e-6
    });
  }

  const mirror = computeMirrorSymmetryMetrics(state.h, nx, ny);
  const radialSpread = computeRadialSymmetrySpread(
    state.h,
    nx,
    ny,
    centerCol,
    centerRow,
    0.5
  );

  assert.ok(
    mirror.maxAbsoluteDifference < 1e-10,
    `mirror symmetry drift: ${mirror.maxAbsoluteDifference}`
  );
  assert.ok(
    radialSpread < 0.035,
    `radial anisotropy too large: ${radialSpread}`
  );
});

test("resolution refinement preserves total water volume", () => {
  for (const resolution of [32, 64, 128]) {
    const nx = resolution;
    const ny = Math.floor(resolution * 0.75);
    const dx = 320 / nx;
    const dy = 240 / ny;
    const grid = flatGrid(nx, ny, dx, dy);
    const state = createSwe2DState(nx * ny);

    for (let row = 0; row < ny; row += 1) {
      for (let col = 0; col < nx; col += 1) {
        const x = (col + 0.5) * dx - 160;
        const y = (row + 0.5) * dy - 120;
        state.h[row * nx + col] =
          0.25 + 1.25 * Math.exp(-(x * x + y * y) / 1800);
      }
    }

    const initial = computeSwe2DVolumeM3(state, grid);

    for (let step = 0; step < 120; step += 1) {
      advanceSwe2D(state, grid, {
        cfl: 0.3,
        dryDepth: 1e-6
      });
    }

    const final = computeSwe2DVolumeM3(state, grid);
    const relativeError = Math.abs(final - initial) / initial;

    assert.ok(
      relativeError < 1e-10,
      `resolution ${resolution}: mass error ${relativeError}`
    );
  }
});

test("well-balanced variable-bed regression stays below strict error norms", () => {
  const nx = 64;
  const ny = 44;
  const dx = 5;
  const dy = 5;
  const bed = new Float64Array(nx * ny);
  const state = createSwe2DState(nx * ny);
  const freeSurface = 15;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const x = (col - nx / 2) * dx;
      const y = (row - ny / 2) * dy;
      const z =
        2 +
        0.005 * x -
        0.003 * y +
        1.2 * Math.exp(-(x * x + y * y) / 7000);
      const i = row * nx + col;
      bed[i] = z;
      state.h[i] = freeSurface - z;
    }
  }

  const grid = { nx, ny, dx, dy, bed };

  for (let step = 0; step < 250; step += 1) {
    advanceSwe2D(state, grid, {
      cfl: 0.35,
      dryDepth: 1e-7
    });
  }

  const surface = new Float64Array(nx * ny);
  const reference = new Float64Array(nx * ny);
  reference.fill(freeSurface);

  for (let i = 0; i < surface.length; i += 1) {
    surface[i] = state.h[i] + bed[i];
  }

  const norms = computeErrorNorms(surface, reference);

  assert.ok(norms.l1 < 1e-10, `L1 free-surface drift: ${norms.l1}`);
  assert.ok(norms.l2 < 1e-10, `L2 free-surface drift: ${norms.l2}`);
  assert.ok(norms.linf < 1e-9, `Linf free-surface drift: ${norms.linf}`);
});
