import type { FloorPlan, Point, Room, Vertex, Wall } from './types.ts';

export const GEOMETRY_EPSILON = 1e-6;

export function wallLength(plan: FloorPlan, wall: Wall): number {
  const vertices = new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
  const start = vertices.get(wall.startVertexId);
  const end = vertices.get(wall.endVertexId);
  if (!start || !end) return 0;
  return Math.hypot(end.x - start.x, end.y - start.y);
}

export function wallPoints(plan: FloorPlan, wall: Wall): { start: Vertex; end: Vertex } {
  const vertices = new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
  const start = vertices.get(wall.startVertexId);
  const end = vertices.get(wall.endVertexId);
  if (!start || !end) throw new Error(`壁 ${wall.id} が参照する頂点がありません。`);
  return { start, end };
}

export function pointOnWall(plan: FloorPlan, wall: Wall, offsetMm: number): Point {
  const { start, end } = wallPoints(plan, wall);
  const length = wallLength(plan, wall);
  const ratio = length === 0 ? 0 : offsetMm / length;
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
}

export function roomOutline(plan: FloorPlan, room: Room): Point[] {
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  return room.boundary.map((segment) => {
    const wall = walls.get(segment.wallId);
    if (!wall) throw new Error(`部屋 ${room.id} の輪郭が壁 ${segment.wallId} を参照していますが、壁がありません。`);
    const { start, end } = wallPoints(plan, wall);
    return segment.direction === 'forward' ? start : end;
  });
}

export function roomBounds(plan: FloorPlan, room: Room): { x: number; y: number; width: number; height: number } {
  const points = roomOutline(plan, room);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function polygonArea(points: Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

export function validateFloorPlan(value: unknown): string[] {
  if (!isRecord(value)) return ['間取りJSONはオブジェクトである必要があります。'];
  const plan = value as unknown as FloorPlan;
  if (typeof plan.id !== 'string' || !plan.id.trim() || typeof plan.name !== 'string' || !plan.name.trim()) {
    return ['間取りIDと名前が必要です。'];
  }
  if (!Number.isFinite(plan.width) || !Number.isFinite(plan.height) || plan.width <= 0 || plan.height <= 0) {
    return ['図面の幅と高さは正の数で指定してください。'];
  }
  if (plan.units !== 'mm' || plan.schemaVersion !== 2) {
    return ['JSON形式の単位は mm、schemaVersion は 2 である必要があります。'];
  }
  if (!Array.isArray(plan.vertices) || !Array.isArray(plan.walls) || !Array.isArray(plan.rooms) || !Array.isArray(plan.doors)) {
    return ['頂点・壁・部屋・扉の配列が不足しています。'];
  }
  if (plan.vertices.length < 3 || plan.walls.length < 3 || plan.rooms.length < 1) {
    return ['間取りには少なくとも3つの頂点と壁、1つの部屋が必要です。'];
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  const addId = (id: unknown, label: string) => {
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`${label}にIDがありません。`);
      return;
    }
    if (ids.has(id)) errors.push(`ID「${id}」が重複しています。`);
    ids.add(id);
  };

  const vertexById = new Map<string, Vertex>();
  const vertexByPosition = new Map<string, string>();
  for (const vertex of plan.vertices) {
    if (!vertex || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
      errors.push('頂点の座標が不正です。');
      continue;
    }
    addId(vertex.id, '頂点');
    if (vertex.x < 0 || vertex.y < 0 || vertex.x > plan.width || vertex.y > plan.height) {
      errors.push(`頂点「${vertex.id}」が図面の範囲外です。`);
    }
    const position = pointKey(vertex);
    const duplicate = vertexByPosition.get(position);
    if (duplicate && duplicate !== vertex.id) {
      errors.push(`同じ位置に別IDの頂点「${duplicate}」「${vertex.id}」があります。共有頂点に統合してください。`);
    }
    vertexByPosition.set(position, vertex.id);
    vertexById.set(vertex.id, vertex);
  }

  const wallById = new Map<string, Wall>();
  for (const wall of plan.walls) {
    if (!wall) {
      errors.push('壁のデータが不正です。');
      continue;
    }
    addId(wall.id, '壁');
    const start = vertexById.get(wall.startVertexId);
    const end = vertexById.get(wall.endVertexId);
    if (!start || !end) {
      errors.push(`壁「${wall.id}」が存在しない頂点を参照しています。`);
      continue;
    }
    if (wall.startVertexId === wall.endVertexId || Math.hypot(end.x - start.x, end.y - start.y) <= GEOMETRY_EPSILON) {
      errors.push(`壁「${wall.id}」の長さが0です。`);
    }
    if (!Number.isFinite(wall.thicknessMm) || wall.thicknessMm <= 0) {
      errors.push(`壁「${wall.id}」の厚みが不正です。`);
    }
    wallById.set(wall.id, wall);
  }

  for (const vertex of plan.vertices) {
    if (!plan.walls.some((wall) => wall.startVertexId === vertex.id || wall.endVertexId === vertex.id)) {
      errors.push(`頂点「${vertex.id}」がどの壁にも使われていません。`);
    }
  }

  for (let i = 0; i < plan.walls.length; i += 1) {
    for (let j = i + 1; j < plan.walls.length; j += 1) {
      const first = plan.walls[i];
      const second = plan.walls[j];
      const a = vertexById.get(first.startVertexId);
      const b = vertexById.get(first.endVertexId);
      const c = vertexById.get(second.startVertexId);
      const d = vertexById.get(second.endVertexId);
      if (!a || !b || !c || !d) continue;
      const relation = segmentRelation(a, b, c, d);
      if (relation.kind === 'overlap') {
        errors.push(`壁「${first.id}」と「${second.id}」が重なっています。`);
      } else if (relation.kind === 'point') {
        const firstId = endpointIdAt(first, relation.t);
        const secondId = endpointIdAt(second, relation.u);
        if (!firstId || firstId !== secondId) {
          errors.push(`壁「${first.id}」と「${second.id}」の交点が共有頂点になっていません。`);
        }
      }
    }
  }

  for (const room of plan.rooms) {
    if (!room) {
      errors.push('部屋のデータが不正です。');
      continue;
    }
    addId(room.id, '部屋');
    if (typeof room.name !== 'string' || !room.name.trim() || !Array.isArray(room.boundary) || room.boundary.length < 3) {
      errors.push(`部屋「${room.id}」には名前と3辺以上の輪郭が必要です。`);
      continue;
    }
    const ordered = room.boundary.map((segment) => {
      const wall = segment && wallById.get(segment.wallId);
      if (!wall || (segment.direction !== 'forward' && segment.direction !== 'reverse')) return null;
      return segment.direction === 'forward'
        ? { start: wall.startVertexId, end: wall.endVertexId }
        : { start: wall.endVertexId, end: wall.startVertexId };
    });
    if (ordered.some((segment) => !segment)) {
      errors.push(`部屋「${room.id}」が存在しない壁、または不正な向きを参照しています。`);
      continue;
    }
    const boundary = ordered as { start: string; end: string }[];
    if (new Set(room.boundary.map((segment) => segment.wallId)).size !== room.boundary.length) {
      errors.push(`部屋「${room.id}」の輪郭で同じ壁が複数回使われています。`);
    }
    for (let i = 0; i < boundary.length; i += 1) {
      if (boundary[i].end !== boundary[(i + 1) % boundary.length].start) {
        errors.push(`部屋「${room.id}」の輪郭が閉じていません（辺 ${i + 1} と次の辺が接続していません）。`);
      }
    }
    const points = boundary.map((edge) => vertexById.get(edge.start)).filter((point): point is Vertex => Boolean(point));
    if (points.length === boundary.length) {
      if (Math.abs(polygonArea(points)) <= GEOMETRY_EPSILON) errors.push(`部屋「${room.id}」の面積が0です。`);
      if (polygonSelfIntersects(points)) errors.push(`部屋「${room.id}」の輪郭が交差しています。`);
    }
  }

  for (const door of plan.doors) {
    if (!door) {
      errors.push('扉のデータが不正です。');
      continue;
    }
    addId(door.id, '扉');
    const wall = wallById.get(door.wallId);
    if (!wall) {
      errors.push(`扉「${door.id}」が存在しない壁を参照しています。`);
      continue;
    }
    const length = wallLength(plan, wall);
    if (!Number.isFinite(door.offsetMm) || door.offsetMm < 0 ||
        !Number.isFinite(door.widthMm) || door.widthMm <= 0 ||
        door.offsetMm + door.widthMm > length + GEOMETRY_EPSILON) {
      errors.push(`扉「${door.id}」が壁「${door.wallId}」の範囲外です。`);
    }
  }

  return [...new Set(errors)];
}

export function assertValidFloorPlan(value: unknown): asserts value is FloorPlan {
  const errors = validateFloorPlan(value);
  if (errors.length) throw new Error(errors[0]);
}

export type WallEdit = {
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  lengthMm?: number;
  thicknessMm?: number;
};

export function editWall(plan: FloorPlan, wallId: string, edit: WallEdit): FloorPlan {
  const wall = plan.walls.find((candidate) => candidate.id === wallId);
  if (!wall) throw new Error(`壁「${wallId}」が見つかりません。`);
  const { start, end } = wallPoints(plan, wall);
  const nextStart = {
    ...start,
    x: edit.startX ?? start.x,
    y: edit.startY ?? start.y,
  };
  let nextEnd = {
    ...end,
    x: edit.endX ?? end.x,
    y: edit.endY ?? end.y,
  };
  if (edit.lengthMm !== undefined) {
    const currentLength = Math.hypot(nextEnd.x - nextStart.x, nextEnd.y - nextStart.y);
    if (!Number.isFinite(edit.lengthMm) || edit.lengthMm <= 0 || currentLength <= GEOMETRY_EPSILON) {
      throw new Error('壁の長さは1 mm以上で入力してください。');
    }
    const ratio = edit.lengthMm / currentLength;
    nextEnd = {
      ...nextEnd,
      x: nextStart.x + (nextEnd.x - nextStart.x) * ratio,
      y: nextStart.y + (nextEnd.y - nextStart.y) * ratio,
    };
  }
  const next: FloorPlan = {
    ...plan,
    vertices: plan.vertices.map((vertex) =>
      vertex.id === nextStart.id ? nextStart : vertex.id === nextEnd.id ? nextEnd : vertex,
    ),
    walls: plan.walls.map((candidate) =>
      candidate.id === wallId
        ? { ...candidate, thicknessMm: edit.thicknessMm ?? candidate.thicknessMm }
        : candidate,
    ),
  };
  assertValidFloorPlan(next);
  return next;
}

export function moveVertex(plan: FloorPlan, vertexId: string, point: Point): FloorPlan {
  const next: FloorPlan = {
    ...plan,
    vertices: plan.vertices.map((vertex) => vertex.id === vertexId ? { ...vertex, ...point } : vertex),
  };
  assertValidFloorPlan(next);
  return next;
}

export function translateWall(plan: FloorPlan, wallId: string, dx: number, dy: number): FloorPlan {
  const wall = plan.walls.find((candidate) => candidate.id === wallId);
  if (!wall) throw new Error(`壁「${wallId}」が見つかりません。`);
  const movedIds = new Set([wall.startVertexId, wall.endVertexId]);
  const next: FloorPlan = {
    ...plan,
    vertices: plan.vertices.map((vertex) =>
      movedIds.has(vertex.id) ? { ...vertex, x: vertex.x + dx, y: vertex.y + dy } : vertex,
    ),
  };
  assertValidFloorPlan(next);
  return next;
}

function polygonSelfIntersects(points: Point[]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      if (j === i || j === (i + 1) % points.length || (j + 1) % points.length === i) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      if (segmentRelation(a, b, c, d).kind !== 'none') return true;
    }
  }
  return false;
}

type SegmentRelation =
  | { kind: 'none' }
  | { kind: 'overlap' }
  | { kind: 'point'; t: number; u: number };

function segmentRelation(a: Point, b: Point, c: Point, d: Point): SegmentRelation {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const q = { x: c.x - a.x, y: c.y - a.y };
  const denominator = cross(r, s);
  const rLengthSquared = dot(r, r);
  if (rLengthSquared <= GEOMETRY_EPSILON) return { kind: 'none' };
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) {
    if (Math.abs(cross(q, r)) > GEOMETRY_EPSILON) return { kind: 'none' };
    const t0 = dot(q, r) / rLengthSquared;
    const t1 = t0 + dot(s, r) / rLengthSquared;
    const overlap = Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
    if (overlap > GEOMETRY_EPSILON) return { kind: 'overlap' };
    if (overlap < -GEOMETRY_EPSILON) return { kind: 'none' };
    const t = Math.min(1, Math.max(0, Math.min(t0, t1)));
    const point = { x: a.x + r.x * t, y: a.y + r.y * t };
    const sLengthSquared = dot(s, s);
    const u = sLengthSquared <= GEOMETRY_EPSILON ? 0 : dot({ x: point.x - c.x, y: point.y - c.y }, s) / sLengthSquared;
    return { kind: 'point', t, u };
  }
  const t = cross(q, s) / denominator;
  const u = cross(q, r) / denominator;
  if (t < -GEOMETRY_EPSILON || t > 1 + GEOMETRY_EPSILON || u < -GEOMETRY_EPSILON || u > 1 + GEOMETRY_EPSILON) {
    return { kind: 'none' };
  }
  return { kind: 'point', t: clamp01(t), u: clamp01(u) };
}

function endpointIdAt(wall: Wall, t: number): string | null {
  if (Math.abs(t) <= GEOMETRY_EPSILON) return wall.startVertexId;
  if (Math.abs(t - 1) <= GEOMETRY_EPSILON) return wall.endVertexId;
  return null;
}

function pointKey(point: Point): string {
  return `${Math.round(point.x / GEOMETRY_EPSILON)}:${Math.round(point.y / GEOMETRY_EPSILON)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
