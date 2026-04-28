import { useEffect, useRef, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Play } from 'lucide-react';
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

  // Derive currentCueIndex from currentSec via a memoising selector. Returns
  // the same number across rAF ticks unless the playhead crosses a cue
  // boundary, so this row's render skips when the index is stable.
  const currentCueIndex = useEditorStore((s) => {
    if (s.cues.length === 0) return null;
    const t = s.currentSec;
    for (let i = 0; i < s.cues.length; i += 1) {
      const c = s.cues[i];
      if (!c) continue;
      if (t < c.startSec) return null;
      if (t < c.endSec) return i;
    }
    return null;
  });

  const selectByIndex = useEditorStore((s) => s.selectByIndex);
  const extendSelectionTo = useEditorStore((s) => s.extendSelectionTo);

  const focusedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [focusedIndex]);

  const handleRowClick = (
    e: MouseEvent<HTMLDivElement>,
    index: number,
    startSec: number,
  ) => {
    if (e.shiftKey) {
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

  return (
    <div className={styles.container}>
      <div className={styles.list}>
        {cues.map((cue, index) => {
          const isSelected = selectedIds.has(cue.id);
          const isFocused = focusedIndex === index;
          const isPlaying = currentCueIndex === index;
          const className = [
            styles.cue,
            isSelected ? styles.cueSelected : '',
            isFocused ? styles.cueFocused : '',
            isPlaying ? styles.cuePlaying : '',
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
                {isPlaying && (
                  <span className={styles.playingIcon} aria-label="再生中">
                    <Play size={10} fill="currentColor" />
                  </span>
                )}
                <span>{formatTimecode(cue.startSec)}</span>
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
        <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo</span>
      </div>
    </div>
  );
}
