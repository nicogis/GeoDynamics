import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceSwe2D,
  computeStableSwe2DDt,
  computeSwe2DVolumeM3,
  createSwe2DState,
  validateSwe2DState
} from "../.test-dist/src/physics/ShallowWater2D.js";

function flatGrid(nx, ny, dx = 5, dy = 5, elevation = 0) {
  const bed = new Float64Array(nx * ny);
  bed.fill(elevation);
  return { nx, ny, dx, dy, bed };
}

test("lake at rest on a flat bed remains exactly at rest", () => {
  const grid = flatGrid(48, 32);
  const state = createSwe2DState(grid.nx * grid.ny);
  state.h.fill(2);

  const initialVolume = computeSwe2DVolumeM3(state, grid);

  for (let step = 0; step < 200; step += 1) {
    const diagnostics = advanceSwe2D(state, grid, {
      cfl: 0.4,
      manningN: 0.03
    });
    assert.equal(diagnostics.clippedNegativeDepthCells, 0);
  }

  const finalVolume = computeSwe2DVolumeM3(state, grid);
  assert.ok(Math.abs(finalVolume - initialVolume) < 1e-8);

  for (let i = 0; i < state.h.length; i += 1) {
    assert.ok(Math.abs(state.h[i] - 2) < 1e-12);
    assert.ok(Math.abs(state.hu[i]) < 1e-12);
    assert.ok(Math.abs(state.hv[i]) < 1e-12);
  }
});

test("closed 2D dam-break conserves water mass", () => {
  const grid = flatGrid(80, 36, 4, 4);
  const state = createSwe2DState(grid.nx * grid.ny);

  for (let row = 0; row < grid.ny; row += 1) {
    for (let col = 0; col < grid.nx; col += 1) {
      state.h[row * grid.nx + col] = col < grid.nx / 3 ? 3 : 0.4;
    }
  }

  const initialVolume = computeSwe2DVolumeM3(state, grid);
  let clipped = 0;

  for (let step = 0; step < 350; step += 1) {
    const diagnostics = advanceSwe2D(state, grid, {
      cfl: 0.35,
      dryDepth: 1e-5
    });
    clipped += diagnostics.clippedNegativeDepthCells;
  }

  const finalVolume = computeSwe2DVolumeM3(state, grid);
  const relativeError =
    Math.abs(finalVolume - initialVolume) / initialVolume;

  assert.equal(clipped, 0, "CFL-controlled dam-break should remain positive");
  assert.ok(
    relativeError < 1e-10,
    `closed-domain SWE mass drift too large: ${relativeError}`
  );
  assert.equal(validateSwe2DState(state).valid, true);
});

test("2D dam-break evolves both conserved momentum and depth", () => {
  const grid = flatGrid(64, 32, 5, 5);
  const state = createSwe2DState(grid.nx * grid.ny);

  for (let row = 0; row < grid.ny; row += 1) {
    for (let col = 0; col < grid.nx; col += 1) {
      state.h[row * grid.nx + col] = col < grid.nx / 2 ? 2.5 : 0.25;
    }
  }

  for (let step = 0; step < 25; step += 1) {
    advanceSwe2D(state, grid, { cfl: 0.35 });
  }

  let maxAbsHu = 0;
  let changedDepthCells = 0;

  for (let row = 0; row < grid.ny; row += 1) {
    for (let col = 0; col < grid.nx; col += 1) {
      const i = row * grid.nx + col;
      maxAbsHu = Math.max(maxAbsHu, Math.abs(state.hu[i]));
      const original = col < grid.nx / 2 ? 2.5 : 0.25;
      if (Math.abs(state.h[i] - original) > 1e-6) {
        changedDepthCells += 1;
      }
    }
  }

  assert.ok(maxAbsHu > 0.01, "dam break should generate x momentum");
  assert.ok(changedDepthCells > grid.ny, "dam front should evolve across cells");
});

test("CFL timestep responds to depth and velocity", () => {
  const grid = flatGrid(16, 16, 10, 10);
  const shallow = createSwe2DState(grid.nx * grid.ny);
  shallow.h.fill(0.5);

  const deep = createSwe2DState(grid.nx * grid.ny);
  deep.h.fill(4);

  const shallowDt = computeStableSwe2DDt(shallow, grid, {
    cfl: 0.4,
    maxDtSeconds: 20
  }).dtSeconds;
  const deepDt = computeStableSwe2DDt(deep, grid, {
    cfl: 0.4,
    maxDtSeconds: 20
  }).dtSeconds;

  assert.ok(deepDt < shallowDt);

  const moving = createSwe2DState(grid.nx * grid.ny);
  moving.h.fill(0.5);
  moving.hu.fill(3);

  const movingDt = computeStableSwe2DDt(moving, grid, {
    cfl: 0.4,
    maxDtSeconds: 20
  }).dtSeconds;

  assert.ok(movingDt < shallowDt);
});

test("wet/dry state remains finite and non-negative", () => {
  const grid = flatGrid(52, 28, 5, 5);
  const state = createSwe2DState(grid.nx * grid.ny);

  for (let row = 9; row < 19; row += 1) {
    for (let col = 5; col < 18; col += 1) {
      state.h[row * grid.nx + col] = 1.5;
    }
  }

  for (let step = 0; step < 150; step += 1) {
    advanceSwe2D(state, grid, {
      cfl: 0.25,
      dryDepth: 1e-4,
      manningN: 0.03
    });
  }

  const validation = validateSwe2DState(state);
  assert.equal(validation.valid, true, validation.reason);
});


test("lake at rest remains well-balanced over variable topography", () => {
  const nx = 72;
  const ny = 48;
  const dx = 5;
  const dy = 5;
  const bed = new Float64Array(nx * ny);
  const state = createSwe2DState(nx * ny);
  const freeSurface = 12;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const x = (col - nx / 2) * dx;
      const y = (row - ny / 2) * dy;
      const z =
        2.2 +
        0.008 * x +
        0.004 * y +
        0.75 * Math.exp(-(x * x + y * y) / 9000);
      const i = row * nx + col;
      bed[i] = z;
      state.h[i] = Math.max(freeSurface - z, 0);
    }
  }

  const grid = { nx, ny, dx, dy, bed };
  const initialVolume = computeSwe2DVolumeM3(state, grid);
  let maxMomentum = 0;

  for (let step = 0; step < 500; step += 1) {
    const diagnostics = advanceSwe2D(state, grid, {
      cfl: 0.35,
      dryDepth: 1e-6,
      manningN: 0
    });
    assert.equal(diagnostics.clippedNegativeDepthCells, 0);
  }

  let maxSurfaceError = 0;
  for (let i = 0; i < state.h.length; i += 1) {
    maxMomentum = Math.max(
      maxMomentum,
      Math.abs(state.hu[i]),
      Math.abs(state.hv[i])
    );
    maxSurfaceError = Math.max(
      maxSurfaceError,
      Math.abs(state.h[i] + bed[i] - freeSurface)
    );
  }

  const finalVolume = computeSwe2DVolumeM3(state, grid);
  const volumeError =
    Math.abs(finalVolume - initialVolume) / initialVolume;

  assert.ok(
    maxMomentum < 1e-9,
    `spurious momentum too large: ${maxMomentum}`
  );
  assert.ok(
    maxSurfaceError < 1e-9,
    `free-surface drift too large: ${maxSurfaceError}`
  );
  assert.ok(
    volumeError < 1e-12,
    `well-balanced volume drift too large: ${volumeError}`
  );
});

test("partially dry lake at rest remains stable over a bed hump", () => {
  const nx = 64;
  const ny = 40;
  const dx = 4;
  const dy = 4;
  const bed = new Float64Array(nx * ny);
  const state = createSwe2DState(nx * ny);
  const freeSurface = 3.2;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const x = (col - nx / 2) * dx;
      const y = (row - ny / 2) * dy;
      const z =
        1.5 +
        2.2 * Math.exp(-(x * x + y * y) / 1800);
      const i = row * nx + col;
      bed[i] = z;
      state.h[i] = Math.max(freeSurface - z, 0);
    }
  }

  const grid = { nx, ny, dx, dy, bed };
  const initialVolume = computeSwe2DVolumeM3(state, grid);

  for (let step = 0; step < 300; step += 1) {
    advanceSwe2D(state, grid, {
      cfl: 0.25,
      dryDepth: 1e-5,
      manningN: 0
    });
  }

  const finalVolume = computeSwe2DVolumeM3(state, grid);
  const validation = validateSwe2DState(state);
  let maxMomentum = 0;

  for (let i = 0; i < state.h.length; i += 1) {
    maxMomentum = Math.max(
      maxMomentum,
      Math.abs(state.hu[i]),
      Math.abs(state.hv[i])
    );
  }

  assert.equal(validation.valid, true, validation.reason);
  assert.ok(maxMomentum < 1e-8);
  assert.ok(
    Math.abs(finalVolume - initialVolume) / initialVolume < 1e-10
  );
});
