import { Check, CircleAlert, X } from 'lucide-react';
import { pointOnWall, roomOutline, wallPoints } from '../model/geometry';
import type { ImportReview } from '../model/import-review';
import type { MigrationCandidate } from '../model/types';

type Props = {
  review: ImportReview;
  selectedId: MigrationCandidate['id'] | null;
  onSelect: (id: MigrationCandidate['id']) => void;
  onCancel: () => void;
  onApply: (candidate: MigrationCandidate) => void;
};

function CandidatePreview({ candidate }: { candidate: MigrationCandidate }) {
  const plan = candidate.plan;
  if (!plan || candidate.errors.length) {
    return <div className="migration-no-preview"><CircleAlert size={18} />この案は現在のデータでは適用できません。</div>;
  }

  const roomPoints = plan.rooms.map((room) => ({
    room,
    points: roomOutline(plan, room),
  }));

  return (
    <svg className="migration-preview" viewBox={`-350 -350 ${plan.width + 700} ${plan.height + 700}`} role="img" aria-label={`${candidate.title}の図面プレビュー`}>
      {roomPoints.map(({ room, points }, index) => (
        <polygon
          key={room.id}
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
          fill={['#e8eee7', '#f1e9dc', '#e6ede9', '#efe9e2', '#e9eddf'][index % 5]}
          stroke="#809087"
          strokeWidth={40}
        />
      ))}
      {plan.walls.map((wall) => {
        const { start, end } = wallPoints(plan, wall);
        return <line key={wall.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#394943" strokeWidth={wall.thicknessMm} />;
      })}
      {plan.doors.map((door) => {
        const wall = plan.walls.find((item) => item.id === door.wallId);
        if (!wall) return null;
        const first = pointOnWall(plan, wall, door.offsetMm);
        const second = pointOnWall(plan, wall, door.offsetMm + door.widthMm);
        return <line key={door.id} x1={first.x} y1={first.y} x2={second.x} y2={second.y} stroke="#fbf8f1" strokeWidth={Math.max(wall.thicknessMm + 50, 100)} />;
      })}
    </svg>
  );
}

export function MigrationReview({ review, selectedId, onSelect, onCancel, onApply }: Props) {
  const selected = review.candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const canApply = Boolean(selected?.plan && !selected.errors.length);

  return (
    <div className="migration-overlay">
      <section className="migration-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title">
        <header className="migration-header">
          <div>
            <div className="eyebrow">IMPORT REVIEW</div>
            <h2 id="migration-title">{review.sourceVersion === 1 ? '旧形式の図面を移行' : '読み込む図面を確認'}</h2>
            <p>候補を比較してから適用できます。今の図面は、適用するまで変更されません。</p>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="確認を閉じる"><X size={17} /></button>
        </header>

        <div className="migration-source-note">
          schemaVersion {review.sourceVersion} のJSONを検出しました。単位は mm です。
          {review.sourceVersion === 1 && ' 旧データは移行後も元の形式で保管されます。'}
        </div>

        <div className="migration-options" role="radiogroup" aria-label="移行案">
          {review.candidates.map((candidate) => {
            const active = candidate.id === selectedId;
            return (
              <button
                type="button"
                key={candidate.id}
                className={`migration-option${active ? ' active' : ''}${candidate.errors.length ? ' invalid' : ''}`}
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(candidate.id)}
              >
                <div className="migration-option-head">
                  <span className="migration-radio" aria-hidden="true">{active && <i />}</span>
                  <span className="migration-option-title">{candidate.title}</span>
                  {candidate.plan && !candidate.errors.length && <span className="migration-valid"><Check size={13} />検証済み</span>}
                </div>
                <p>{candidate.description}</p>
                {candidate.plan && <div className="migration-stats">頂点 {candidate.plan.vertices.length} ・壁 {candidate.plan.walls.length} ・部屋 {candidate.plan.rooms.length} ・扉 {candidate.plan.doors.length}</div>}
                <CandidatePreview candidate={candidate} />
                {candidate.warnings.map((warning) => <div className="migration-warning" key={warning}>{warning}</div>)}
                {candidate.errors.slice(0, 4).map((error) => <div className="migration-error" key={error}>{error}</div>)}
                {candidate.errors.length > 4 && <div className="migration-error">ほか {candidate.errors.length - 4} 件の検証エラーがあります。</div>}
              </button>
            );
          })}
        </div>

        <footer className="migration-footer">
          <span>{canApply ? '適用後も元のJSONは端末に残ります。' : '適用可能な検証済み候補を選んでください。'}</span>
          <div>
            <button className="button button-quiet" onClick={onCancel}>キャンセル</button>
            <button className="button button-primary" disabled={!canApply} onClick={() => selected && onApply(selected)}>
              <Check size={14} />この案を適用
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
