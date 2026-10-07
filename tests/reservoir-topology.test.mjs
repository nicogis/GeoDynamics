import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConnectedReservoirMask,
  sideOfDamLine
} from "../.test-dist/src/physics/ReservoirTopology.js";

const RESOLUTION = 128;
const SIZE = 800;
const WATER = 95;

function grid(centerX, centerY, terrain) {
  const half = SIZE / 2;
  const step = SIZE / RESOLUTION;
  const elevations = new Float64Array(RESOLUTION * RESOLUTION);

  for (let row = 0; row < RESOLUTION; row += 1) {
    const y = centerY - half + (row + 0.5) * step;
    for (let col = 0; col < RESOLUTION; col += 1) {
      const x = centerX - half + (col + 0.5) * step;
      elevations[row * RESOLUTION + col] = terrain(x, y);
    }
  }

  return elevations;
}

function localCoordinates(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    s: x * cos + y * sin,
    n: -x * sin + y * cos
  };
}

function fromLocal(s, n, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: s * cos - n * sin,
    y: s * sin + n * cos
  };
}

function verifyReservoir(name, scenario) {
  test(name, () => {
    const elevations = grid(
      scenario.center.x,
      scenario.center.y,
      scenario.terrain
    );

    const result = buildConnectedReservoirMask({
      elevations,
      centerX: scenario.center.x,
      centerY: scenario.center.y,
      size: SIZE,
      resolution: RESOLUTION,
      seedX: scenario.seed.x,
      seedY: scenario.seed.y,
      dam: scenario.dam,
      waterElevation: WATER
    });

    assert.ok(result.wetCellCount > 20, "reservoir should contain a stable wet component");
    assert.equal(result.touchesBoundary, false, "reservoir should close inside the synthetic DEM");
    assert.ok(result.nearDamContactCells >= 2, "reservoir should contact the dam");
    assert.ok(result.nearDamMaxT >= 0 && result.nearDamMinT <= 1, "dam contact should overlap the real crest span");

    const seedSide = Math.sign(
      sideOfDamLine(scenario.seed.x, scenario.seed.y, scenario.dam)
    );
    assert.notEqual(seedSide, 0);

    const centroidSide = Math.sign(
      sideOfDamLine(result.centroidX, result.centroidY, scenario.dam)
    );
    assert.equal(
      centroidSide,
      seedSide,
      "reservoir centroid must stay on the upstream side"
    );

    const half = SIZE / 2;
    const step = SIZE / RESOLUTION;
    for (let i = 0; i < result.mask.length; i += 1) {
      if (result.mask[i] === 0) continue;
      const row = Math.floor(i / RESOLUTION);
      const col = i % RESOLUTION;
      const x = scenario.center.x - half + (col + 0.5) * step;
      const y = scenario.center.y - half + (row + 0.5) * step;
      const cellSide = Math.sign(sideOfDamLine(x, y, scenario.dam));
      assert.equal(
        cellSide,
        seedSide,
        "wet mask must never rotate/cross to the downstream half-plane"
      );
    }

    if (scenario.centroidCheck) {
      scenario.centroidCheck(result);
    }
  });
}

const horizontalDam = {
  start: { x: -220, y: 0 },
  end: { x: 220, y: 0 }
};

verifyReservoir("simple valley", {
  center: { x: 0, y: 160 },
  dam: horizontalDam,
  seed: { x: 0, y: 80 },
  terrain: (x, y) =>
    78 +
    Math.abs(x) * 0.06 +
    Math.pow((y - 150) / 160, 2) * 8,
  centroidCheck: (result) => {
    assert.ok(Math.abs(result.centroidX) < 25);
    assert.ok(result.centroidY > 60);
  }
});

verifyReservoir("concave valley", {
  center: { x: 0, y: 180 },
  dam: horizontalDam,
  seed: { x: 55, y: 90 },
  terrain: (x, y) => {
    const valleyX = 105 * Math.sin(y / 170);
    return (
      78 +
      Math.abs(x - valleyX) * 0.07 +
      Math.pow((y - 180) / 190, 2) * 7
    );
  },
  centroidCheck: (result) => {
    assert.ok(result.centroidY > 70);
  }
});

verifyReservoir("double branch valley", {
  center: { x: 0, y: 190 },
  dam: horizontalDam,
  seed: { x: 0, y: 75 },
  terrain: (x, y) => {
    const branch = Math.max(y - 145, 0);
    const separation = Math.min(branch * 0.48, 105);
    const centerDistance =
      y < 145
        ? Math.abs(x)
        : Math.min(
            Math.abs(x - separation),
            Math.abs(x + separation)
          );
    return (
      77 +
      centerDistance * 0.065 +
      Math.pow((y - 205) / 220, 2) * 7.5
    );
  },
  centroidCheck: (result) => {
    assert.ok(Math.abs(result.centroidX) < 35, "fork should not rotate toward one branch");
  }
});

verifyReservoir("nearly symmetric basin", {
  center: { x: 0, y: 170 },
  dam: horizontalDam,
  seed: { x: 0, y: 80 },
  terrain: (x, y) =>
    77.5 +
    Math.pow(x / 170, 2) * 7 +
    Math.pow((y - 175) / 190, 2) * 8,
  centroidCheck: (result) => {
    assert.ok(Math.abs(result.centroidX) < 12, "symmetric basin should remain centered");
  }
});

{
  const angle = Math.PI / 6;
  const start = fromLocal(-220, 0, angle);
  const end = fromLocal(220, 0, angle);
  const seed = fromLocal(0, 85, angle);

  verifyReservoir("oblique dam", {
    center: fromLocal(0, 170, angle),
    dam: { start, end },
    seed,
    terrain: (x, y) => {
      const { s, n } = localCoordinates(x, y, angle);
      return (
        78 +
        Math.abs(s) * 0.055 +
        Math.pow((n - 165) / 180, 2) * 8
      );
    },
    centroidCheck: (result) => {
      const local = localCoordinates(result.centroidX, result.centroidY, angle);
      assert.ok(Math.abs(local.s) < 25, "oblique reservoir should stay normal to the dam, not axis-aligned");
      assert.ok(local.n > 60);
    }
  });
}

verifyReservoir("closed depression", {
  center: { x: 0, y: 170 },
  dam: horizontalDam,
  seed: { x: 0, y: 95 },
  terrain: (x, y) =>
    76 +
    0.00042 * x * x +
    0.00038 * Math.pow(y - 165, 2),
  centroidCheck: (result) => {
    assert.ok(result.centroidY > 70);
    assert.ok(Math.abs(result.centroidX) < 20);
  }
});
