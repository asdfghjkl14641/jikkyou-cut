import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { findCueIndexForCurrent } from '../../../common/segments';
import { Play, Subtitles } from 'lucide-react';
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
  const seekNonce = useEditorStore((s) => s.seekNonce);

  // Derive currentCueIndex from currentSec via a memoising selector that
  // also falls back to the nearest preceding cue when `currentSec` lies in
  // a gap. The same `findCueIndexForCurrent` function drives both the
  // ▶ + red-bar highlight here and the seek-time scroll target below — so
  // they stay perfectly in sync. Returns the same number across rAF ticks
  // unless the playhead crosses a meaningful boundary, so the rows skip
  // re-rendering when the index is stable.
  const currentCueIndex = useEditorStore((s) =>
    findCueIndexForCurrent(s.currentSec, s.cues),
  );

  const selectByIndex = useEditorStore((s) => s.selectByIndex);
  const extendSelectionTo = useEditorStore((s) => s.extendSelectionTo);
  const toggleCueSubtitle = useEditorStore((s) => s.toggleCueSubtitle);

  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);
  const activeStyle = useMemo(() => {
    if (!subtitleSettings) return null;
    return subtitleSettings.styles.find(s => s.id === subtitleSettings.activeStyleId) ?? null;
  }, [subtitleSettings]);

  const previewStyle = useMemo(() => {
    if (!activeStyle) return undefined;
    
    const baseSize = 20;
    const hoverSize = Math.min(activeStyle.fontSize, 48); // limit to 48px max
    
    const baseRatio = baseSize / activeStyle.fontSize;
    const hoverRatio = hoverSize / activeStyle.fontSize;
    
    const baseOutline = activeStyle.outlineWidth * baseRatio;
    const hoverOutline = activeStyle.outlineWidth * hoverRatio;
    
    const baseShadow = activeStyle.shadow.offsetPx * baseRatio;
    const hoverShadow = activeStyle.shadow.offsetPx * hoverRatio;

    return {
      fontFamily: `"${activeStyle.fontFamily}", sans-serif`,
      color: activeStyle.textColor,
      paintOrder: 'stroke fill',
      '--preview-font-size': `${baseSize}px`,
      '--preview-hover-font-size': `${hoverSize}px`,
      '--preview-stroke': activeStyle.outlineWidth > 0 ? `${baseOutline}px ${activeStyle.outlineColor}` : 'none',
      '--preview-hover-stroke': activeStyle.outlineWidth > 0 ? `${hoverOutline}px ${activeStyle.outlineColor}` : 'none',
      '--preview-shadow': activeStyle.shadow.enabled ? `${baseShadow}px ${baseShadow}px 0 ${activeStyle.shadow.color}` : 'none',
      '--preview-hover-shadow': activeStyle.shadow.enabled ? `${hoverShadow}px ${hoverShadow}px 0 ${activeStyle.shadow.color}` : 'none',
    } as React.CSSProperties;
  }, [activeStyle]);

  // Stable map from raw speaker label ("speaker_0") to a 1-indexed display
  // number. Only render the badge when at least 2 distinct speakers were
  // detected — single-speaker recordings shouldn't add UI noise.
  const speakerNumberOf = useMemo(() => {
    const order = new Map<string, number>();
    for (const c of cues) {
      if (c.speaker != null && !order.has(c.speaker)) {
        order.set(c.speaker, order.size + 1);
      }
    }
    return order;
  }, [cues]);
  const showSpeakerBadges = speakerNumberOf.size > 1;

  // Stable map of cue.id → row DOM node. Using a Map (rather than two
  // mutually-exclusive single refs) avoids the inline-callback churn that
  // made playingRowRef briefly null between renders.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setRowRef = (id: string) => (node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };

  // Scroll the focused row into view when keyboard navigation moves it.
  // Reads cues from getState() so this effect doesn't refire on every cue
  // edit — only on focus changes.
  useEffect(() => {
    if (focusedIndex == null) return;
    const c = useEditorStore.getState().cues[focusedIndex];
    if (!c) return;
    rowRefs.current.get(c.id)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [focusedIndex]);

  // Scroll the current row into view ONLY on explicit seek events
  // (bumpSeekNonce is called from VideoPlayer.handleSeeked). Ordinary
  // playback drift does not trigger scrolling. Uses the same
  // `findCueIndexForCurrent` as the highlight selector above, so the
  // scroll target and the ▶ marker can never disagree.
  useEffect(() => {
    if (seekNonce === 0) return; // Skip the mount-time fire
    const state = useEditorStore.getState();
    const idx = findCueIndexForCurrent(state.currentSec, state.cues);
    if (idx == null) return;
    const cue = state.cues[idx];
    if (!cue) return;
    rowRefs.current.get(cue.id)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [seekNonce]);

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
              ref={setRowRef(cue.id)}
              className={className}
              onClick={(e) => handleRowClick(e, index, cue.startSec)}
              role="button"
              tabIndex={-1}
            >
              <div className={styles.cueLeft}>
                <div className={styles.timecode}>
                  {isPlaying && (
                    <span className={styles.playingIcon} aria-label="再生中">
                      <Play size={10} fill="currentColor" />
                    </span>
                  )}
                  {showSpeakerBadges && cue.speaker != null && (
                    <span
                      className={styles.speakerBadge}
                      aria-label={`話者${speakerNumberOf.get(cue.speaker)}`}
                    >
                      [{speakerNumberOf.get(cue.speaker)}]
                    </span>
                  )}
                  <span>{formatTimecode(cue.startSec)}</span>
                </div>
                <div className={styles.text}>{cue.text}</div>
                
                {!cue.deleted && (
                  <div className={styles.subtitleToggle}>
                    <button
                      type="button"
                      className={`${styles.iconButton} ${cue.showSubtitle ? styles.active : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCueSubtitle(cue.id);
                      }}
                      title={cue.showSubtitle ? "字幕をオフにする" : "字幕をオンにする"}
                      style={{ opacity: cue.showSubtitle ? 1 : 0.3 }}
                    >
                      <Subtitles size={16} />
                    </button>
                  </div>
                )}
              </div>

              <div className={styles.cueRight}>
                {!activeStyle ? (
                  <span className={styles.fallbackPreview}>{cue.text}</span>
                ) : (
                  <span
                    className={styles.subtitlePreview}
                    style={{
                      ...previewStyle,
                      opacity: (!cue.showSubtitle || cue.deleted) ? 0.3 : 1,
                      textDecoration: cue.deleted ? 'line-through' : 'none',
                    }}
                  >
                    {cue.text}
                  </span>
                )}
              </div>
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
