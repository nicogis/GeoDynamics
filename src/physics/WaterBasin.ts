import Multipoint from "@arcgis/core/geometry/Multipoint";
import Point from "@arcgis/core/geometry/Point";
import SceneView from "@arcgis/core/views/SceneView";

import type { SimulationSettings } from "../config/SimulationSettings";

const MIN_RESOLUTION = 128;
const ELEVATION_BATCH_SIZE = 16384;
const DOMAIN_MARGIN = 180;

export interface DamBarrier {
  start: Point;
  end: Point;
}

export interface SampledWaterBasin {
  center: Point;
  size: number;
  resolution: number;
  cellSize: number;
  waterElevation: number;
  damCrestElevation: number;
  maxDamHeight: number;
  mask: Uint8Array;
  depth: Float32Array;
  maxDepth: number;
  wetCellCount: number;
  touchesBoundary: boolean;
  damLength: number;
  areaM2: number;
  volumeM3: number;
  damProfilePoints: number[][];
  waterLevelStart: number[];
  waterLevelEnd: number[];
}

interface BasinSample {
  mask: Uint8Array;
  depth: Float32Array;
  maxDepth: number;
  wetCellCount: number;
  touchesBoundary: boolean;
  areaM2: number;
  volumeM3: number;
  nearDamContactCells: number;
  nearDamMinT: number;
  nearDamMaxT: number;
}

interface DamProfile {
  crestElevation: number;
  valleyFloorElevation: number;
  maxDamHeight: number;
  terrainPoints: number[][];
}

function touchesMaskBoundary(
  mask: Uint8Array,
  resolution: number
): boolean {
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

function sideOfLine(
  x: number,
  y: number,
  dam: DamBarrier
): number {
  return (
    (dam.end.x - dam.start.x) * (y - dam.start.y) -
    (dam.end.y - dam.start.y) * (x - dam.start.x)
  );
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(value, 1)));
}

function resolutionForSize(
  size: number,
  settings: SimulationSettings
): number {
  const desired = nextPowerOfTwo(
    Math.ceil(size / settings.targetDemCellSize)
  );
  return Math.min(
    Math.max(desired, MIN_RESOLUTION),
    settings.maxBasinResolution
  );
}

function createSamplingCenter(
  seed: Point,
  dam: DamBarrier,
  size: number
): Point {
  const dx = dam.end.x - dam.start.x;
  const dy = dam.end.y - dam.start.y;
  const damLength = Math.hypot(dx, dy);

  if (damLength < 1) {
    return seed.clone();
  }

  const midX = (dam.start.x + dam.end.x) / 2;
  const midY = (dam.start.y + dam.end.y) / 2;
  const seedSideValue = sideOfLine(seed.x, seed.y, dam);
  const seedSide = Math.sign(seedSideValue) || 1;
  const nx = (-dy / damLength) * seedSide;
  const ny = (dx / damLength) * seedSide;
  const seedNormalDistance = Math.abs(seedSideValue) / damLength;

  // Keep the sampling frame anchored to the dam rather than to the seed.
  // The seed selects the connected component; it should not be able to drag
  // or visually "rotate" the reservoir domain when it happens to be far away.
  const upstreamOffset = Math.min(
    Math.max(seedNormalDistance * 0.35, size * 0.16),
    size * 0.30
  );

  return new Point({
    x: midX + nx * upstreamOffset,
    y: midY + ny * upstreamOffset,
    z: seed.z,
    spatialReference: seed.spatialReference
  });
}

function initialDomainSize(
  seed: Point,
  dam: DamBarrier
): number {
  const minX = Math.min(seed.x, dam.start.x, dam.end.x);
  const maxX = Math.max(seed.x, dam.start.x, dam.end.x);
  const minY = Math.min(seed.y, dam.start.y, dam.end.y);
  const maxY = Math.max(seed.y, dam.start.y, dam.end.y);

  return Math.max(
    420,
    maxX - minX + DOMAIN_MARGIN * 2,
    maxY - minY + DOMAIN_MARGIN * 2
  );
}

async function queryElevations(
  view: SceneView,
  points: number[][],
  spatialReference: Point["spatialReference"]
): Promise<number[]> {
  const map = view.map;
  if (!map) {
    throw new Error("SceneView does not have an initialized map.");
  }

  const elevations: number[] = [];

  for (let offset = 0; offset < points.length; offset += ELEVATION_BATCH_SIZE) {
    const batch = points.slice(offset, offset + ELEVATION_BATCH_SIZE);
    const samples = new Multipoint({
      spatialReference,
      points: batch
    });

    const result = await map.ground.queryElevation(samples, {
      demResolution: "finest-contiguous"
    });

    for (const sampledPoint of result.geometry.points) {
      const elevation = sampledPoint[2];
      elevations.push(
        elevation !== undefined && Number.isFinite(elevation)
          ? elevation
          : Number.NaN
      );
    }
  }

  return elevations;
}

export async function resolveDamEndAtCrest(
  view: SceneView,
  start: Point,
  candidate: Point,
  maxExtension = 1600
): Promise<Point> {
  const crestElevation = start.z;

  if (
    crestElevation === undefined ||
    !Number.isFinite(crestElevation)
  ) {
    throw new Error("Unable to determine the dam crest elevation.");
  }

  const dx = candidate.x - start.x;
  const dy = candidate.y - start.y;
  const clickedDistance = Math.hypot(dx, dy);

  if (clickedDistance < 1) {
    throw new Error("The dam barrier is too short.");
  }

  const clickedElevation = candidate.z;
  if (
    clickedElevation !== undefined &&
    Number.isFinite(clickedElevation) &&
    clickedElevation >= crestElevation
  ) {
    const end = candidate.clone();
    end.z = crestElevation;
    return end;
  }

  const ux = dx / clickedDistance;
  const uy = dy / clickedDistance;
  const searchEnd = Math.min(clickedDistance + maxExtension, 4000);
  const sampleSpacing = 10;
  const sampleCount = Math.max(
    2,
    Math.ceil((searchEnd - clickedDistance) / sampleSpacing) + 1
  );

  const points: number[][] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const distance =
      clickedDistance +
      ((searchEnd - clickedDistance) * i) / (sampleCount - 1);
    points.push([
      start.x + ux * distance,
      start.y + uy * distance
    ]);
  }

  const elevations = await queryElevations(
    view,
    points,
    start.spatialReference
  );

  let previousDistance = clickedDistance;
  let previousElevation =
    clickedElevation !== undefined && Number.isFinite(clickedElevation)
      ? clickedElevation
      : elevations[0];

  for (let i = 0; i < elevations.length; i += 1) {
    const elevation = elevations[i];
    if (elevation === undefined || !Number.isFinite(elevation)) {
      continue;
    }

    const distance =
      clickedDistance +
      ((searchEnd - clickedDistance) * i) / (sampleCount - 1);

    if (
      previousElevation !== undefined &&
      Number.isFinite(previousElevation) &&
      previousElevation < crestElevation &&
      elevation >= crestElevation
    ) {
      const denominator = elevation - previousElevation;
      const ratio =
        denominator === 0
          ? 1
          : (crestElevation - previousElevation) / denominator;
      const intersectionDistance =
        previousDistance + (distance - previousDistance) * ratio;

      return new Point({
        x: start.x + ux * intersectionDistance,
        y: start.y + uy * intersectionDistance,
        z: crestElevation,
        spatialReference: start.spatialReference
      });
    }

    previousDistance = distance;
    previousElevation = elevation;
  }

  throw new Error(
    "The second dam side does not reach the crest elevation in the search direction."
  );
}

async function estimateUpstreamSide(
  view: SceneView,
  dam: DamBarrier
): Promise<-1 | 0 | 1> {
  const dx = dam.end.x - dam.start.x;
  const dy = dam.end.y - dam.start.y;
  const length = Math.hypot(dx, dy);

  if (length < 1) {
    return 0;
  }

  const midX = (dam.start.x + dam.end.x) / 2;
  const midY = (dam.start.y + dam.end.y) / 2;
  const nx = -dy / length;
  const ny = dx / length;
  const offsets = [60, 120, 240];
  const points: number[][] = [];

  for (const distance of offsets) {
    points.push([midX + nx * distance, midY + ny * distance]);
  }
  for (const distance of offsets) {
    points.push([midX - nx * distance, midY - ny * distance]);
  }

  const elevations = await queryElevations(
    view,
    points,
    dam.start.spatialReference
  );

  const plus = elevations.slice(0, offsets.length)
    .filter((value) => Number.isFinite(value));
  const minus = elevations.slice(offsets.length)
    .filter((value) => Number.isFinite(value));

  if (plus.length === 0 || minus.length === 0) {
    return 0;
  }

  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

  const difference = average(plus) - average(minus);

  // If the cross-valley terrain is almost symmetric, do not guess.
  if (Math.abs(difference) < 2) {
    return 0;
  }

  // The upstream valley generally rises away from the dam while the
  // downstream side falls away. Positive normal corresponds to sideOfLine > 0.
  return difference > 0 ? 1 : -1;
}

export async function findAutomaticBasinSeed(
  view: SceneView,
  dam: DamBarrier,
  settings: SimulationSettings
): Promise<Point | null> {
  const upstreamSide = await estimateUpstreamSide(view, dam);
  if (upstreamSide === 0) {
    return null;
  }

  const crestElevation = dam.start.z;
  if (crestElevation === undefined || !Number.isFinite(crestElevation)) {
    return null;
  }

  const waterElevation =
    crestElevation - Math.max(settings.reservoirFreeboard, 0);
  const dx = dam.end.x - dam.start.x;
  const dy = dam.end.y - dam.start.y;
  const length = Math.hypot(dx, dy);

  if (length < 1) {
    return null;
  }

  const tx = dx / length;
  const ty = dy / length;
  const nx = (-dy / length) * upstreamSide;
  const ny = (dx / length) * upstreamSide;
  const alongFractions = [0.35, 0.5, 0.65];
  const offsets = [30, 60, 120, 240, 360];
  const points: number[][] = [];

  for (const offset of offsets) {
    for (const fraction of alongFractions) {
      const baseX = dam.start.x + dx * fraction;
      const baseY = dam.start.y + dy * fraction;
      points.push([
        baseX + nx * offset + tx * 0,
        baseY + ny * offset + ty * 0
      ]);
    }
  }

  const elevations = await queryElevations(
    view,
    points,
    dam.start.spatialReference
  );

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < elevations.length; i += 1) {
    const elevation = elevations[i];
    if (
      elevation === undefined ||
      !Number.isFinite(elevation) ||
      elevation >= waterElevation
    ) {
      continue;
    }

    const offsetIndex = Math.floor(i / alongFractions.length);
    const fractionIndex = i % alongFractions.length;
    const offset = offsets[offsetIndex] ?? offsets[offsets.length - 1];
    const alongFraction =
      alongFractions[fractionIndex] ?? 0.5;

    // Prefer a candidate close to the dam and close to the middle of the
    // valley cross-section. A low terrain point still helps, but should not
    // overpower the geometric signal and pull the seed into a side branch.
    const depth = waterElevation - elevation;
    const centralityPenalty =
      Math.abs(alongFraction - 0.5) * Math.max(length * 0.35, 80);
    const score =
      offset +
      centralityPenalty -
      Math.min(depth, 40) * 0.35;

    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) {
    return null;
  }

  return new Point({
    x: points[bestIndex][0],
    y: points[bestIndex][1],
    z: elevations[bestIndex],
    spatialReference: dam.start.spatialReference
  });
}

async function sampleDamProfile(
  view: SceneView,
  dam: DamBarrier,
  sampleCount = 65
): Promise<DamProfile> {
  const points: number[][] = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / (sampleCount - 1);
    points.push([
      dam.start.x + (dam.end.x - dam.start.x) * t,
      dam.start.y + (dam.end.y - dam.start.y) * t
    ]);
  }

  const elevations = await queryElevations(
    view,
    points,
    dam.start.spatialReference
  );

  if (
    elevations.length !== sampleCount ||
    elevations.some((elevation) => !Number.isFinite(elevation))
  ) {
    throw new Error("Unable to sample the terrain profile along the dam.");
  }

  const crestElevation = dam.start.z;

  if (
    crestElevation === undefined ||
    !Number.isFinite(crestElevation)
  ) {
    throw new Error("Unable to determine the horizontal dam crest elevation.");
  }

  const valleyFloorElevation = Math.min(...elevations);
  const terrainPoints = points.map((point, index) => [
    point[0],
    point[1],
    elevations[index] ?? valleyFloorElevation
  ]);

  return {
    crestElevation,
    valleyFloorElevation,
    maxDamHeight: Math.max(crestElevation - valleyFloorElevation, 0),
    terrainPoints
  };
}

function interpolateProfileIntersection(
  above: number[],
  below: number[],
  elevation: number
): number[] {
  const z0 = above[2];
  const z1 = below[2];
  const denominator = z1 - z0;
  const t =
    denominator === 0
      ? 0
      : Math.min(Math.max((elevation - z0) / denominator, 0), 1);

  return [
    above[0] + (below[0] - above[0]) * t,
    above[1] + (below[1] - above[1]) * t,
    elevation
  ];
}

function waterLevelSpan(
  profile: number[][],
  waterElevation: number
): { start: number[]; end: number[] } {
  const wetIndices = profile
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point[2] <= waterElevation)
    .map(({ index }) => index);

  if (wetIndices.length === 0) {
    throw new Error("The water level does not intersect the dam profile.");
  }

  const first = wetIndices[0];
  const last = wetIndices[wetIndices.length - 1];

  let start = [
    profile[first][0],
    profile[first][1],
    waterElevation
  ];
  let end = [
    profile[last][0],
    profile[last][1],
    waterElevation
  ];

  if (first > 0) {
    start = interpolateProfileIntersection(
      profile[first - 1],
      profile[first],
      waterElevation
    );
  }

  if (last < profile.length - 1) {
    end = interpolateProfileIntersection(
      profile[last + 1],
      profile[last],
      waterElevation
    );
  }

  return { start, end };
}

async function sampleConnectedMask(
  view: SceneView,
  center: Point,
  seed: Point,
  dam: DamBarrier,
  size: number,
  resolution: number,
  waterElevation: number
): Promise<BasinSample> {
  const half = size / 2;
  const step = size / resolution;
  const cellArea = step * step;
  const points: number[][] = [];

  for (let row = 0; row < resolution; row += 1) {
    const y = center.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const x = center.x - half + (col + 0.5) * step;
      points.push([x, y]);
    }
  }

  const elevations = await queryElevations(
    view,
    points,
    center.spatialReference
  );

  const candidate = new Uint8Array(resolution * resolution);
  const seedSide = sideOfLine(seed.x, seed.y, dam);

  if (Math.abs(seedSide) < 0.001) {
    throw new Error("Place the reservoir seed clearly upstream from the dam.");
  }

  for (let row = 0; row < resolution; row += 1) {
    const y = center.y - half + (row + 0.5) * step;

    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      const elevation = elevations[index];

      if (
        elevation === undefined ||
        !Number.isFinite(elevation) ||
        elevation > waterElevation
      ) {
        continue;
      }

      const x = center.x - half + (col + 0.5) * step;
      const cellSide = sideOfLine(x, y, dam);
      const damDx = dam.end.x - dam.start.x;
      const damDy = dam.end.y - dam.start.y;
      const damLength = Math.hypot(damDx, damDy);
      const distanceToDam =
        damLength > 0 ? Math.abs(cellSide) / damLength : Number.POSITIVE_INFINITY;

      // Keep only the upstream half-plane and leave a narrow dry strip at the
      // dam itself. The rendered dam face fills this strip and the water mask
      // cannot bleed one cell into the downstream side.
      if (cellSide * seedSide > 0 && distanceToDam > step * 0.6) {
        candidate[index] = 255;
      }
    }
  }

  const seedCol = Math.floor(
    (seed.x - (center.x - half)) / step
  );
  const seedRow = Math.floor(
    (seed.y - (center.y - half)) / step
  );

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

    // Permit a diagonal only when at least one orthogonal bridge cell is
    // itself a valid wet candidate. This preserves narrow diagonal valleys
    // without allowing corner-only connections to jump across a ridge and
    // select a rotated or spurious reservoir component.
    const tryAddDiagonal = (
      r: number,
      c: number,
      bridgeA: number,
      bridgeB: number
    ) => {
      if (r < 0 || r >= resolution || c < 0 || c >= resolution) {
        return;
      }

      if (
        candidate[bridgeA] === 0 &&
        candidate[bridgeB] === 0
      ) {
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
  let volumeM3 = 0;
  let maxDepth = 0;
  let minWetDistanceToDam = Number.POSITIVE_INFINITY;
  let nearDamContactCells = 0;
  let nearDamMinT = Number.POSITIVE_INFINITY;
  let nearDamMaxT = Number.NEGATIVE_INFINITY;
  const depth = new Float32Array(mask.length);
  const damDx = dam.end.x - dam.start.x;
  const damDy = dam.end.y - dam.start.y;
  const damLengthSquared = damDx * damDx + damDy * damDy;
  const nearDamTolerance = Math.max(step * 3, 35);

  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) {
      continue;
    }

    wetCellCount += 1;

    const row = Math.floor(i / resolution);
    const col = i % resolution;
    const x = center.x - half + (col + 0.5) * step;
    const y = center.y - half + (row + 0.5) * step;
    const damSide = sideOfLine(x, y, dam);
    const damLength = Math.sqrt(damLengthSquared);
    if (damLength > 0) {
      const distanceToDam = Math.abs(damSide) / damLength;
      minWetDistanceToDam = Math.min(
        minWetDistanceToDam,
        distanceToDam
      );

      if (distanceToDam <= nearDamTolerance) {
        const t =
          ((x - dam.start.x) * damDx +
            (y - dam.start.y) * damDy) /
          damLengthSquared;

        if (t >= -0.15 && t <= 1.15) {
          nearDamContactCells += 1;
          nearDamMinT = Math.min(nearDamMinT, t);
          nearDamMaxT = Math.max(nearDamMaxT, t);
        }
      }
    }

    const terrainElevation = elevations[i];

    if (terrainElevation !== undefined && Number.isFinite(terrainElevation)) {
      const cellDepth = Math.max(waterElevation - terrainElevation, 0);
      depth[i] = cellDepth;
      maxDepth = Math.max(maxDepth, cellDepth);
      volumeM3 += cellDepth * cellArea;
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

  // Reject components that only graze a remote dam extension. A valid
  // reservoir should contact the actual barrier span, not wrap around an
  // abutment or connect through a concave side branch.
  if (nearDamMaxT < 0 || nearDamMinT > 1) {
    throw new Error(
      "The reservoir contacts the dam outside the barrier span. Reposition the dam or choose another upstream seed."
    );
  }

  return {
    mask,
    depth,
    maxDepth,
    wetCellCount,
    touchesBoundary: touchesMaskBoundary(mask, resolution),
    areaM2: wetCellCount * cellArea,
    volumeM3,
    nearDamContactCells,
    nearDamMinT,
    nearDamMaxT
  };
}

export async function sampleWaterBasin(
  view: SceneView,
  seed: Point,
  dam: DamBarrier,
  settings: SimulationSettings,
  options: { trustSeedSide?: boolean } = {}
): Promise<SampledWaterBasin> {
  if (!seed.spatialReference.isWebMercator) {
    throw new Error("The current POC expects a Web Mercator SceneView.");
  }

  const damLength = Math.hypot(
    dam.end.x - dam.start.x,
    dam.end.y - dam.start.y
  );

  if (damLength < 10) {
    throw new Error("The dam barrier is too short.");
  }

  const upstreamSide = options.trustSeedSide
    ? 0
    : await estimateUpstreamSide(view, dam);
  const seedSide = Math.sign(sideOfLine(seed.x, seed.y, dam));

  if (
    !options.trustSeedSide &&
    upstreamSide !== 0 &&
    seedSide !== 0 &&
    seedSide !== upstreamSide
  ) {
    throw new Error(
      "The selected point is downstream of the dam. Shift+click behind the barrier on the upstream side."
    );
  }

  const profile = await sampleDamProfile(view, dam);
  const waterElevation =
    profile.crestElevation - Math.max(settings.reservoirFreeboard, 0);

  const seedElevation = seed.z;
  if (
    seedElevation === undefined ||
    !Number.isFinite(seedElevation) ||
    seedElevation >= waterElevation
  ) {
    throw new Error(
      "Place the reservoir seed upstream on terrain below the dam water level."
    );
  }

  let size = Math.min(
    initialDomainSize(seed, dam),
    settings.maxBasinExtent
  );
  let center = createSamplingCenter(seed, dam, size);
  let resolution = resolutionForSize(size, settings);
  let sampled: BasinSample;

  while (true) {
    resolution = resolutionForSize(size, settings);
    center = createSamplingCenter(seed, dam, size);

    sampled = await sampleConnectedMask(
      view,
      center,
      seed,
      dam,
      size,
      resolution,
      waterElevation
    );

    if (!sampled.touchesBoundary) {
      break;
    }

    if (size >= settings.maxBasinExtent) {
      throw new Error(
        `The reservoir does not close within ${settings.maxBasinExtent} m. Click upstream behind the dam or reposition the barrier.`
      );
    }

    size = Math.min(size * 1.5, settings.maxBasinExtent);
  }

  const levelSpan = waterLevelSpan(
    profile.terrainPoints,
    waterElevation
  );

  return {
    center,
    size,
    resolution,
    cellSize: size / resolution,
    waterElevation,
    damCrestElevation: profile.crestElevation,
    maxDamHeight: profile.maxDamHeight,
    mask: sampled.mask,
    depth: sampled.depth,
    maxDepth: sampled.maxDepth,
    wetCellCount: sampled.wetCellCount,
    touchesBoundary: sampled.touchesBoundary,
    damLength,
    areaM2: sampled.areaM2,
    volumeM3: sampled.volumeM3,
    damProfilePoints: profile.terrainPoints,
    waterLevelStart: levelSpan.start,
    waterLevelEnd: levelSpan.end
  };
}
