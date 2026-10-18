import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, Hand, House, Minus, Plus, RotateCcw, Ruler, Undo2 } from 'lucide-react';
import { MigrationReview } from './components/migration-review';
import { editWall, moveVertex, pointOnWall, roomBounds, roomOutline, translateWall, validateFloorPlan, wallLength, wallPoints } from './model/geometry';
import { clonePlan, pushPlanHistory, takeUndo } from './model/history';
import { createMigrationPreview, createSampleFloorPlan, validateLegacyPlan } from './model/migration';
import type { ImportReview } from './model/import-review';
import type { FloorPlan, MigrationCandidate, Wall } from './model/types';

const STORAGE_KEY = 'madoka-floorplan-v2';
const LEGACY_STORAGE_KEY = 'madoka-floorplan-v1';
const BACKUP_KEY_PREFIX = 'madoka-floorplan-backup';
const fmt = (n: number) => new Intl.NumberFormat('ja-JP').format(Math.round(n));

type StartupState = {
  plan: FloorPlan;
  review: ImportReview | null;
  message: string;
  error: boolean;
  storageAvailable: boolean;
  saveBlocked: boolean;
};

function prepareImport(sourceJson: string): ImportReview {
  const parsed: unknown = JSON.parse(sourceJson);
  if (!parsed || typeof parsed !== 'object' || !('schemaVersion' in parsed)) {
    throw new Error('schemaVersion のないJSONは読み込めません。');
  }
  const schemaVersion = (parsed as { schemaVersion: unknown }).schemaVersion;
  if (schemaVersion === 1) {
    const legacyErrors = validateLegacyPlan(parsed);
    if (legacyErrors.length) throw new Error(legacyErrors.join('\n'));
    const preview = createMigrationPreview(parsed, sourceJson);
    return { sourceVersion: 1, sourceJson, candidates: preview.candidates };
  }
  if (schemaVersion === 2) {
    const errors = validateFloorPlan(parsed);
    if (errors.length) throw new Error(errors.join('\n'));
    return {
      sourceVersion: 2,
      sourceJson,
      candidates: [{
        id: 'current',
        title: 'この図面をそのまま読み込む',
        description: '共有頂点・部屋輪郭・扉の位置を検証しました。',
        plan: parsed as FloorPlan,
        errors: [],
        warnings: [],
        generatedWallCount: 0,
        splitWallCount: 0,
      }],
    };
  }
  throw new Error(`schemaVersion ${String(schemaVersion)} は未対応です。`);
}

function getStartupState(): StartupState {
  const sample = createSampleFloorPlan();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      const errors = validateFloorPlan(parsed);
      if (errors.length) {
        return {
          plan: sample,
          review: null,
          message: `端末の保存データを保護しました。${errors[0]}`,
          error: true,
          storageAvailable: true,
          saveBlocked: true,
        };
      }
      return { plan: parsed as FloorPlan, review: null, message: '', error: false, storageAvailable: true, saveBlocked: false };
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const review = prepareImport(legacy);
      return {
        plan: sample,
        review,
        message: '以前の形式の図面があります。候補を確認して移行できます。',
        error: false,
        storageAvailable: true,
        saveBlocked: true,
      };
    }
    return { plan: sample, review: null, message: '', error: false, storageAvailable: true, saveBlocked: false };
  } catch (error) {
    return {
      plan: sample,
      review: null,
      message: error instanceof Error ? `保存データを読み込めませんでした。元データは変更していません。${error.message}` : '保存データを読み込めませんでした。元データは変更していません。',
      error: true,
      storageAvailable: false,
      saveBlocked: true,
    };
  }
}

function App() {
  const [initialState] = useState(getStartupState);
  const [plan, setPlan] = useState<FloorPlan>(initialState.plan);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorPlan[]>([]);
  const [zoom, setZoom] = useState(1);
  const [panMode, setPanMode] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [jsonText, setJsonText] = useState('');
  const [fileMessage, setFileMessage] = useState(initialState.message);
  const [fileError, setFileError] = useState(initialState.error);
  const [wallError, setWallError] = useState('');
  const [migrationReview, setMigrationReview] = useState<ImportReview | null>(initialState.review);
  const [migrationChoice, setMigrationChoice] = useState<MigrationCandidate['id'] | null>(initialState.review?.candidates[0]?.id ?? null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [storageAvailable, setStorageAvailable] = useState(initialState.storageAvailable);
  const [saveBlocked, setSaveBlocked] = useState(initialState.saveBlocked);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Record<string, number>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    kind: 'body' | 'vertex';
    vertexId?: string;
    x: number;
    y: number;
    original: FloorPlan;
    lastValid: FloorPlan;
  } | null>(null);
  const pointerRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const savedPlan = useRef(plan);
  const selectedWall = plan.walls.find((wall) => wall.id === selectedId) ?? null;
  const selectedWallPoints = selectedWall ? wallPoints(plan, selectedWall) : null;
  const selectedCoordinates = selectedWallPoints ? {
    x1: selectedWallPoints.start.x,
    y1: selectedWallPoints.start.y,
    x2: selectedWallPoints.end.x,
    y2: selectedWallPoints.end.y,
  } : null;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    savedPlan.current = plan;
    if (saveBlocked) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }, [plan, saveBlocked]);

  const commit = useCallback((next: FloorPlan) => {
    setHistory((stack) => pushPlanHistory(stack, savedPlan.current));
    setPlan(next);
  }, []);

  const undo = useCallback(() => {
    setHistory((stack) => {
      const result = takeUndo(stack);
      if (result.restored) setPlan(result.restored);
      return result.history;
    });
  }, []);
  const cancelMigrationReview = useCallback(() => {
    setMigrationReview(null);
    setMigrationChoice(null);
    if (initialState.review?.sourceVersion === 1) setSaveBlocked(false);
    setFileMessage('移行をキャンセルしました。旧形式のJSONは変更せずに保管しています。');
    setFileError(false);
  }, [initialState.review?.sourceVersion]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); undo();
      }
      if (event.key === 'Escape') {
        if (migrationReview) cancelMigrationReview();
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, migrationReview, cancelMigrationReview]);

  const v = useMemo(() => {
    const w = plan.width / zoom;
    const h = plan.height / zoom;
    return { x: (plan.width - w) / 2 + pan.x, y: (plan.height - h) / 2 + pan.y, w, h };
  }, [plan.width, plan.height, zoom, pan]);
  const pixelsPerMm = canvasSize.width && canvasSize.height
    ? Math.min(canvasSize.width / v.w, canvasSize.height / v.h)
    : null;

  const zoomBy = (factor: number) => setZoom((current) => Math.min(3.2, Math.max(.55, current * factor)));
  const eventPoint = (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointerRef.current.size === 2) {
      if (dragRef.current) {
        setPlan(dragRef.current.original);
        dragRef.current = null;
      }
      const pts = [...pointerRef.current.values()];
      pinchRef.current = { distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom };
    }
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const previous = pointerRef.current.get(event.pointerId);
    if (previous && pointerRef.current.size === 2 && pinchRef.current) {
      const pts = [...pointerRef.current.values()];
      pts[pointerRef.current.has(event.pointerId) ? [...pointerRef.current.keys()].indexOf(event.pointerId) : 0] = { x: event.clientX, y: event.clientY };
      const nextDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      setZoom(Math.min(3.2, Math.max(.55, pinchRef.current.zoom * nextDistance / Math.max(1, pinchRef.current.distance))));
      pointerRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const point = eventPoint(event);
      const origin = drag.original;
      try {
        let next: FloorPlan;
        if (drag.kind === 'vertex' && drag.vertexId) {
          next = moveVertex(origin, drag.vertexId, {
            x: Math.min(origin.width, Math.max(0, point.x)),
            y: Math.min(origin.height, Math.max(0, point.y)),
          });
        } else {
          const moving = origin.walls.find((wall) => wall.id === drag.id);
          if (!moving) throw new Error('移動する壁が見つかりません。');
          const { start, end } = wallPoints(origin, moving);
          const minDx = Math.max(-start.x, -end.x);
          const maxDx = Math.min(origin.width - start.x, origin.width - end.x);
          const minDy = Math.max(-start.y, -end.y);
          const maxDy = Math.min(origin.height - start.y, origin.height - end.y);
          const dx = Math.min(maxDx, Math.max(minDx, point.x - drag.x));
          const dy = Math.min(maxDy, Math.max(minDy, point.y - drag.y));
          next = translateWall(origin, moving.id, dx, dy);
        }
        drag.lastValid = next;
        setPlan(next);
        setWallError('');
      } catch (error) {
        setWallError(error instanceof Error ? error.message : 'この位置には移動できません。');
      }
    } else if (previous && (event.buttons === 2 || event.shiftKey || panMode)) {
      const currentPoint = eventPoint(event);
      const previousPoint = eventPoint({ clientX: previous.x, clientY: previous.y });
      setPan((p) => ({ x: p.x - (currentPoint.x - previousPoint.x), y: p.y - (currentPoint.y - previousPoint.y) }));
    }
    pointerRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const onCanvasPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerRef.current.delete(event.pointerId);
    if (pointerRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    if (drag) {
      if (event.type === 'pointercancel') {
        setPlan(drag.original);
        setWallError('操作が中断されたため、壁の変更を取り消しました。');
      } else if (JSON.stringify(drag.original) !== JSON.stringify(drag.lastValid)) {
        setHistory((stack) => pushPlanHistory(stack, drag.original));
        setPlan(drag.lastValid);
      }
      dragRef.current = null;
    }
  };

  const startWallDrag = (event: ReactPointerEvent<SVGLineElement>, wall: Wall) => {
    setSelectedId(wall.id);
    setDraft({});
    if (pointerRef.current.size > 0) return;
    if (panMode) return;
    const point = eventPoint(event);
    const original = clonePlan(plan);
    dragRef.current = { id: wall.id, kind: 'body', x: point.x, y: point.y, original, lastValid: original };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startVertexDrag = (event: ReactPointerEvent<SVGCircleElement>, wallId: string, vertexId: string) => {
    setSelectedId(wallId);
    setDraft({});
    if (pointerRef.current.size > 0 || panMode) return;
    const point = eventPoint(event);
    const original = clonePlan(plan);
    dragRef.current = { id: wallId, kind: 'vertex', vertexId, x: point.x, y: point.y, original, lastValid: original };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const setWallValue = (key: 'x1' | 'y1' | 'x2' | 'y2' | 'thickness' | 'length', raw: number) => {
    if (!selectedWall || !Number.isFinite(raw) || raw < 0) return;
    setWallError('');
    setDraft((d) => ({ ...d, [key]: raw }));
  };
  const saveWallDraft = () => {
    if (!selectedWall) return;
    try {
      const next = editWall(plan, selectedWall.id, {
        startX: draft.x1,
        startY: draft.y1,
        endX: draft.x2,
        endY: draft.y2,
        lengthMm: draft.length,
        thicknessMm: draft.thickness,
      });
      if (JSON.stringify(next) !== JSON.stringify(plan)) commit(next);
      setWallError('');
      setDraft({});
    } catch (error) {
      setWallError(error instanceof Error ? error.message : '壁を変更できません。');
      setDraft({});
    }
  };

  const exportJson = () => {
    const content = JSON.stringify(plan, null, 2);
    setJsonText(content);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${plan.id}.json`; link.click(); URL.revokeObjectURL(url);
    setFileError(false); setFileMessage('間取りデータを書き出しました。');
  };
  const importJson = () => {
    if (!jsonText.trim()) { setFileError(true); setFileMessage('JSONを貼り付けるか、ファイルを選択してください。'); return; }
    try {
      const review = prepareImport(jsonText);
      setMigrationReview(review);
      setMigrationChoice(review.candidates[0]?.id ?? null);
      setFileError(false);
      setFileMessage('候補を確認し、適用する案を選んでください。');
    } catch (error) {
      setFileError(true); setFileMessage(error instanceof Error ? error.message : 'JSONを読み込めませんでした。');
    }
  };
  const applyImportCandidate = (candidate: MigrationCandidate) => {
    if (!migrationReview || !candidate.plan || candidate.errors.length) return;
    if (storageAvailable) {
      try {
        const activeJson = localStorage.getItem(STORAGE_KEY);
        if (activeJson) localStorage.setItem(`${BACKUP_KEY_PREFIX}-${Date.now()}`, activeJson);
        if (migrationReview.sourceVersion === 1) {
          const oldJson = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (!oldJson) localStorage.setItem(LEGACY_STORAGE_KEY, migrationReview.sourceJson);
          localStorage.setItem(`${BACKUP_KEY_PREFIX}-legacy-${Date.now()}`, migrationReview.sourceJson);
        }
      } catch {
        setStorageAvailable(false);
        setFileError(true);
        setFileMessage('元データを端末にバックアップできないため、適用を中止しました。JSONの内容は入力欄に残っています。');
        return;
      }
    }
    if (storageAvailable) setSaveBlocked(false);
    commit(clonePlan(candidate.plan));
    setSelectedId(null);
    setDraft({});
    setMigrationReview(null);
    setMigrationChoice(null);
    setFileError(false);
    setFileMessage(candidate.id === 'current' ? '検証済みの間取りデータを読み込みました。' : '選択した移行案を適用しました。旧形式のJSONも保管しています。');
  };
  const readFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setJsonText(String(reader.result ?? ''));
    reader.onerror = () => { setFileError(true); setFileMessage('ファイルを読み込めませんでした。'); };
    reader.readAsText(file);
  };

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><House size={22} strokeWidth={1.8} /></div>
          <div><div className="brand-name">まどか</div><div className="brand-kicker">ふたりの間取りノート</div></div>
        </div>
          <div className="top-actions"><span className={`status-pill${storageAvailable && !saveBlocked ? '' : ' storage-warning'}`} aria-label={storageAvailable && !saveBlocked ? 'この端末に保存中' : saveBlocked ? '既存データを保護中' : '端末内に保存できません'}><i className="status-dot" />{storageAvailable && !saveBlocked ? 'この端末に保存中' : saveBlocked ? '保存データを保護中' : '端末内に保存できません'}</span></div>
      </header>

      <section className="workspace">
        <div className="project-head">
          <div>
            <div className="eyebrow">RENOVATION / PLAN 01</div>
            <h1>{plan.name}</h1>
            <div className="project-subtitle">まだ決まっていないことも、まずは一緒に描いてみる。</div>
          </div>
          <div className="project-actions">
            <button className="button button-quiet" onClick={undo} disabled={!history.length} data-testid="button-undo" aria-label="直前の編集を元に戻す"><Undo2 size={15} />元に戻す</button>
            <button className="button button-primary" onClick={exportJson} data-testid="button-export"><ArrowDownToLine size={15} />書き出す</button>
          </div>
        </div>

        <div className="editor-grid">
          <section className="canvas-card" aria-label="間取り編集キャンバス">
            <div className="canvas-toolbar">
              <div className="toolbar-group"><span className="toolbar-label">表示倍率</span><button className="icon-button" onClick={() => zoomBy(.85)} aria-label="縮小" data-testid="button-zoom-out"><Minus size={16} /></button><span className="scale-readout" data-testid="text-zoom">{Math.round(zoom * 100)}%</span><button className="icon-button" onClick={() => zoomBy(1.18)} aria-label="拡大" data-testid="button-zoom-in"><Plus size={16} /></button><button className={`button${panMode ? ' button-primary' : ' button-quiet'}`} onClick={() => setPanMode((active) => !active)} aria-pressed={panMode} aria-label="図面を移動するモード" data-testid="button-pan-mode"><Hand size={13} />移動</button><button className="button button-quiet" onClick={resetView} data-testid="button-reset-view"><RotateCcw size={13} />全体表示</button></div>
              <div className="toolbar-group"><Ruler size={15} color="#678176" /><span className="scale-readout">{fmt(plan.width)} × {fmt(plan.height)} mm</span></div>
            </div>
             <div className="canvas-stage" ref={stageRef}>
              <svg
                ref={svgRef}
                className="plan-svg"
                viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
                role="img"
                aria-label="タップして壁を選択し、ドラッグで移動できます。"
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                onPointerCancel={onCanvasPointerUp}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={(event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.08 : .92); }}
              >
                <defs><pattern id="microgrid" width="500" height="500" patternUnits="userSpaceOnUse"><path d="M 500 0 L 0 0 0 500" fill="none" stroke="#dedbd1" strokeWidth="12" /></pattern></defs>
                <rect x={-5000} y={-5000} width={plan.width + 10000} height={plan.height + 10000} fill="url(#microgrid)" />
                {plan.rooms.map((room, index) => (
                  <g key={room.id}>
                    {(() => {
                      const points = roomOutline(plan, room);
                      const bounds = roomBounds(plan, room);
                      const centerX = bounds.x + bounds.width / 2;
                      const centerY = bounds.y + bounds.height / 2;
                      return <>
                        <polygon points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill={['#e8eee7','#f1e9dc','#e6ede9','#efe9e2','#e9eddf'][index % 5]} />
                        <text className="room-title" x={centerX} y={centerY - 35} textAnchor="middle" fill="#53665c" fontSize="250" fontFamily="DM Sans, sans-serif" fontWeight="700">{room.name}</text>
                        <text className="room-meta" x={centerX} y={centerY + 205} textAnchor="middle" fill="#879087" fontSize="142" fontFamily="DM Mono, monospace">{fmt(bounds.width)} × {fmt(bounds.height)}</text>
                      </>;
                    })()}
                  </g>
                ))}
                {plan.walls.map((wall) => {
                  const selected = wall.id === selectedId;
                  const { start, end } = wallPoints(plan, wall);
                  return <g key={wall.id}>
                    <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#f3f0e8" strokeWidth={wall.thicknessMm + 55} strokeLinecap="square" />
                    <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={selected ? '#cc805f' : '#394943'} strokeWidth={selected ? wall.thicknessMm + 20 : wall.thicknessMm} strokeLinecap="square" />
                    <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="transparent" strokeWidth={Math.max(380, wall.thicknessMm + 180)} onPointerDown={(event) => startWallDrag(event, wall)} onClick={() => { setSelectedId(wall.id); setDraft({}); }} role="button" tabIndex={0} aria-label={`${wall.id}を選択、長さ ${fmt(wallLength(plan, wall))} ミリ`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(wall.id); setDraft({}); } }} />
                  </g>;
                })}
                {selectedWall && selectedWallPoints && <>
                  <g fill="#fff8ed" stroke="#c87757" strokeWidth="36" pointerEvents="none">
                    <circle cx={selectedWallPoints.start.x} cy={selectedWallPoints.start.y} r="100" />
                    <circle cx={selectedWallPoints.end.x} cy={selectedWallPoints.end.y} r="100" />
                  </g>
                  {[selectedWallPoints.start, selectedWallPoints.end].map((vertex) => <circle
                    key={vertex.id}
                    cx={vertex.x}
                    cy={vertex.y}
                    r="300"
                    fill="transparent"
                    stroke="transparent"
                    onPointerDown={(event) => startVertexDrag(event, selectedWall.id, vertex.id)}
                    aria-label={`頂点 ${vertex.id} をドラッグ`}
                    role="button"
                  />)}
                </>}
                {plan.doors.map((door) => {
                  const wall = plan.walls.find((item) => item.id === door.wallId);
                  if (!wall) return null;
                  const { start, end } = wallPoints(plan, wall);
                  const len = wallLength(plan, wall);
                  const ux = (end.x - start.x) / len; const uy = (end.y - start.y) / len;
                  const first = pointOnWall(plan, wall, door.offsetMm);
                  const last = pointOnWall(plan, wall, door.offsetMm + door.widthMm);
                  const sx = first.x; const sy = first.y; const ex = last.x; const ey = last.y;
                  const sign = wall.id === 'wall-south' ? -1 : 1;
                  const nx = -uy * sign; const ny = ux * sign; const radius = door.widthMm;
                  return <g key={door.id} pointerEvents="none">
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#f3f0e8" strokeWidth={wall.thicknessMm + 90} />
                    <path d={`M ${sx} ${sy} L ${sx + nx * radius} ${sy + ny * radius} A ${radius} ${radius} 0 0 ${wall.id === 'wall-south' ? 0 : 1} ${ex} ${ey}`} fill="none" stroke="#b07e61" strokeWidth="36" />
                    <line x1={sx} y1={sy} x2={sx + nx * radius} y2={sy + ny * radius} stroke="#b07e61" strokeWidth="34" />
                  </g>;
                })}
              </svg>
            </div>
            <div className="canvas-legend">
              <div className="legend-left"><span className="legend-key"><i className="legend-swatch" />壁</span><span className="legend-key"><i className="legend-swatch selected" />選択中</span><span>ドアは弧で表示</span></div>
              <span className="scale-readout">原点＝左上・Y↓　1 SVG単位＝1 mm　{pixelsPerMm ? `表示：1 mm＝${pixelsPerMm.toFixed(3)} px` : '表示倍率を計算中'}</span>
            </div>
          </section>

          <aside className="side-column">
            <section className="panel-card">
              <div className="panel-top">
                <button className="mobile-panel-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen} data-testid="button-inspector-toggle">壁の寸法<ChevronDown size={16} /></button>
                <h2 className="panel-heading">壁の寸法</h2>
                {selectedWall && <span className="selected-tag">選択中</span>}
              </div>
              <div className={`inspector-content${panelOpen ? '' : ' collapsed'}`}>
                {selectedWall ? <>
                  <div className="eyebrow">選択した壁</div>
                  <div className="field-grid">
                    {(['x1','y1','x2','y2'] as const).map((key) => <label key={key}>
                      <span className="field-label">端点 {key.slice(1).toUpperCase()}</span>
                      <div className="input-wrap"><input className="number-input" type="number" min="0" max={key.startsWith('x') ? plan.width : plan.height} value={draft[key] ?? selectedCoordinates?.[key] ?? 0} onChange={(e) => setWallValue(key, Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} data-testid={`input-wall-${key}`} aria-label={`壁の${key}座標、ミリ`} /><span className="input-unit">mm</span></div>
                    </label>)}
                  </div>
                  <label><span className="field-label">壁の厚み</span><div className="input-wrap"><input className="number-input" type="number" min="1" value={draft.thickness ?? selectedWall.thicknessMm} onChange={(e) => setWallValue('thickness', Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} data-testid="input-wall-thickness" aria-label="壁の厚み、ミリ" /><span className="input-unit">mm</span></div></label>
                    <label><span className="field-label">壁の長さ</span><div className="input-wrap"><input className="number-input" type="number" min="1" max={Math.round(Math.max(plan.width, plan.height))} value={draft.length ?? wallLength(plan, selectedWall)} onChange={(e) => setWallValue('length', Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} data-testid="input-wall-length" aria-label="壁の長さ、ミリ" /><span className="input-unit">mm</span></div></label>
                    <div className="dimension-row"><span>端点間の長さ</span><span className="dimension-value">{fmt(wallLength(plan, selectedWall))} mm</span></div>
                   {wallError && <div className="message error" role="alert">{wallError}</div>}
                </> : <div className="empty-inspector"><div><Ruler size={20} style={{ marginBottom: 9, color: '#789083' }} /><br />図面上の壁を選ぶと、<br />座標と長さを編集できます。</div></div>}
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-top"><h2 className="panel-heading">部屋の一覧</h2><span className="eyebrow">{plan.rooms.length} ROOMS</span></div>
              <div className="room-list">{plan.rooms.map((room) => {
                const bounds = roomBounds(plan, room);
                return <div className="room-row" key={room.id} data-testid={`room-row-${room.id}`}><span className="room-label"><i className="room-mark" /> <span className="room-name">{room.name}</span></span><span className="room-size">{fmt(bounds.width)} × {fmt(bounds.height)}</span></div>;
              })}</div>
            </section>

            <section className="panel-card file-panel">
              <div className="panel-top"><h2 className="panel-heading">JSONデータ</h2><span className="eyebrow">LOCAL FILE</span></div>
              <p className="file-copy">図面をファイルに保存したり、別の図面を読み込めます。</p>
              <textarea className="json-area" aria-label="JSONデータ貼り付け欄" placeholder="JSONを貼り付けて読み込む…" value={jsonText} onChange={(event) => { setJsonText(event.target.value); if (fileMessage) setFileMessage(''); }} data-testid="textarea-json" />
              <div className="file-actions">
                <label className="button button-quiet" style={{ position: 'relative', overflow: 'hidden' }}><ArrowUpFromLine size={14} />ファイルを選ぶ<input type="file" accept=".json,application/json" aria-label="JSONファイルを選択" onChange={(event) => readFile(event.target.files?.[0])} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} data-testid="input-json-file" /></label>
                <button className="button button-primary" onClick={importJson} data-testid="button-import"><Check size={14} />読み込む</button>
              </div>
              <div className={`message${fileError ? ' error' : ''}`} role="status" aria-live="polite" data-testid="status-json">{fileMessage || 'JSONの読み込み時に内容を検証します。'}</div>
            </section>

            <div className="help-line"><span className="help-mark"><CircleHelp size={13} /></span><span>壁の本体をドラッグすると接続する端点も動きます。選択中の端点は個別にドラッグできます。スマホは二本指で拡大・縮小、Ctrl / ⌘ + Z で元に戻せます。</span></div>
          </aside>
        </div>
      </section>
      {migrationReview && <MigrationReview
        review={migrationReview}
        selectedId={migrationChoice}
        onSelect={setMigrationChoice}
        onCancel={cancelMigrationReview}
        onApply={applyImportCandidate}
      />}
    </main>
  );
}

export default App;
