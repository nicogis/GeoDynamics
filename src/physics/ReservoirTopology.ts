export interface ReservoirDamLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface ReservoirTopologyInput {
  elevations: ArrayLike<number>;
  centerX: number;
  centerY: number;
  size: number;
  resolution: number;
  seedX: number;
  seedY: number;
  dam: ReservoirDamLine;
  waterElevation: number;
  connectivityElevation?: number;
}

export interface ReservoirTopologyResult {
  mask: Uint8Array;
  wetCellCount: number;
  touchesBoundary: boolean;
  nearDamContactCells: number;
  nearDamMinT: number;
  nearDamMaxT: number;
  centroidX: number;
  centroidY: number;
  minWetDistanceToDam: number;
}

export function sideOfDamLine(
  x: number,
  y: number,
  dam: ReservoirDamLine
): number {
  return (
    (dam.end.x - dam.start.x) * (y - dam.start.y) -
    (dam.end.y - dam.start.y) * (x - dam.start.x)
  );
}

function touchesMaskBoundary(mask: Uint8Array, resolution: number): boolean {
  for (let i = 0; i < resolution; i += 1) {
    const top = i;
    const bottom = (resolution - 1) * resolution + i;
    const left = i * resolution;
    const right = i * resolution + (resolution - 1);

    if (
      mask[top] !== 0 ||
      mask[bottom] !== 0 ||
      mask[left] !== 0 ||
      mask[right] !== 0
    ) {
      return true;
    }
  }

  return false;
}

export function buildConnectedReservoirMask(
  input: ReservoirTopologyInput
): ReservoirTopologyResult {
  const {
    elevations,
    centerX,
    centerY,
    size,
    resolution,
    seedX,
    seedY,
    dam,
    waterElevation,
    connectivityElevation = waterElevation
  } = input;

  if (elevations.length !== resolution * resolution) {
    throw new Error("Synthetic/reservoir elevation grid has an invalid size.");
  }

  const half = size / 2;
  const step = size / resolution;
  const candidate = new Uint8Array(resolution * resolution);
  const seedSide = sideOfDamLine(seedX, seedY, dam);

  if (Math.abs(seedSide) < 0.001) {
    throw new Error("Place the reservoir seed clearly upstream from the dam.");
  }

  const damDx = dam.end.x - dam.start.x;
  const damDy = dam.end.y - dam.start.y;
  const damLength = Math.hypot(damDx, damDy);
  const damLengthSquared = damDx * damDx + damDy * damDy;

  if (damLength < 1 || damLengthSquared < 1) {
    throw new Error("The dam barrier is too short.");
  }

  for (let row = 0; row < resolution; row += 1) {
    const y = centerY - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      const elevation = elevations[index];

      if (!Number.isFinite(elevation) || elevation > connectivityElevation) {
        continue;
      }

      const x = centerX - half + (col + 0.5) * step;
      const cellSide = sideOfDamLine(x, y, dam);
      const distanceToDam = Math.abs(cellSide) / damLength;

      if (cellSide * seedSide > 0 && distanceToDam > step * 0.6) {
        candidate[index] = 255;
      }
    }
  }

  const seedCol = Math.floor((seedX - (centerX - half)) / step);
  const seedRow = Math.floor((seedY - (centerY - half)) / step);

  if (
    seedCol < 0 ||
    seedCol >= resolution ||
    seedRow < 0 ||
    seedRow >= resolution
  ) {
    throw new Error("The reservoir seed is outside the sampled domain.");
  }

  const seedIndex = seedRow * resolution + seedCol;

  if (candidate[seedIndex] === 0) {
    throw new Error(
      "The upstream seed is above the reservoir level. Move it lower in the valley."
    );
  }

  const mask = new Uint8Array(candidate.length);
  const queue = new Int32Array(candidate.length);
  let head = 0;
  let tail = 0;

  queue[tail++] = seedIndex;
  mask[seedIndex] = 255;

  while (head < tail) {
    const index = queue[head++];
    const row = Math.floor(index / resolution);
    const col = index % resolution;

    const tryAdd = (r: number, c: number) => {
      if (r < 0 || r >= resolution || c < 0 || c >= resolution) {
        return;
      }

      const neighbor = r * resolution + c;
      if (candidate[neighbor] === 0 || mask[neighbor] !== 0) {
        return;
      }

      mask[neighbor] = 255;
      queue[tail++] = neighbor;
    };

    tryAdd(row - 1, col);
    tryAdd(row + 1, col);
    tryAdd(row, col - 1);
    tryAdd(row, col + 1);

    const tryAddDiagonal = (
      r: number,
      c: number,
      bridgeA: number,
      bridgeB: number
    ) => {
      if (r < 0 || r >= resolution || c < 0 || c >= resolution) {
        return;
      }

      if (candidate[bridgeA] === 0 && candidate[bridgeB] === 0) {
        return;
      }

      tryAdd(r, c);
    };

    const up = row > 0 ? (row - 1) * resolution + col : index;
    const down =
      row < resolution - 1 ? (row + 1) * resolution + col : index;
    const left = col > 0 ? row * resolution + col - 1 : index;
    const right =
      col < resolution - 1 ? row * resolution + col + 1 : index;

    tryAddDiagonal(row - 1, col - 1, up, left);
    tryAddDiagonal(row - 1, col + 1, up, right);
    tryAddDiagonal(row + 1, col - 1, down, left);
    tryAddDiagonal(row + 1, col + 1, down, right);
  }

  let wetCellCount = 0;
  let minWetDistanceToDam = Number.POSITIVE_INFINITY;
  let nearDamContactCells = 0;
  let nearDamMinT = Number.POSITIVE_INFINITY;
  let nearDamMaxT = Number.NEGATIVE_INFINITY;
  let sumX = 0;
  let sumY = 0;
  const nearDamTolerance = Math.max(step * 3, 35);

  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) {
      continue;
    }

    wetCellCount += 1;

    const row = Math.floor(i / resolution);
    const col = i % resolution;
    const x = centerX - half + (col + 0.5) * step;
    const y = centerY - half + (row + 0.5) * step;
    sumX += x;
    sumY += y;

    const damSide = sideOfDamLine(x, y, dam);
    const distanceToDam = Math.abs(damSide) / damLength;
    minWetDistanceToDam = Math.min(minWetDistanceToDam, distanceToDam);

    if (distanceToDam <= nearDamTolerance) {
      const t =
        ((x - dam.start.x) * damDx + (y - dam.start.y) * damDy) /
        damLengthSquared;

      if (t >= -0.15 && t <= 1.15) {
        nearDamContactCells += 1;
        nearDamMinT = Math.min(nearDamMinT, t);
        nearDamMaxT = Math.max(nearDamMaxT, t);
      }
    }
  }

  if (wetCellCount < 4) {
    throw new Error(
      "The selected reservoir component is too small or disconnected."
    );
  }

  if (
    !Number.isFinite(minWetDistanceToDam) ||
    minWetDistanceToDam > nearDamTolerance
  ) {
    throw new Error(
      "The selected water body is not connected to the dam. Choose a seed in the valley immediately upstream."
    );
  }

  if (
    nearDamContactCells < 2 ||
    !Number.isFinite(nearDamMinT) ||
    !Number.isFinite(nearDamMaxT)
  ) {
    throw new Error(
      "The reservoir component does not make a stable contact with the dam profile."
    );
  }

  if (nearDamMaxT < 0 || nearDamMinT > 1) {
    throw new Error(
      "The reservoir contacts the dam outside the barrier span. Reposition the dam or choose another upstream seed."
    );
  }

  return {
    mask,
    wetCellCount,
    touchesBoundary: touchesMaskBoundary(mask, resolution),
    nearDamContactCells,
    nearDamMinT,
    nearDamMaxT,
    centroidX: sumX / wetCellCount,
    centroidY: sumY / wetCellCount,
    minWetDistanceToDam
  };
}
