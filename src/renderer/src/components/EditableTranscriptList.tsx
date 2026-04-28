import { useEffect, useRef, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import styles from './EditableTranscriptList.module.css';

type Props = {
  onSeek?: (sec: number) => void;
};

const formatTimecode = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function EditableTranscriptList({ onSeek }: Props) {
  const transcription = useEditorStore((s) => s.transcription);
  const status = useEditorStore((s) => s.transcriptionStatus);
  const cues = useEditorStore((s) => s.cues);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const focusedIndex = useEditorStore((s) => s.focusedIndex);
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);

  const selectByIndex = useEditorStore((s) => s.selectByIndex);
  const extendSelectionTo = useEditorStore((s) => s.extendSelectionTo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const resetAllDeleted = useEditorStore((s) => s.resetAllDeleted);

  const focusedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [focusedIndex]);

  const handleRowClick = (e: MouseEvent<HTMLDivElement>, index: number, startSec: number) => {
    if (e.shiftKey) {
      // Range extension — does not seek, focus stays at the anchor.
      e.preventDefault();
      extendSelectionTo(index);
      return;
    }
    selectByIndex(index);
    onSeek?.(startSec);
  };

  if (status === 'success' && transcription && cues.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          文字起こし結果が0件でした(音声が検出されませんでした)。
        </div>
      </div>
    );
  }

  if (cues.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          動画を読み込んで「文字起こしを開始」を押してください。
        </div>
      </div>
    );
  }

  const deletedCount = cues.reduce((n, c) => n + (c.deleted ? 1 : 0), 0);

  return (
    <div className={styles.container}>
      <div className={styles.summary}>
        <span>
          {cues.length} 件 ({deletedCount} 件削除)
        </span>
        <span className={styles.summaryRight}>
          <button
            type="button"
            className={styles.miniButton}
            onClick={undo}
            disabled={past.length === 0}
            title="元に戻す (Ctrl+Z)"
          >
            ↩ Undo
          </button>
          <button
            type="button"
            className={styles.miniButton}
            onClick={redo}
            disabled={future.length === 0}
            title="やり直し (Ctrl+Shift+Z)"
          >
            ↪ Redo
          </button>
          <button
            type="button"
            className={styles.miniButton}
            onClick={resetAllDeleted}
            disabled={deletedCount === 0}
            title="削除をすべて取り消す"
          >
            リセット
          </button>
        </span>
      </div>

      <div className={styles.list}>
        {cues.map((cue, index) => {
          const isSelected = selectedIds.has(cue.id);
          const isFocused = focusedIndex === index;
          const className = [
            styles.cue,
            isSelected ? styles.cueSelected : '',
            isFocused ? styles.cueFocused : '',
            cue.deleted ? styles.cueDeleted : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={cue.id}
              ref={isFocused ? focusedRowRef : null}
              className={className}
              onClick={(e) => handleRowClick(e, index, cue.startSec)}
              role="button"
              tabIndex={-1}
            >
              <div className={styles.timecode}>
                {formatTimecode(cue.startSec)}
              </div>
              <div className={styles.text}>{cue.text}</div>
            </div>
          );
        })}
      </div>

      <div className={styles.hintBar}>
        <span><kbd>↑</kbd>/<kbd>↓</kbd> 選択</span>
        <span><kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> 範囲</span>
        <span><kbd>Ctrl</kbd>+<kbd>A</kbd> 全選択</span>
        <span><kbd>D</kbd> 削除/復活</span>
        <span><kbd>Space</kbd> 再生</span>
        <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> 元に戻す</span>
      </div>
    </div>
  );
}
