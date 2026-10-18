export type Point = { x: number; y: number };

export type Vertex = Point & { id: string };

export type Wall = {
  id: string;
  startVertexId: string;
  endVertexId: string;
  thicknessMm: number;
};

export type RoomBoundaryRef = {
  wallId: string;
  direction: 'forward' | 'reverse';
};

export type Room = {
  id: string;
  name: string;
  boundary: RoomBoundaryRef[];
};

export type Door = {
  id: string;
  wallId: string;
  offsetMm: number;
  widthMm: number;
};

export type FloorPlan = {
  id: string;
  name: string;
  width: number;
  height: number;
  units: 'mm';
  schemaVersion: 2;
  vertices: Vertex[];
  walls: Wall[];
  rooms: Room[];
  doors: Door[];
};

export type LegacyRoom = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LegacyWall = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
};

export type LegacyDoor = {
  id: string;
  wallId: string;
  offset: number;
  width: number;
};

export type LegacyFloorPlan = {
  id: string;
  name: string;
  width: number;
  height: number;
  units: 'mm';
  schemaVersion: 1;
  rooms: LegacyRoom[];
  walls: LegacyWall[];
  doors: LegacyDoor[];
};

export type MigrationCandidate = {
  id: 'rooms' | 'walls' | 'current';
  title: string;
  description: string;
  plan: FloorPlan | null;
  errors: string[];
  warnings: string[];
  generatedWallCount: number;
  splitWallCount: number;
};

export type MigrationPreview = {
  legacy: LegacyFloorPlan;
  sourceJson: string;
  candidates: MigrationCandidate[];
};
