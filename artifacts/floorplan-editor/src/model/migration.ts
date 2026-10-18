import { GEOMETRY_EPSILON, polygonArea, validateFloorPlan, wallLength } from './geometry.ts';
import type {
  Door,
  FloorPlan,
  LegacyDoor,
  LegacyFloorPlan,
  LegacyRoom,
  LegacyWall,
  MigrationCandidate,
  MigrationPreview,
  Point,
  Room,
  RoomBoundaryRef,
  Vertex,
  Wall,
} from './types.ts';

type RawSegment = {
  id: string;
  start: Point;
  end: Point;
  thicknessMm: number;
  wallId?: string;
  roomId?: string;
  edgeIndex?: number;
  order: number;
};

type SplitPiece = {
  raw: RawSegment;
  t0: number;
  t1: number;
  start: Point;
  end: Point;
  startVertexId: string;
  endVertexId: string;
  groupKey: string;
};

type WallGroup = {
  key: string;
  pieces: SplitPiece[];
  wall: Wall;
};

type BuiltGraph = {
  vertices: Vertex[];
  walls: Wall[];
  roomBoundaries: Map<string, RoomBoundaryRef[]>;
  doors: Door[];
  generatedWallCount: number;
  splitWallCount: number;
  warnings: string[];
  errors: string[];
};

export const sampleLegacyPlan: LegacyFloorPlan = {
  id: 'plan-kusunoki-01',
  name: '楠木邸｜リノベーション案',
  width: 12000,
  height: 8000,
  units: 'mm',
  schemaVersion: 1,
  rooms: [
    { id: 'room-living', name: 'リビング', x: 0, y: 0, width: 7000, height: 5000 },
    { id: 'room-kitchen', name: 'キッチン', x: 7000, y: 0, width: 5000, height: 5000 },
    { id: 'room-hall', name: '廊下', x: 0, y: 5000, width: 4000, height: 3000 },
    { id: 'room-bedroom-a', name: '寝室', x: 4000, y: 5000, width: 4000, height: 3000 },
    { id: 'room-bedroom-b', name: '洋室', x: 8000, y: 5000, width: 4000, height: 3000 },
  ],
  walls: [
    { id: 'wall-north', x1: 0, y1: 0, x2: 12000, y2: 0, thickness: 180 },
    { id: 'wall-east', x1: 12000, y1: 0, x2: 12000, y2: 8000, thickness: 180 },
    { id: 'wall-south', x1: 12000, y1: 8000, x2: 0, y2: 8000, thickness: 180 },
    { id: 'wall-west', x1: 0, y1: 8000, x2: 0, y2: 0, thickness: 180 },
    { id: 'wall-kitchen-divider', x1: 7000, y1: 0, x2: 7000, y2: 5000, thickness: 120 },
    { id: 'wall-lower-divider', x1: 0, y1: 5000, x2: 12000, y2: 5000, thickness: 120 },
    { id: 'wall-bedroom-left', x1: 4000, y1: 5000, x2: 4000, y2: 8000, thickness: 120 },
    { id: 'wall-bedroom-right', x1: 8000, y1: 5000, x2: 8000, y2: 8000, thickness: 120 },
  ],
  doors: [
    { id: 'door-entry', wallId: 'wall-south', offset: 8500, width: 900 },
    { id: 'door-kitchen', wallId: 'wall-kitchen-divider', offset: 1700, width: 820 },
    { id: 'door-living-hall', wallId: 'wall-lower-divider', offset: 1500, width: 820 },
    { id: 'door-bedroom-a', wallId: 'wall-bedroom-left', offset: 1200, width: 780 },
    { id: 'door-bedroom-b', wallId: 'wall-bedroom-right', offset: 1200, width: 780 },
  ],
};

export function validateLegacyPlan(value: unknown): string[] {
  if (!isRecord(value)) return ['旧形式のJSONはオブジェクトである必要があります。'];
  const plan = value as unknown as LegacyFloorPlan;
  if (plan.schemaVersion !== 1 || plan.units !== 'mm') return ['移行できるのは mm 単位の schemaVersion 1 のJSONです。'];
  if (typeof plan.id !== 'string' || !plan.id.trim() || typeof plan.name !== 'string' || !plan.name.trim() ||
      !Number.isFinite(plan.width) || !Number.isFinite(plan.height) || plan.width <= 0 || plan.height <= 0) {
    return ['旧形式の図面ID、名前、幅、高さを確認してください。'];
  }
  if (!Array.isArray(plan.rooms) || !Array.isArray(plan.walls) || !Array.isArray(plan.doors)) {
    return ['旧形式の部屋・壁・扉の配列が不足しています。'];
  }
  const errors: string[] = [];
  const ids = new Set<string>();
  const addId = (id: unknown) => {
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) {
      errors.push('旧形式のIDに空欄または重複があります。');
    } else {
      ids.add(id);
    }
  };
  for (const room of plan.rooms) {
    if (!room || typeof room.name !== 'string' ||
        ![room.x, room.y, room.width, room.height].every(Number.isFinite) ||
        room.x < 0 || room.y < 0 || room.width <= 0 || room.height <= 0 ||
        room.x + room.width > plan.width || room.y + room.height > plan.height) {
      errors.push('旧形式の部屋の座標または寸法が不正です。');
      continue;
    }
    addId(room.id);
  }
  const wallById = new Map<string, LegacyWall>();
  for (const wall of plan.walls) {
    if (!wall || ![wall.x1, wall.y1, wall.x2, wall.y2, wall.thickness].every(Number.isFinite) ||
        wall.thickness <= 0 || Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) <= GEOMETRY_EPSILON ||
        Math.min(wall.x1, wall.x2) < 0 || Math.max(wall.x1, wall.x2) > plan.width ||
        Math.min(wall.y1, wall.y2) < 0 || Math.max(wall.y1, wall.y2) > plan.height) {
      errors.push('旧形式の壁の座標または厚みが不正です。');
      continue;
    }
    addId(wall.id);
    wallById.set(wall.id, wall);
  }
  for (const door of plan.doors) {
    if (!door || typeof door.wallId !== 'string' || !Number.isFinite(door.offset) || door.offset < 0 ||
        !Number.isFinite(door.width) || door.width <= 0) {
      errors.push('旧形式の扉データが不正です。');
      continue;
    }
    const wall = wallById.get(door.wallId);
    if (!wall || door.offset + door.width > legacyWallLength(wall) + GEOMETRY_EPSILON) {
      errors.push(`扉「${door.id}」の壁参照または位置が不正です。`);
      continue;
    }
    addId(door.id);
  }
  return [...new Set(errors)];
}

export function createMigrationPreview(value: unknown, sourceJson: string): MigrationPreview {
  const errors = validateLegacyPlan(value);
  if (errors.length) throw new Error(errors.join('\n'));
  const legacy = value as LegacyFloorPlan;
  return {
    legacy,
    sourceJson,
    candidates: [
      buildRoomsAuthoritativeCandidate(legacy),
      buildWallsAuthoritativeCandidate(legacy),
    ],
  };
}

export function createSampleFloorPlan(): FloorPlan {
  const candidate = buildRoomsAuthoritativeCandidate(sampleLegacyPlan);
  if (!candidate.plan) throw new Error(`サンプル間取りを作成できません: ${candidate.errors.join(' / ')}`);
  return candidate.plan;
}

function buildRoomsAuthoritativeCandidate(legacy: LegacyFloorPlan): MigrationCandidate {
  const boundarySegments: RawSegment[] = [];
  legacy.rooms.forEach((room, roomIndex) => {
    const corners = [
      { x: room.x, y: room.y },
      { x: room.x + room.width, y: room.y },
      { x: room.x + room.width, y: room.y + room.height },
      { x: room.x, y: room.y + room.height },
    ];
    corners.forEach((start, edgeIndex) => {
      boundarySegments.push({
        id: `room-edge:${room.id}:${edgeIndex}`,
        start,
        end: corners[(edgeIndex + 1) % corners.length],
        thicknessMm: 120,
        roomId: room.id,
        edgeIndex,
        order: roomIndex * 4 + edgeIndex,
      });
    });
  });
  const segments = [
    ...legacy.walls.map((wall, index) => ({
      id: `legacy-wall:${wall.id}`,
      start: { x: wall.x1, y: wall.y1 },
      end: { x: wall.x2, y: wall.y2 },
      thicknessMm: wall.thickness,
      wallId: wall.id,
      order: index,
    })),
    ...boundarySegments,
  ];
  const graph = buildGraph(legacy, segments, boundarySegments);
  const warnings = [...graph.warnings];
  if (graph.generatedWallCount) {
    warnings.push(`${graph.generatedWallCount}本の部屋境界壁を生成しました（厚み120 mm）。`);
  }
  const matchedLegacyWallIds = new Set(
    graph.walls.filter((wall) => !wall.id.includes('-boundary-')).map((wall) => wall.id),
  );
  const standaloneCount = legacy.walls.filter((wall) => !matchedLegacyWallIds.has(wall.id)).length;
  if (standaloneCount) warnings.push(`${standaloneCount}本の旧壁は部屋境界と一致しないため、位置を保って独立壁として残します。`);

  const rooms = legacy.rooms.map((room): Room => ({
    id: room.id,
    name: room.name,
    boundary: graph.roomBoundaries.get(room.id) ?? [],
  }));
  const plan = makePlan(legacy, graph, rooms);
  const validation = validateFloorPlan(plan);
  const allErrors = [...graph.errors, ...validation];
  return {
    id: 'rooms',
    title: '部屋の寸法を優先',
    description: '旧部屋の矩形をそのまま輪郭にし、既存の壁は位置を保って接続・分割します。',
    plan,
    errors: [...new Set(allErrors)],
    warnings,
    generatedWallCount: graph.generatedWallCount,
    splitWallCount: graph.splitWallCount,
  };
}

function buildWallsAuthoritativeCandidate(legacy: LegacyFloorPlan): MigrationCandidate {
  const segments = legacy.walls.map((wall, index) => ({
    id: `legacy-wall:${wall.id}`,
    start: { x: wall.x1, y: wall.y1 },
    end: { x: wall.x2, y: wall.y2 },
    thicknessMm: wall.thickness,
    wallId: wall.id,
    order: index,
  }));
  const graph = buildGraph(legacy, segments, []);
  const faces = extractFaces(graph.vertices, graph.walls);
  const faceForRoom = new Map<string, (typeof faces)[number]>();
  const usedFaceKeys = new Set<string>();
  const errors = [...graph.errors];
  for (const room of legacy.rooms) {
    const center = { x: room.x + room.width / 2, y: room.y + room.height / 2 };
    const matches = faces.filter((face) => pointInPolygon(center, face.points));
    if (matches.length !== 1) {
      errors.push(matches.length
        ? `部屋「${room.name}」の中心が複数の壁輪郭に含まれるため、移行先を特定できません。`
        : `部屋「${room.name}」を囲む閉じた壁輪郭が見つかりません。`);
      continue;
    }
    const face = matches[0];
    if (usedFaceKeys.has(face.key)) {
      errors.push(`複数の部屋が同じ壁輪郭「${face.key}」に割り当たります。`);
      continue;
    }
    usedFaceKeys.add(face.key);
    faceForRoom.set(room.id, face);
  }
  if (faceForRoom.size !== legacy.rooms.length) {
    return {
      id: 'walls',
      title: '既存の壁位置を優先',
      description: '壁の位置から閉じた輪郭を探し、元の部屋名を割り当てます。',
      plan: null,
      errors: [...new Set(errors)],
      warnings: graph.warnings,
      generatedWallCount: 0,
      splitWallCount: graph.splitWallCount,
    };
  }

  const rooms: Room[] = legacy.rooms.map((room) => {
    const face = faceForRoom.get(room.id)!;
    return { id: room.id, name: room.name, boundary: face.boundary };
  });
  const extraFaces = faces.filter((face) => !usedFaceKeys.has(face.key));
  extraFaces.forEach((face, index) => {
    rooms.push({
      id: uniqueGeneratedId(`room-generated-${index + 1}`, new Set([
        ...legacy.rooms.map((room) => room.id),
        ...legacy.walls.map((wall) => wall.id),
        ...legacy.doors.map((door) => door.id),
        ...graph.vertices.map((vertex) => vertex.id),
        ...graph.walls.map((wall) => wall.id),
        ...rooms.map((room) => room.id),
      ])),
      name: `新しい部屋 ${index + 1}`,
      boundary: face.boundary,
    });
  });
  const plan = makePlan(legacy, graph, rooms);
  const validation = validateFloorPlan(plan);
  const allErrors = [...errors, ...validation];
  return {
    id: 'walls',
    title: '既存の壁位置を優先',
    description: '壁の位置から閉じた輪郭を探し、元の部屋名を割り当てます。',
    plan: allErrors.length ? null : plan,
    errors: [...new Set(allErrors)],
    warnings: graph.warnings,
    generatedWallCount: 0,
    splitWallCount: graph.splitWallCount,
  };
}

function buildGraph(legacy: LegacyFloorPlan, segments: RawSegment[], boundarySegments: RawSegment[]): BuiltGraph {
  const errors: string[] = [];
  const warnings: string[] = [];
  const piecesByRaw = splitSegments(segments);
  const usedIds = new Set([
    ...legacy.rooms.map((room) => room.id),
    ...legacy.walls.map((wall) => wall.id),
    ...legacy.doors.map((door) => door.id),
  ]);
  const vertices: Vertex[] = [];
  const vertexIdByPosition = new Map<string, string>();
  const ensureVertex = (point: Point): string => {
    const normalized = normalizePoint(point);
    const key = pointKey(normalized);
    const found = vertexIdByPosition.get(key);
    if (found) return found;
    const id = uniqueGeneratedId(`vertex-${vertices.length + 1}`, usedIds);
    vertices.push({ id, ...normalized });
    vertexIdByPosition.set(key, id);
    return id;
  };

  const groups = new Map<string, SplitPiece[]>();
  const pieceByRaw = new Map<RawSegment, SplitPiece[]>();
  for (const raw of segments) {
    const pieces = (piecesByRaw.get(raw) ?? []).map((piece) => {
      const start = normalizePoint(piece.start);
      const end = normalizePoint(piece.end);
      const startVertexId = ensureVertex(start);
      const endVertexId = ensureVertex(end);
      const groupKey = undirectedKey(startVertexId, endVertexId);
      return { raw, ...piece, start, end, startVertexId, endVertexId, groupKey };
    }).filter((piece) => piece.startVertexId !== piece.endVertexId);
    pieceByRaw.set(raw, pieces);
    for (const piece of pieces) {
      const group = groups.get(piece.groupKey) ?? [];
      group.push(piece);
      groups.set(piece.groupKey, group);
    }
  }

  const legacyRawById = new Map(segments.filter((segment) => segment.wallId).map((segment) => [segment.wallId!, segment]));
  const legacyWallById = new Map(legacy.walls.map((wall) => [wall.id, wall]));
  const preferredGroupByLegacyWall = new Map<string, string>();
  for (const oldWall of legacy.walls) {
    const raw = legacyRawById.get(oldWall.id);
    if (!raw) continue;
    const pieces = pieceByRaw.get(raw) ?? [];
    const relevantDoor = legacy.doors.find((door) => door.wallId === oldWall.id);
    const targetT = relevantDoor ? relevantDoor.offset / legacyWallLength(oldWall) : 0;
    const preferred = pieces.find((piece) => targetT >= piece.t0 - GEOMETRY_EPSILON && targetT <= piece.t1 + GEOMETRY_EPSILON) ?? pieces[0];
    if (preferred) preferredGroupByLegacyWall.set(oldWall.id, preferred.groupKey);
  }

  const primaryLegacyByGroup = new Map<string, string>();
  for (const oldWall of legacy.walls) {
    const key = preferredGroupByLegacyWall.get(oldWall.id);
    if (key && !primaryLegacyByGroup.has(key)) primaryLegacyByGroup.set(key, oldWall.id);
  }
  const groupsSorted = [...groups.entries()].sort(([, first], [, second]) =>
    first[0].raw.order - second[0].raw.order || first[0].t0 - second[0].t0,
  );
  const wallByGroup = new Map<string, Wall>();
  let generatedWallCount = 0;
  const groupIdUse = new Set<string>();
  for (const [key, groupPieces] of groupsSorted) {
    const legacyContributors = groupPieces.filter((piece) => piece.raw.wallId);
    const primaryOldId = primaryLegacyByGroup.get(key);
    const primaryPiece = groupPieces.find((piece) => piece.raw.wallId === primaryOldId) ??
      legacyContributors[0] ?? groupPieces[0];
    const reusedId = primaryOldId && !groupIdUse.has(primaryOldId) ? primaryOldId : null;
    let wallId: string;
    if (reusedId) {
      wallId = reusedId;
      groupIdUse.add(reusedId);
    } else {
      const wallContributor = legacyContributors[0];
      const roomContributor = groupPieces.find((piece) => piece.raw.roomId);
      const source = wallContributor?.raw.wallId
        ? `${wallContributor.raw.wallId}-segment-${Math.round(wallContributor.t0 * 1000000)}`
        : roomContributor?.raw.roomId
          ? `${roomContributor.raw.roomId}-boundary-${(roomContributor.raw.edgeIndex ?? 0) + 1}-${Math.round(roomContributor.t0 * 1000000)}`
          : `wall-generated-${generatedWallCount + 1}`;
      wallId = uniqueGeneratedId(source, usedIds);
      groupIdUse.add(wallId);
    }
    if (!legacyContributors.length) generatedWallCount += 1;
    const thicknesses = [...new Set(legacyContributors.map((piece) => piece.raw.thicknessMm))];
    if (thicknesses.length > 1) warnings.push(`同じ線分に複数の壁厚があるため、壁「${wallId}」には最大値 ${Math.max(...thicknesses)} mm を採用します。`);
    const wall: Wall = {
      id: wallId,
      startVertexId: primaryPiece.startVertexId,
      endVertexId: primaryPiece.endVertexId,
      thicknessMm: thicknesses.length ? Math.max(...thicknesses) : 120,
    };
    wallByGroup.set(key, wall);
  }

  const walls = groupsSorted.map(([key]) => wallByGroup.get(key)!);
  const roomBoundaryRefs = new Map<string, RoomBoundaryRef[]>();
  for (const segment of boundarySegments) {
    const refs = (pieceByRaw.get(segment) ?? []).map((piece): RoomBoundaryRef | null => {
      const wall = wallByGroup.get(piece.groupKey);
      if (!wall) return null;
      const forward = piece.startVertexId === wall.startVertexId && piece.endVertexId === wall.endVertexId;
      return { wallId: wall.id, direction: forward ? 'forward' : 'reverse' };
    }).filter((ref): ref is RoomBoundaryRef => Boolean(ref));
    roomBoundaryRefs.set(segment.roomId!, [...(roomBoundaryRefs.get(segment.roomId!) ?? []), ...refs]);
  }

  const migratedDoors: Door[] = [];
  const doorRawMap = new Map(legacy.walls.map((wall) => [wall.id, legacyRawById.get(wall.id)!]));
  for (const oldDoor of legacy.doors) {
    const oldWall = legacyWallById.get(oldDoor.wallId);
    const raw = doorRawMap.get(oldDoor.wallId);
    if (!oldWall || !raw) {
      errors.push(`扉「${oldDoor.id}」の元の壁が見つかりません。`);
      continue;
    }
    const length = legacyWallLength(oldWall);
    const startT = oldDoor.offset / length;
    const endT = (oldDoor.offset + oldDoor.width) / length;
    const piece = (pieceByRaw.get(raw) ?? []).find((candidate) =>
      startT >= candidate.t0 - GEOMETRY_EPSILON && endT <= candidate.t1 + GEOMETRY_EPSILON,
    );
    if (!piece) {
      errors.push(`扉「${oldDoor.id}」が壁の分割位置をまたぐため、自動移行できません。元JSONを保ったまま、分割位置を修正してください。`);
      continue;
    }
    const migratedWall = wallByGroup.get(piece.groupKey);
    if (!migratedWall) {
      errors.push(`扉「${oldDoor.id}」の移行先の壁が見つかりません。`);
      continue;
    }
    const pieceLength = wallLength({ ...legacyToV2Shell(legacy), vertices, walls }, migratedWall);
    const localOffset = oldDoor.offset - piece.t0 * length;
    const sameDirection = piece.startVertexId === migratedWall.startVertexId;
    const offsetMm = sameDirection ? localOffset : pieceLength - localOffset - oldDoor.width;
    migratedDoors.push({ id: oldDoor.id, wallId: migratedWall.id, offsetMm, widthMm: oldDoor.width });
  }

  const splitWallCount = legacy.walls.filter((wall) => {
    const raw = legacyRawById.get(wall.id);
    return (raw ? pieceByRaw.get(raw)?.length ?? 0 : 0) > 1;
  }).length;
  if (splitWallCount) warnings.push(`${splitWallCount}本の壁を交点で分割し、接続を共有頂点にしました。`);
  if (errors.length) warnings.push('一部の扉または壁を安全に接続できないため、この候補は適用できません。');
  return {
    vertices,
    walls,
    roomBoundaries: roomBoundaryRefs,
    doors: migratedDoors,
    generatedWallCount,
    splitWallCount,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

function splitSegments(segments: RawSegment[]): Map<RawSegment, { t0: number; t1: number; start: Point; end: Point }[]> {
  const params = new Map<RawSegment, number[]>(segments.map((segment) => [segment, [0, 1]]));
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const first = segments[i];
      const second = segments[j];
      for (const [t, u] of segmentCutPairs(first.start, first.end, second.start, second.end)) {
        params.get(first)!.push(t);
        params.get(second)!.push(u);
      }
    }
  }
  const result = new Map<RawSegment, { t0: number; t1: number; start: Point; end: Point }[]>();
  for (const segment of segments) {
    const cuts = [...new Set((params.get(segment) ?? []).map((value) => Math.round(clamp01(value) * 1e12) / 1e12))]
      .sort((a, b) => a - b);
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
    const pieces = [];
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const t0 = cuts[index];
      const t1 = cuts[index + 1];
      if ((t1 - t0) * length <= GEOMETRY_EPSILON) continue;
      pieces.push({ t0, t1, start: interpolate(segment, t0), end: interpolate(segment, t1) });
    }
    result.set(segment, pieces);
  }
  return result;
}

function segmentCutPairs(a: Point, b: Point, c: Point, d: Point): [number, number][] {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const q = subtract(c, a);
  const denominator = cross(r, s);
  const result: [number, number][] = [];
  if (Math.abs(denominator) > GEOMETRY_EPSILON) {
    const t = cross(q, s) / denominator;
    const u = cross(q, r) / denominator;
    if (within01(t) && within01(u)) result.push([clamp01(t), clamp01(u)]);
    return result;
  }
  if (Math.abs(cross(q, r)) > GEOMETRY_EPSILON) return result;
  for (const point of [c, d]) {
    const t = parameterOnSegment(point, a, b);
    if (within01(t)) result.push([clamp01(t), parameterOnSegment(point, c, d)]);
  }
  for (const point of [a, b]) {
    const u = parameterOnSegment(point, c, d);
    if (within01(u)) result.push([parameterOnSegment(point, a, b), clamp01(u)]);
  }
  return result;
}

function extractFaces(vertices: Vertex[], walls: Wall[]): { key: string; points: Point[]; boundary: RoomBoundaryRef[]; area: number }[] {
  const vertexById = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  const adjacency = new Map<string, { vertexId: string; wallId: string }[]>();
  for (const wall of walls) {
    adjacency.set(wall.startVertexId, [...(adjacency.get(wall.startVertexId) ?? []), { vertexId: wall.endVertexId, wallId: wall.id }]);
    adjacency.set(wall.endVertexId, [...(adjacency.get(wall.endVertexId) ?? []), { vertexId: wall.startVertexId, wallId: wall.id }]);
  }
  for (const [vertexId, neighbors] of adjacency) {
    const origin = vertexById.get(vertexId)!;
    neighbors.sort((a, b) => {
      const first = vertexById.get(a.vertexId)!;
      const second = vertexById.get(b.vertexId)!;
      return Math.atan2(first.y - origin.y, first.x - origin.x) -
        Math.atan2(second.y - origin.y, second.x - origin.x);
    });
  }
  const visited = new Set<string>();
  const faces: { key: string; points: Point[]; boundary: RoomBoundaryRef[]; area: number }[] = [];
  for (const wall of walls) {
    for (const [from, to] of [[wall.startVertexId, wall.endVertexId], [wall.endVertexId, wall.startVertexId]]) {
      const initial = halfEdgeKey(wall.id, from);
      if (visited.has(initial)) continue;
      let previousVertexId = from;
      let currentVertexId = to;
      const boundary: RoomBoundaryRef[] = [];
      const localSeen = new Set<string>();
      let closed = false;
      for (let guard = 0; guard <= walls.length * 2 + 1; guard += 1) {
        const currentWall = walls.find((candidate) =>
          (candidate.startVertexId === previousVertexId && candidate.endVertexId === currentVertexId) ||
          (candidate.endVertexId === previousVertexId && candidate.startVertexId === currentVertexId),
        );
        if (!currentWall) break;
        const key = halfEdgeKey(currentWall.id, previousVertexId);
        if (localSeen.has(key)) {
          closed = key === initial;
          break;
        }
        localSeen.add(key);
        visited.add(key);
        boundary.push({
          wallId: currentWall.id,
          direction: currentWall.startVertexId === previousVertexId ? 'forward' : 'reverse',
        });
        const neighbors = adjacency.get(currentVertexId) ?? [];
        const reverseIndex = neighbors.findIndex((neighbor) => neighbor.vertexId === previousVertexId && neighbor.wallId === currentWall.id);
        if (reverseIndex < 0 || !neighbors.length) break;
        const next = neighbors[(reverseIndex - 1 + neighbors.length) % neighbors.length];
        previousVertexId = currentVertexId;
        currentVertexId = next.vertexId;
        if (halfEdgeKey(next.wallId, previousVertexId) === initial) {
          closed = true;
          break;
        }
      }
      if (!closed || boundary.length < 3) continue;
      const points = boundary.map((edge) => {
        const wallRef = walls.find((candidate) => candidate.id === edge.wallId)!;
        const vertexId = edge.direction === 'forward' ? wallRef.startVertexId : wallRef.endVertexId;
        return vertexById.get(vertexId)!;
      });
      const area = polygonArea(points);
      if (area <= GEOMETRY_EPSILON) continue;
      const key = boundary.map((edge) => `${edge.wallId}:${edge.direction}`).join('|');
      faces.push({ key, points, boundary, area });
    }
  }
  return dedupeFaces(faces);
}

function dedupeFaces<T extends { points: Point[]; boundary: RoomBoundaryRef[]; area: number }>(
  faces: T[],
): T[] {
  const seen = new Set<string>();
  return faces.filter((face) => {
    const signature = face.boundary.map((edge) => edge.wallId).sort().join('|');
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const first = polygon[i];
    const second = polygon[j];
    const crosses = (first.y > point.y) !== (second.y > point.y) &&
      point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function makePlan(legacy: LegacyFloorPlan, graph: BuiltGraph, rooms: Room[]): FloorPlan {
  return {
    id: legacy.id,
    name: legacy.name,
    width: legacy.width,
    height: legacy.height,
    units: 'mm',
    schemaVersion: 2,
    vertices: graph.vertices,
    walls: graph.walls,
    rooms,
    doors: graph.doors,
  };
}

function legacyToV2Shell(legacy: LegacyFloorPlan): FloorPlan {
  return {
    id: legacy.id,
    name: legacy.name,
    width: legacy.width,
    height: legacy.height,
    units: 'mm',
    schemaVersion: 2,
    vertices: [],
    walls: [],
    rooms: [],
    doors: [],
  };
}

function legacyWallLength(wall: LegacyWall): number {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

function interpolate(segment: RawSegment, t: number): Point {
  return normalizePoint({
    x: segment.start.x + (segment.end.x - segment.start.x) * t,
    y: segment.start.y + (segment.end.y - segment.start.y) * t,
  });
}

function normalizePoint(point: Point): Point {
  return { x: Math.round(point.x * 1e6) / 1e6, y: Math.round(point.y * 1e6) / 1e6 };
}

function pointKey(point: Point): string {
  return `${Math.round(point.x * 1e6)}:${Math.round(point.y * 1e6)}`;
}

function undirectedKey(first: string, second: string): string {
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function halfEdgeKey(wallId: string, fromVertexId: string): string {
  return `${wallId}:${fromVertexId}`;
}

function parameterOnSegment(point: Point, start: Point, end: Point): number {
  const vector = subtract(end, start);
  const denominator = dot(vector, vector);
  return denominator <= GEOMETRY_EPSILON ? 0 : dot(subtract(point, start), vector) / denominator;
}

function uniqueGeneratedId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function segmentKeyForPiece(start: string, end: string): string {
  return start < end ? `${start}|${end}` : `${end}|${start}`;
}

function cross(first: Point, second: Point): number {
  return first.x * second.y - first.y * second.x;
}

function dot(first: Point, second: Point): number {
  return first.x * second.x + first.y * second.y;
}

function subtract(first: Point, second: Point): Point {
  return { x: first.x - second.x, y: first.y - second.y };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function within01(value: number): boolean {
  return value >= -GEOMETRY_EPSILON && value <= 1 + GEOMETRY_EPSILON;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
