export interface Swe2DState {
  h: Float64Array;
  hu: Float64Array;
  hv: Float64Array;
}

export interface Swe2DGrid {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  bed: Float64Array;
}

export interface Swe2DOptions {
  gravity?: number;
  dryDepth?: number;
  cfl?: number;
  manningN?: number;
  maxDtSeconds?: number;
}

export interface Swe2DStepDiagnostics {
  dtSeconds: number;
  maxWaveSpeed: number;
  waterVolumeM3: number;
  wetCellCount: number;
  clippedNegativeDepthCells: number;
}

const DEFAULT_GRAVITY = 9.81;
const DEFAULT_DRY_DEPTH = 1e-4;
const DEFAULT_CFL = 0.4;
const DEFAULT_MAX_DT_SECONDS = 2;

function indexOf(row: number, col: number, nx: number): number {
  return row * nx + col;
}

function primitive(
  h: number,
  hu: number,
  hv: number,
  dryDepth: number
): { u: number; v: number } {
  if (h <= dryDepth) {
    return { u: 0, v: 0 };
  }

  return {
    u: hu / h,
    v: hv / h
  };
}

function fluxX(
  h: number,
  hu: number,
  hv: number,
  gravity: number,
  dryDepth: number
): [number, number, number] {
  const { u, v } = primitive(h, hu, hv, dryDepth);
  return [
    hu,
    hu * u + 0.5 * gravity * h * h,
    hu * v
  ];
}

function fluxY(
  h: number,
  hu: number,
  hv: number,
  gravity: number,
  dryDepth: number
): [number, number, number] {
  const { u, v } = primitive(h, hu, hv, dryDepth);
  return [
    hv,
    hv * u,
    hv * v + 0.5 * gravity * h * h
  ];
}

function rusanovFluxX(
  left: [number, number, number],
  right: [number, number, number],
  gravity: number,
  dryDepth: number
): [number, number, number] {
  const [hL, huL, hvL] = left;
  const [hR, huR, hvR] = right;
  const fL = fluxX(hL, huL, hvL, gravity, dryDepth);
  const fR = fluxX(hR, huR, hvR, gravity, dryDepth);
  const pL = primitive(hL, huL, hvL, dryDepth);
  const pR = primitive(hR, huR, hvR, dryDepth);
  const a = Math.max(
    Math.abs(pL.u) + Math.sqrt(gravity * Math.max(hL, 0)),
    Math.abs(pR.u) + Math.sqrt(gravity * Math.max(hR, 0))
  );

  return [
    0.5 * (fL[0] + fR[0]) - 0.5 * a * (hR - hL),
    0.5 * (fL[1] + fR[1]) - 0.5 * a * (huR - huL),
    0.5 * (fL[2] + fR[2]) - 0.5 * a * (hvR - hvL)
  ];
}

function rusanovFluxY(
  bottom: [number, number, number],
  top: [number, number, number],
  gravity: number,
  dryDepth: number
): [number, number, number] {
  const [hB, huB, hvB] = bottom;
  const [hT, huT, hvT] = top;
  const fB = fluxY(hB, huB, hvB, gravity, dryDepth);
  const fT = fluxY(hT, huT, hvT, gravity, dryDepth);
  const pB = primitive(hB, huB, hvB, dryDepth);
  const pT = primitive(hT, huT, hvT, dryDepth);
  const a = Math.max(
    Math.abs(pB.v) + Math.sqrt(gravity * Math.max(hB, 0)),
    Math.abs(pT.v) + Math.sqrt(gravity * Math.max(hT, 0))
  );

  return [
    0.5 * (fB[0] + fT[0]) - 0.5 * a * (hT - hB),
    0.5 * (fB[1] + fT[1]) - 0.5 * a * (huT - huB),
    0.5 * (fB[2] + fT[2]) - 0.5 * a * (hvT - hvB)
  ];
}

function reflectedX(
  h: number,
  hu: number,
  hv: number
): [number, number, number] {
  return [h, -hu, hv];
}

function reflectedY(
  h: number,
  hu: number,
  hv: number
): [number, number, number] {
  return [h, hu, -hv];
}

function cellState(
  state: Swe2DState,
  index: number
): [number, number, number] {
  return [state.h[index], state.hu[index], state.hv[index]];
}

export function createSwe2DState(cellCount: number): Swe2DState {
  return {
    h: new Float64Array(cellCount),
    hu: new Float64Array(cellCount),
    hv: new Float64Array(cellCount)
  };
}

export function computeSwe2DVolumeM3(
  state: Swe2DState,
  grid: Swe2DGrid
): number {
  const cellArea = grid.dx * grid.dy;
  let volume = 0;

  for (let i = 0; i < state.h.length; i += 1) {
    volume += Math.max(state.h[i], 0) * cellArea;
  }

  return volume;
}

export function computeStableSwe2DDt(
  state: Swe2DState,
  grid: Swe2DGrid,
  options: Swe2DOptions = {}
): { dtSeconds: number; maxWaveSpeed: number } {
  const gravity = options.gravity ?? DEFAULT_GRAVITY;
  const dryDepth = options.dryDepth ?? DEFAULT_DRY_DEPTH;
  const cfl = options.cfl ?? DEFAULT_CFL;
  const maxDt = options.maxDtSeconds ?? DEFAULT_MAX_DT_SECONDS;
  let maxSignalX = 0;
  let maxSignalY = 0;

  for (let i = 0; i < state.h.length; i += 1) {
    const h = Math.max(state.h[i], 0);
    if (h <= dryDepth) {
      continue;
    }

    const { u, v } = primitive(h, state.hu[i], state.hv[i], dryDepth);
    const c = Math.sqrt(gravity * h);
    maxSignalX = Math.max(maxSignalX, Math.abs(u) + c);
    maxSignalY = Math.max(maxSignalY, Math.abs(v) + c);
  }

  const dtX = maxSignalX > 0 ? grid.dx / maxSignalX : Number.POSITIVE_INFINITY;
  const dtY = maxSignalY > 0 ? grid.dy / maxSignalY : Number.POSITIVE_INFINITY;
  const dt = Math.min(cfl * Math.min(dtX, dtY), maxDt);

  return {
    dtSeconds: Number.isFinite(dt) && dt > 0 ? dt : maxDt,
    maxWaveSpeed: Math.max(maxSignalX, maxSignalY)
  };
}

function applyManningFriction(
  h: number,
  hu: number,
  hv: number,
  dt: number,
  gravity: number,
  manningN: number,
  dryDepth: number
): [number, number] {
  if (manningN <= 0 || h <= dryDepth) {
    return [hu, hv];
  }

  const u = hu / h;
  const v = hv / h;
  const speed = Math.hypot(u, v);

  if (speed <= 1e-12) {
    return [hu, hv];
  }

  const coefficient =
    gravity * manningN * manningN * speed /
    Math.pow(Math.max(h, dryDepth), 4 / 3);
  const damping = 1 / (1 + dt * coefficient);

  return [hu * damping, hv * damping];
}

export function advanceSwe2D(
  state: Swe2DState,
  grid: Swe2DGrid,
  options: Swe2DOptions = {}
): Swe2DStepDiagnostics {
  const { nx, ny, dx, dy, bed } = grid;
  const cellCount = nx * ny;

  if (
    state.h.length !== cellCount ||
    state.hu.length !== cellCount ||
    state.hv.length !== cellCount ||
    bed.length !== cellCount
  ) {
    throw new Error("SWE state/grid dimensions are inconsistent.");
  }

  const gravity = options.gravity ?? DEFAULT_GRAVITY;
  const dryDepth = options.dryDepth ?? DEFAULT_DRY_DEPTH;
  const manningN = options.manningN ?? 0;
  const { dtSeconds, maxWaveSpeed } =
    computeStableSwe2DDt(state, grid, options);

  const nextH = new Float64Array(state.h);
  const nextHu = new Float64Array(state.hu);
  const nextHv = new Float64Array(state.hv);

  const xFluxes: [number, number, number][] =
    new Array(ny * (nx + 1));
  const yFluxes: [number, number, number][] =
    new Array((ny + 1) * nx);

  for (let row = 0; row < ny; row += 1) {
    for (let face = 0; face <= nx; face += 1) {
      let left: [number, number, number];
      let right: [number, number, number];

      if (face === 0) {
        right = cellState(state, indexOf(row, 0, nx));
        left = reflectedX(...right);
      } else if (face === nx) {
        left = cellState(state, indexOf(row, nx - 1, nx));
        right = reflectedX(...left);
      } else {
        left = cellState(state, indexOf(row, face - 1, nx));
        right = cellState(state, indexOf(row, face, nx));
      }

      xFluxes[row * (nx + 1) + face] =
        rusanovFluxX(left, right, gravity, dryDepth);
    }
  }

  for (let face = 0; face <= ny; face += 1) {
    for (let col = 0; col < nx; col += 1) {
      let bottom: [number, number, number];
      let top: [number, number, number];

      if (face === 0) {
        top = cellState(state, indexOf(0, col, nx));
        bottom = reflectedY(...top);
      } else if (face === ny) {
        bottom = cellState(state, indexOf(ny - 1, col, nx));
        top = reflectedY(...bottom);
      } else {
        bottom = cellState(state, indexOf(face - 1, col, nx));
        top = cellState(state, indexOf(face, col, nx));
      }

      yFluxes[face * nx + col] =
        rusanovFluxY(bottom, top, gravity, dryDepth);
    }
  }

  let clippedNegativeDepthCells = 0;
  let wetCellCount = 0;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const i = indexOf(row, col, nx);
      const leftFlux = xFluxes[row * (nx + 1) + col];
      const rightFlux = xFluxes[row * (nx + 1) + col + 1];
      const bottomFlux = yFluxes[row * nx + col];
      const topFlux = yFluxes[(row + 1) * nx + col];

      let h =
        state.h[i] -
        dtSeconds / dx * (rightFlux[0] - leftFlux[0]) -
        dtSeconds / dy * (topFlux[0] - bottomFlux[0]);
      let hu =
        state.hu[i] -
        dtSeconds / dx * (rightFlux[1] - leftFlux[1]) -
        dtSeconds / dy * (topFlux[1] - bottomFlux[1]);
      let hv =
        state.hv[i] -
        dtSeconds / dx * (rightFlux[2] - leftFlux[2]) -
        dtSeconds / dy * (topFlux[2] - bottomFlux[2]);

      const leftCol = Math.max(col - 1, 0);
      const rightCol = Math.min(col + 1, nx - 1);
      const bottomRow = Math.max(row - 1, 0);
      const topRow = Math.min(row + 1, ny - 1);
      const dzdx =
        (bed[indexOf(row, rightCol, nx)] -
          bed[indexOf(row, leftCol, nx)]) /
        Math.max((rightCol - leftCol) * dx, dx);
      const dzdy =
        (bed[indexOf(topRow, col, nx)] -
          bed[indexOf(bottomRow, col, nx)]) /
        Math.max((topRow - bottomRow) * dy, dy);

      hu -= dtSeconds * gravity * Math.max(h, 0) * dzdx;
      hv -= dtSeconds * gravity * Math.max(h, 0) * dzdy;

      if (h < 0) {
        h = 0;
        hu = 0;
        hv = 0;
        clippedNegativeDepthCells += 1;
      } else if (h <= dryDepth) {
        h = 0;
        hu = 0;
        hv = 0;
      } else {
        [hu, hv] = applyManningFriction(
          h,
          hu,
          hv,
          dtSeconds,
          gravity,
          manningN,
          dryDepth
        );
        wetCellCount += 1;
      }

      nextH[i] = h;
      nextHu[i] = hu;
      nextHv[i] = hv;
    }
  }

  state.h.set(nextH);
  state.hu.set(nextHu);
  state.hv.set(nextHv);

  return {
    dtSeconds,
    maxWaveSpeed,
    waterVolumeM3: computeSwe2DVolumeM3(state, grid),
    wetCellCount,
    clippedNegativeDepthCells
  };
}

export function validateSwe2DState(
  state: Swe2DState
): { valid: boolean; reason?: string } {
  for (let i = 0; i < state.h.length; i += 1) {
    if (
      !Number.isFinite(state.h[i]) ||
      !Number.isFinite(state.hu[i]) ||
      !Number.isFinite(state.hv[i])
    ) {
      return {
        valid: false,
        reason: `non-finite conserved state at cell ${i}`
      };
    }

    if (state.h[i] < 0) {
      return {
        valid: false,
        reason: `negative water depth at cell ${i}`
      };
    }
  }

  return { valid: true };
}
