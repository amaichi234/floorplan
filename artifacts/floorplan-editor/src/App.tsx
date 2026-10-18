import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, Hand, House, Minus, Plus, RotateCcw, Ruler, Undo2 } from 'lucide-react';

type Room = { id: string; name: string; x: number; y: number; width: number; height: number };
type Wall = { id: string; x1: number; y1: number; x2: number; y2: number; thickness: number };
type Door = { id: string; wallId: string; offset: number; width: number };
type FloorPlan = { id: string; name: string; width: number; height: number; rooms: Room[]; walls: Wall[]; doors: Door[]; units: 'mm'; schemaVersion: number };

const samplePlan: FloorPlan = {
  id: 'plan-kusunoki-01',
  name: '楠木邸｜リノベーション案',
  width: 12000, height: 8000, units: 'mm', schemaVersion: 1,
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

const STORAGE_KEY = 'madoka-floorplan-v1';
const clonePlan = (plan: FloorPlan): FloorPlan => JSON.parse(JSON.stringify(plan)) as FloorPlan;
const distance = (wall: Wall) => Math.round(Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1));
const fmt = (n: number) => new Intl.NumberFormat('ja-JP').format(Math.round(n));

function validatePlan(value: unknown): FloorPlan {
  if (!value || typeof value !== 'object') throw new Error('JSONの形式を確認してください。');
  const p = value as Partial<FloorPlan>;
  if (typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name ||
      !Number.isFinite(p.width) || !Number.isFinite(p.height) || (p.width ?? 0) <= 0 || (p.height ?? 0) <= 0 ||
      p.units !== 'mm' || p.schemaVersion !== 1 || !Array.isArray(p.rooms) || !Array.isArray(p.walls) || !Array.isArray(p.doors)) {
    throw new Error('必須項目が不足しています。単位は mm、schemaVersion は 1 が必要です。');
  }
  const planWidth = p.width as number;
  const planHeight = p.height as number;
  const idSet = new Set<string>();
  const addId = (id: unknown) => {
    if (typeof id !== 'string' || !id.trim() || idSet.has(id)) throw new Error('IDが空、または重複しています。');
    idSet.add(id);
  };
  for (const room of p.rooms) {
    if (!room || typeof room.name !== 'string' || ![room.x, room.y, room.width, room.height].every(Number.isFinite) ||
        room.width <= 0 || room.height <= 0 || room.x < 0 || room.y < 0 || room.x + room.width > planWidth || room.y + room.height > planHeight) {
      throw new Error('部屋の寸法または配置が不正です。');
    }
    addId(room.id);
  }
  for (const wall of p.walls) {
    if (!wall || ![wall.x1, wall.y1, wall.x2, wall.y2, wall.thickness].every(Number.isFinite) ||
        wall.thickness <= 0 || (wall.x1 === wall.x2 && wall.y1 === wall.y2) ||
        Math.min(wall.x1, wall.x2) < 0 || Math.max(wall.x1, wall.x2) > planWidth ||
        Math.min(wall.y1, wall.y2) < 0 || Math.max(wall.y1, wall.y2) > planHeight) {
      throw new Error('壁の座標または厚みが不正です。');
    }
    addId(wall.id);
  }
  for (const door of p.doors) {
    if (!door) throw new Error('ドアのデータが不正です。');
    const wall = p.walls.find((candidate) => candidate.id === door.wallId);
    if (!door || !wall || !Number.isFinite(door.offset) || !Number.isFinite(door.width) || door.offset < 0 ||
        door.width <= 0 || door.offset + door.width > distance(wall)) {
      throw new Error('ドアの参照先、位置、幅が不正です。');
    }
    addId(door.id);
  }
  return p as FloorPlan;
}

function getSavedPlan(): FloorPlan {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? validatePlan(JSON.parse(saved)) : clonePlan(samplePlan);
  } catch {
    return clonePlan(samplePlan);
  }
}

function App() {
  const [plan, setPlan] = useState<FloorPlan>(getSavedPlan);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorPlan[]>([]);
  const [zoom, setZoom] = useState(1);
  const [panMode, setPanMode] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [jsonText, setJsonText] = useState('');
  const [fileMessage, setFileMessage] = useState('');
  const [fileError, setFileError] = useState(false);
  const [wallError, setWallError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Record<string, number>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; original: FloorPlan } | null>(null);
  const pointerRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const savedPlan = useRef(plan);
  const selectedWall = plan.walls.find((wall) => wall.id === selectedId) ?? null;

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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
      savedPlan.current = plan;
      setStorageAvailable(true);
    } catch {
      savedPlan.current = plan;
      setStorageAvailable(false);
    }
  }, [plan]);

  const commit = useCallback((next: FloorPlan) => {
    setHistory((stack) => [...stack.slice(-39), clonePlan(savedPlan.current)]);
    setPlan(next);
  }, []);

  const undo = useCallback(() => {
    setHistory((stack) => {
      if (!stack.length) return stack;
      const previous = stack[stack.length - 1];
      setPlan(clonePlan(previous));
      return stack.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); undo();
      }
      if (event.key === 'Escape') { setSelectedId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

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
    if (dragRef.current && selectedWall) {
      const point = eventPoint(event);
      const origin = dragRef.current.original;
      const moving = origin.walls.find((wall) => wall.id === dragRef.current?.id);
      if (moving) {
        const dx = Math.max(-Math.min(moving.x1, moving.x2), Math.min(plan.width - Math.max(moving.x1, moving.x2), point.x - dragRef.current.x));
        const dy = Math.max(-Math.min(moving.y1, moving.y2), Math.min(plan.height - Math.max(moving.y1, moving.y2), point.y - dragRef.current.y));
        setPlan({ ...origin, walls: origin.walls.map((wall) => wall.id === dragRef.current?.id ? { ...wall, x1: wall.x1 + dx, y1: wall.y1 + dy, x2: wall.x2 + dx, y2: wall.y2 + dy } : wall) });
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
    if (dragRef.current) {
      if (JSON.stringify(dragRef.current.original) !== JSON.stringify(plan)) {
        setHistory((stack) => [...stack.slice(-39), dragRef.current ? clonePlan(dragRef.current.original) : clonePlan(plan)]);
      }
      dragRef.current = null;
    }
  };

  const startWallDrag = (event: ReactPointerEvent<SVGLineElement>, wall: Wall) => {
    event.stopPropagation();
    setSelectedId(wall.id);
    setDraft({});
    if (panMode) return;
    const point = eventPoint(event);
    dragRef.current = { id: wall.id, x: point.x, y: point.y, original: clonePlan(plan) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const setWallValue = (key: 'x1' | 'y1' | 'x2' | 'y2' | 'thickness' | 'length', raw: number) => {
    if (!selectedWall || !Number.isFinite(raw) || raw < 0) return;
    setWallError('');
    setDraft((d) => ({ ...d, [key]: raw }));
  };
  const saveWallDraft = () => {
    if (!selectedWall) return;
    const values = {
      x1: draft.x1 ?? selectedWall.x1,
      y1: draft.y1 ?? selectedWall.y1,
      x2: draft.x2 ?? selectedWall.x2,
      y2: draft.y2 ?? selectedWall.y2,
      thickness: draft.thickness ?? selectedWall.thickness,
    };
    if (typeof draft.length === 'number') {
      const currentLength = Math.hypot(values.x2 - values.x1, values.y2 - values.y1);
      if (draft.length <= 0 || currentLength <= 0) {
        setWallError('壁の長さは1 mm以上で入力してください。');
        setDraft({});
        return;
      }
      const ratio = draft.length / currentLength;
      values.x2 = values.x1 + (values.x2 - values.x1) * ratio;
      values.y2 = values.y1 + (values.y2 - values.y1) * ratio;
    }
    if (values.x1 > plan.width || values.x2 > plan.width || values.y1 > plan.height || values.y2 > plan.height || values.thickness <= 0) {
      setWallError('壁は図面の範囲内に配置し、厚みを1 mm以上にしてください。');
      setDraft({});
      return;
    }
    const updatedWall = { ...selectedWall, ...values };
    if (plan.doors.some((door) => door.wallId === selectedWall.id && door.offset + door.width > distance(updatedWall))) {
      setWallError('この長さではドアが収まらないため、壁を変更できません。');
      setDraft({});
      return;
    }
    const next = { ...plan, walls: plan.walls.map((wall) => wall.id === selectedWall.id ? updatedWall : wall) };
    if (JSON.stringify(next) !== JSON.stringify(plan)) commit(next);
    setWallError('');
    setDraft({});
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
      const parsed = validatePlan(JSON.parse(jsonText));
      commit(clonePlan(parsed)); setSelectedId(null); setFileError(false); setFileMessage('間取りデータを読み込みました。');
    } catch (error) {
      setFileError(true); setFileMessage(error instanceof Error ? error.message : 'JSONを読み込めませんでした。');
    }
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
         <div className="top-actions"><span className={`status-pill${storageAvailable ? '' : ' storage-warning'}`} aria-label={storageAvailable ? 'この端末に保存中' : '端末内に保存できません'}><i className="status-dot" />{storageAvailable ? 'この端末に保存中' : '端末内に保存できません'}</span></div>
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
                    <rect x={room.x} y={room.y} width={room.width} height={room.height} fill={['#e8eee7','#f1e9dc','#e6ede9','#efe9e2','#e9eddf'][index % 5]} />
                     <text className="room-title" x={room.x + room.width / 2} y={room.y + room.height / 2 - 35} textAnchor="middle" fill="#53665c" fontSize="250" fontFamily="DM Sans, sans-serif" fontWeight="700">{room.name}</text>
                     <text className="room-meta" x={room.x + room.width / 2} y={room.y + room.height / 2 + 205} textAnchor="middle" fill="#879087" fontSize="142" fontFamily="DM Mono, monospace">{fmt(room.width)} × {fmt(room.height)}</text>
                  </g>
                ))}
                {plan.walls.map((wall) => {
                  const selected = wall.id === selectedId;
                  return <g key={wall.id}>
                    <line x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} stroke="#f3f0e8" strokeWidth={wall.thickness + 55} strokeLinecap="square" />
                    <line x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} stroke={selected ? '#cc805f' : '#394943'} strokeWidth={selected ? wall.thickness + 20 : wall.thickness} strokeLinecap="square" />
                    <line x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} stroke="transparent" strokeWidth={Math.max(380, wall.thickness + 180)} onPointerDown={(event) => startWallDrag(event, wall)} onClick={() => { setSelectedId(wall.id); setDraft({}); }} role="button" tabIndex={0} aria-label={`${wall.id}を選択、長さ ${fmt(distance(wall))} ミリ`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(wall.id); setDraft({}); } }} />
                    {selected && <g fill="#fff8ed" stroke="#c87757" strokeWidth="36"><circle cx={wall.x1} cy={wall.y1} r="100" /><circle cx={wall.x2} cy={wall.y2} r="100" /></g>}
                  </g>;
                })}
                {plan.doors.map((door) => {
                  const wall = plan.walls.find((item) => item.id === door.wallId);
                  if (!wall) return null;
                  const len = distance(wall); const ux = (wall.x2 - wall.x1) / len; const uy = (wall.y2 - wall.y1) / len;
                  const sx = wall.x1 + ux * door.offset; const sy = wall.y1 + uy * door.offset; const ex = sx + ux * door.width; const ey = sy + uy * door.width;
                  const sign = wall.id === 'wall-south' ? -1 : 1;
                  const nx = -uy * sign; const ny = ux * sign; const radius = door.width;
                  return <g key={door.id} pointerEvents="none">
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#f3f0e8" strokeWidth={wall.thickness + 90} />
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
                      <div className="input-wrap"><input className="number-input" type="number" min="0" max={key.startsWith('x') ? plan.width : plan.height} value={draft[key] ?? selectedWall[key]} onChange={(e) => setWallValue(key, Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} data-testid={`input-wall-${key}`} aria-label={`壁の${key}座標、ミリ`} /><span className="input-unit">mm</span></div>
                    </label>)}
                  </div>
                  <label><span className="field-label">壁の厚み</span><div className="input-wrap"><input className="number-input" type="number" min="1" value={draft.thickness ?? selectedWall.thickness} onChange={(e) => setWallValue('thickness', Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} data-testid="input-wall-thickness" aria-label="壁の厚み、ミリ" /><span className="input-unit">mm</span></div></label>
                   <label><span className="field-label">壁の長さ</span><div className="input-wrap"><input className="number-input" type="number" min="1" max={Math.round(Math.max(plan.width, plan.height))} value={draft.length ?? distance(selectedWall)} onChange={(e) => setWallValue('length', Number(e.target.value))} onBlur={saveWallDraft} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} data-testid="input-wall-length" aria-label="壁の長さ、ミリ" /><span className="input-unit">mm</span></div></label>
                   <div className="dimension-row"><span>端点間の長さ</span><span className="dimension-value">{fmt(distance(selectedWall))} mm</span></div>
                   {wallError && <div className="message error" role="alert">{wallError}</div>}
                </> : <div className="empty-inspector"><div><Ruler size={20} style={{ marginBottom: 9, color: '#789083' }} /><br />図面上の壁を選ぶと、<br />座標と長さを編集できます。</div></div>}
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-top"><h2 className="panel-heading">部屋の一覧</h2><span className="eyebrow">{plan.rooms.length} ROOMS</span></div>
              <div className="room-list">{plan.rooms.map((room) => <div className="room-row" key={room.id} data-testid={`room-row-${room.id}`}><span className="room-label"><i className="room-mark" /> <span className="room-name">{room.name}</span></span><span className="room-size">{fmt(room.width)} × {fmt(room.height)}</span></div>)}</div>
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

            <div className="help-line"><span className="help-mark"><CircleHelp size={13} /></span><span>壁をタップして選択、ドラッグで移動。スマホは二本指で拡大・縮小できます。Ctrl / ⌘ + Z で元に戻せます。</span></div>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
