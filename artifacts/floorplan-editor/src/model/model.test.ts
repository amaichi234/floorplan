import assert from 'node:assert/strict';
import test from 'node:test';
import { editWall, moveVertex, pointOnWall, roomOutline, translateWall, validateFloorPlan } from './geometry.ts';
import { takeUndo, pushPlanHistory } from './history.ts';
import { createMigrationPreview, sampleLegacyPlan } from './migration.ts';

function samplePlan() {
  const preview = createMigrationPreview(sampleLegacyPlan, JSON.stringify(sampleLegacyPlan));
  const candidate = preview.candidates.find((item) => item.id === 'rooms');
  assert.ok(candidate?.plan, candidate?.errors.join('\n'));
  assert.deepEqual(candidate.errors, []);
  return candidate.plan;
}

function closeTo(actual: number, expected: number, epsilon = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('sample v1 plan produces two valid, closed v2 migration candidates', () => {
  const before = structuredClone(sampleLegacyPlan);
  const preview = createMigrationPreview(sampleLegacyPlan, JSON.stringify(sampleLegacyPlan));
  assert.equal(preview.candidates.length, 2);
  assert.ok(preview.candidates.every((candidate) => candidate.plan));
  assert.ok(preview.candidates.every((candidate) => validateFloorPlan(candidate.plan).length === 0));
  assert.deepEqual(sampleLegacyPlan, before);
});

test('moving a shared vertex updates every incident wall and the derived room outline', () => {
  const plan = samplePlan();
  const vertex = plan.vertices.find((item) => item.x === 7000 && item.y === 5000);
  assert.ok(vertex);
  const incidentBefore = plan.walls.filter((wall) =>
    wall.startVertexId === vertex.id || wall.endVertexId === vertex.id,
  );
  assert.ok(incidentBefore.length >= 3);

  const moved = moveVertex(plan, vertex.id, { x: 7200, y: 5000 });
  const movedVertex = moved.vertices.find((item) => item.id === vertex.id);
  assert.deepEqual({ x: movedVertex?.x, y: movedVertex?.y }, { x: 7200, y: 5000 });
  assert.equal(
    moved.walls.filter((wall) => wall.startVertexId === vertex.id || wall.endVertexId === vertex.id).length,
    incidentBefore.length,
  );
  const living = moved.rooms.find((room) => room.id === 'room-living');
  assert.ok(living);
  assert.ok(roomOutline(moved, living).some((point) => point.x === 7200 && point.y === 5000));
  assert.deepEqual(validateFloorPlan(moved), []);
});

test('moving a wall body translates its shared endpoints, adjacent walls, room edges, and attached door', () => {
  const plan = samplePlan();
  const wall = plan.walls.find((item) => item.id === 'wall-kitchen-divider');
  const door = plan.doors.find((item) => item.id === 'door-kitchen');
  assert.ok(wall && door);
  const before = pointOnWall(plan, wall, door.offsetMm);
  const translated = translateWall(plan, wall.id, 200, 0);
  const translatedDoor = translated.doors.find((item) => item.id === door.id);
  const translatedWall = translated.walls.find((item) => item.id === wall.id);
  assert.ok(translatedDoor && translatedWall);
  assert.equal(translatedDoor.offsetMm, door.offsetMm);
  const after = pointOnWall(translated, translatedWall, translatedDoor.offsetMm);
  closeTo(after.x - before.x, 200);
  closeTo(after.y - before.y, 0);
  assert.deepEqual(validateFloorPlan(translated), []);
});

test('shortening a wall past its attached door is rejected without changing the source plan', () => {
  const plan = samplePlan();
  const wall = plan.walls.find((item) => item.id === 'wall-kitchen-divider');
  assert.ok(wall);
  const before = structuredClone(plan);
  assert.throws(() => editWall(plan, wall.id, { lengthMm: 2000 }), /扉/);
  assert.deepEqual(plan, before);
});

test('JSON export and reload preserve shared vertex references, doors, and room boundaries', () => {
  const plan = translateWall(samplePlan(), 'wall-kitchen-divider', 200, 0);
  const loaded: unknown = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(validateFloorPlan(loaded), []);
  assert.deepEqual(loaded, plan);
});

test('undo restores the complete prior graph snapshot', () => {
  const before = samplePlan();
  const changed = translateWall(before, 'wall-kitchen-divider', 200, 0);
  const history = pushPlanHistory([], before);
  const result = takeUndo(history);
  assert.deepEqual(result.restored, before);
  assert.deepEqual(result.history, []);
  assert.notDeepEqual(result.restored, changed);
});

test('a legacy plan with a broken wall loop shows both proposals and keeps the source untouched', () => {
  const legacy = structuredClone(sampleLegacyPlan);
  legacy.walls.splice(legacy.walls.findIndex((wall) => wall.id === 'wall-north'), 1);
  const before = structuredClone(legacy);
  const preview = createMigrationPreview(legacy, JSON.stringify(legacy));
  const roomsCandidate = preview.candidates.find((candidate) => candidate.id === 'rooms');
  const wallsCandidate = preview.candidates.find((candidate) => candidate.id === 'walls');
  assert.ok(roomsCandidate?.plan);
  assert.equal(wallsCandidate?.plan, null);
  assert.ok(wallsCandidate?.errors.length);
  assert.deepEqual(legacy, before);
});

test('migrating legacy doors preserves their physical position along split walls', () => {
  const preview = createMigrationPreview(sampleLegacyPlan, JSON.stringify(sampleLegacyPlan));
  const candidate = preview.candidates.find((item) => item.id === 'rooms');
  assert.ok(candidate?.plan);
  for (const oldDoor of sampleLegacyPlan.doors) {
    const oldWall = sampleLegacyPlan.walls.find((item) => item.id === oldDoor.wallId);
    const nextDoor = candidate.plan.doors.find((item) => item.id === oldDoor.id);
    assert.ok(oldWall && nextDoor);
    const oldLength = Math.hypot(oldWall.x2 - oldWall.x1, oldWall.y2 - oldWall.y1);
    const expected = {
      x: oldWall.x1 + ((oldWall.x2 - oldWall.x1) / oldLength) * oldDoor.offset,
      y: oldWall.y1 + ((oldWall.y2 - oldWall.y1) / oldLength) * oldDoor.offset,
    };
    const nextWall = candidate.plan.walls.find((item) => item.id === nextDoor.wallId);
    assert.ok(nextWall);
    const actual = pointOnWall(candidate.plan, nextWall, nextDoor.offsetMm);
    closeTo(actual.x, expected.x);
    closeTo(actual.y, expected.y);
    const expectedEnd = {
      x: oldWall.x1 + ((oldWall.x2 - oldWall.x1) / oldLength) * (oldDoor.offset + oldDoor.width),
      y: oldWall.y1 + ((oldWall.y2 - oldWall.y1) / oldLength) * (oldDoor.offset + oldDoor.width),
    };
    const actualEnd = pointOnWall(candidate.plan, nextWall, nextDoor.offsetMm + nextDoor.widthMm);
    closeTo(actualEnd.x, expectedEnd.x);
    closeTo(actualEnd.y, expectedEnd.y);
  }
});
