import { useState, type DragEvent } from 'react';
import { Trash2, GripVertical, Edit2, Check, EyeOff, Eye } from 'lucide-react';
import type { ClipSegment, Eyecatch, ReactionCategory } from '../../../common/types';
import styles from './ClipSegmentsList.module.css';

const CATEGORY_NAMES: Record<ReactionCategory, string> = {
  laugh: '笑い',
  surprise: '驚き',
  emotion: '感動',
  praise: '称賛',
  death: '死亡',
  victory: '勝利',
  scream: '叫び',
  flag: 'フラグ',
  other: 'その他',
};

const CATEGORY_COLORS: Record<ReactionCategory, string> = {
  laugh: 'var(--reaction-laugh)',
  surprise: 'var(--reaction-surprise)',
  emotion: 'var(--reaction-emotion)',
  praise: 'var(--reaction-praise)',
  death: 'var(--reaction-death)',
  victory: 'var(--reaction-victory)',
  scream: 'var(--reaction-scream)',
  flag: 'var(--reaction-flag)',
  other: 'var(--reaction-other)',
};

const formatHMS = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

type Props = {
  segments: ClipSegment[];
  eyecatches: Eyecatch[];
  maxSegments: number;
  selectedSegmentId: string | null;
  onSelectSegment: (id: string) => void;
  onUpdateSegment: (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => void;
  onRemoveSegment: (id: string) => void;
  onUpdateEyecatch: (id: string, patch: Partial<Omit<Eyecatch, 'id'>>) => void;
  onClearAll: () => void;
  onReorder: (orderedIds: string[]) => void;
};

export default function ClipSegmentsList({
  segments,
  eyecatches,
  maxSegments,
  selectedSegmentId,
  onSelectSegment,
  onUpdateSegment,
  onRemoveSegment,
  onUpdateEyecatch,
  onClearAll,
  onReorder,
}: Props) {
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingEyecatchId, setEditingEyecatchId] = useState<string | null>(null);
  const [eyecatchDraft, setEyecatchDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const startTitleEdit = (s: ClipSegment) => {
    setEditingTitleId(s.id);
    setTitleDraft(s.title ?? '');
  };
  const commitTitle = () => {
    if (editingTitleId) {
      onUpdateSegment(editingTitleId, { title: titleDraft.trim() === '' ? null : titleDraft.trim() });
    }
    setEditingTitleId(null);
  };

  const startEyecatchEdit = (e: Eyecatch) => {
    setEditingEyecatchId(e.id);
    setEyecatchDraft(e.text);
  };
  const commitEyecatch = () => {
    if (editingEyecatchId) {
      onUpdateEyecatch(editingEyecatchId, { text: eyecatchDraft.trim() || '場面' });
    }
    setEditingEyecatchId(null);
  };

  const handleConfirmClear = () => {
    if (segments.length === 0) return;
    if (window.confirm(`${segments.length} 個の区間を全て削除しますか?`)) {
      onClearAll();
    }
  };

  const handleDragStart = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox to fire drag events.
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (id !== dragOverId) setDragOverId(id);
  };

  const handleDrop = (targetId: string) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const ids = segments.map((s) => s.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = ids.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId);
    onReorder(next);
    setDragId(null);
    setDragOverId(null);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerCount}>
          切り抜き区間 ({segments.length} / {maxSegments})
        </span>
        <button
          type="button"
          className={styles.clearAllButton}
          onClick={handleConfirmClear}
          disabled={segments.length === 0}
        >
          全削除
        </button>
      </div>

      {segments.length === 0 ? (
        <div className={styles.emptyState}>
          波形をドラッグするか、ピーク詳細パネルから区間を追加してください。
        </div>
      ) : (
        <div className={styles.list}>
          {segments.map((seg, i) => {
            const cat = seg.dominantCategory ?? 'other';
            const eyecatch = i < segments.length - 1 ? eyecatches[i] : undefined;
            const isSelected = selectedSegmentId === seg.id;
            return (
              <div key={seg.id}>
                <div
                  className={`${styles.card} ${isSelected ? styles.cardSelected : ''} ${dragOverId === seg.id ? styles.dropTarget : ''}`}
                  draggable
                  onDragStart={handleDragStart(seg.id)}
                  onDragOver={handleDragOver(seg.id)}
                  onDrop={handleDrop(seg.id)}
                  onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                  onClick={() => onSelectSegment(seg.id)}
                >
                  <div className={styles.cardLeft}>
                    <GripVertical size={14} className={styles.gripIcon} />
                    <span className={styles.indexBadge}>{i + 1}</span>
                    <span className={styles.categoryDot} style={{ background: CATEGORY_COLORS[cat] }} title={CATEGORY_NAMES[cat]} />
                  </div>
                  <div className={styles.cardMain}>
                    <div className={styles.cardTimeRow}>
                      <span className={styles.timeRange}>
                        {formatHMS(seg.startSec)} 〜 {formatHMS(seg.endSec)}
                      </span>
                      <span className={styles.duration}>({formatDuration(seg.endSec - seg.startSec)})</span>
                    </div>
                    {editingTitleId === seg.id ? (
                      <div className={styles.titleEditRow} onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          type="text"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitTitle();
                            else if (e.key === 'Escape') setEditingTitleId(null);
                          }}
                          onBlur={commitTitle}
                          className={styles.titleInput}
                          placeholder="区間タイトル"
                        />
                      </div>
                    ) : (
                      <div className={styles.titleRow}>
                        {seg.title ? (
                          <span className={styles.title}>{seg.title}</span>
                        ) : (
                          <span className={styles.titlePlaceholder}>タイトル未設定(AI 生成予定)</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => editingTitleId === seg.id ? commitTitle() : startTitleEdit(seg)}
                      title="タイトル編集"
                    >
                      {editingTitleId === seg.id ? <Check size={14} /> : <Edit2 size={14} />}
                    </button>
                    <button
                      type="button"
                      className={styles.iconButtonDanger}
                      onClick={() => onRemoveSegment(seg.id)}
                      title="削除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {eyecatch && (
                  <div className={`${styles.eyecatchRow} ${eyecatch.skip ? styles.eyecatchSkipped : ''}`}>
                    <div className={styles.eyecatchDecor} />
                    <span className={styles.eyecatchLabel}>
                      {eyecatch.skip ? '(直結 / アイキャッチなし)' : 'アイキャッチ:'}
                    </span>
                    {!eyecatch.skip && (
                      editingEyecatchId === eyecatch.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={eyecatchDraft}
                          onChange={(e) => setEyecatchDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEyecatch();
                            else if (e.key === 'Escape') setEditingEyecatchId(null);
                          }}
                          onBlur={commitEyecatch}
                          className={styles.eyecatchInput}
                        />
                      ) : (
                        <span className={styles.eyecatchText}>「{eyecatch.text}」</span>
                      )
                    )}
                    <div className={styles.eyecatchActions}>
                      {!eyecatch.skip && (
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={() => editingEyecatchId === eyecatch.id ? commitEyecatch() : startEyecatchEdit(eyecatch)}
                          title="テキスト編集"
                        >
                          {editingEyecatchId === eyecatch.id ? <Check size={12} /> : <Edit2 size={12} />}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.iconButton}
                        onClick={() => onUpdateEyecatch(eyecatch.id, { skip: !eyecatch.skip })}
                        title={eyecatch.skip ? 'アイキャッチを有効化' : 'アイキャッチをスキップ'}
                      >
                        {eyecatch.skip ? <Eye size={12} /> : <EyeOff size={12} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
