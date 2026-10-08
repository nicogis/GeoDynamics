export interface ErrorNorms {
  l1: number;
  l2: number;
  linf: number;
}

export interface SymmetryMetrics {
  maxAbsoluteDifference: number;
  meanAbsoluteDifference: number;
}

export function computeErrorNorms(
  numerical: ArrayLike<number>,
  reference: ArrayLike<number>
): ErrorNorms {
  if (numerical.length !== reference.length || numerical.length === 0) {
    throw new Error("Error-norm arrays must have the same non-zero length.");
  }

  let sumAbs = 0;
  let sumSquared = 0;
  let maxAbs = 0;

  for (let i = 0; i < numerical.length; i += 1) {
    const error = numerical[i] - reference[i];
    const absError = Math.abs(error);
    sumAbs += absError;
    sumSquared += error * error;
    maxAbs = Math.max(maxAbs, absError);
  }

  return {
    l1: sumAbs / numerical.length,
    l2: Math.sqrt(sumSquared / numerical.length),
    linf: maxAbs
  };
}

export function estimateObservedOrder(
  coarseError: number,
  fineError: number,
  refinementRatio = 2
): number {
  if (
    coarseError <= 0 ||
    fineError <= 0 ||
    refinementRatio <= 1
  ) {
    return Number.NaN;
  }

  return Math.log(coarseError / fineError) / Math.log(refinementRatio);
}

export function ritterDamBreakDepth(
  x: number,
  timeS: number,
  upstreamDepthM: number,
  gravity = 9.81
): number {
  if (upstreamDepthM <= 0) {
    return 0;
  }

  if (timeS <= 0) {
    return x < 0 ? upstreamDepthM : 0;
  }

  const c0 = Math.sqrt(gravity * upstreamDepthM);
  const xi = x / timeS;

  if (xi <= -c0) {
    return upstreamDepthM;
  }

  if (xi >= 2 * c0) {
    return 0;
  }

  const c = (2 * c0 - xi) / 3;
  return Math.max((c * c) / gravity, 0);
}

export function ritterDamBreakVelocity(
  x: number,
  timeS: number,
  upstreamDepthM: number,
  gravity = 9.81
): number {
  if (upstreamDepthM <= 0 || timeS <= 0) {
    return 0;
  }

  const c0 = Math.sqrt(gravity * upstreamDepthM);
  const xi = x / timeS;

  if (xi <= -c0 || xi >= 2 * c0) {
    return 0;
  }

  return (2 / 3) * (c0 + xi);
}

export function computeMirrorSymmetryMetrics(
  values: ArrayLike<number>,
  nx: number,
  ny: number
): SymmetryMetrics {
  if (values.length !== nx * ny || nx < 2 || ny < 2) {
    throw new Error("Symmetry grid dimensions are inconsistent.");
  }

  let sum = 0;
  let count = 0;
  let max = 0;

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < Math.floor(nx / 2); col += 1) {
      const a = values[row * nx + col];
      const b = values[row * nx + (nx - 1 - col)];
      const diff = Math.abs(a - b);
      sum += diff;
      max = Math.max(max, diff);
      count += 1;
    }
  }

  return {
    maxAbsoluteDifference: max,
    meanAbsoluteDifference: count > 0 ? sum / count : 0
  };
}

export function computeRadialSymmetrySpread(
  values: ArrayLike<number>,
  nx: number,
  ny: number,
  centerCol: number,
  centerRow: number,
  radiusToleranceCells = 0.35
): number {
  if (values.length !== nx * ny) {
    throw new Error("Radial symmetry grid dimensions are inconsistent.");
  }

  const buckets = new Map<number, number[]>();

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const radius = Math.hypot(col - centerCol, row - centerRow);
      const bucket = Math.round(radius / radiusToleranceCells);
      const list = buckets.get(bucket) ?? [];
      list.push(values[row * nx + col]);
      buckets.set(bucket, list);
    }
  }

  let worstSpread = 0;

  for (const list of buckets.values()) {
    if (list.length < 4) {
      continue;
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of list) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    worstSpread = Math.max(worstSpread, max - min);
  }

  return worstSpread;
}
