import type { FloorPlan } from './types.ts';

export function clonePlan(plan: FloorPlan): FloorPlan {
  return JSON.parse(JSON.stringify(plan)) as FloorPlan;
}

export function pushPlanHistory(history: FloorPlan[], current: FloorPlan, limit = 40): FloorPlan[] {
  return [...history.slice(-(limit - 1)), clonePlan(current)];
}

export function takeUndo(history: FloorPlan[]): { restored: FloorPlan | null; history: FloorPlan[] } {
  if (!history.length) return { restored: null, history };
  return {
    restored: clonePlan(history[history.length - 1]),
    history: history.slice(0, -1),
  };
}
