import React, { useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { findCueIndexForCurrent } from '../../../common/segments';
import { Play, User } from 'lucide-react';
import SpeakerDropdown from './SpeakerDropdown';
import styles from './SpeakerColumnView.module.css';

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

export default function SpeakerColumnView({ onSeek }: Props) {
  const cues = useEditorStore((s) => s.cues);
  const currentSec = useEditorStore((s) => s.currentSec);
  const focusedIndex = useEditorStore((s) => s.focusedIndex);
  const seekNonce = useEditorStore((s) => s.seekNonce);
  
  const selectByIndex = useEditorStore((s) => s.selectByIndex);

  const currentCueIndex = useEditorStore((s) =>
    findCueIndexForCurrent(s.currentSec, s.cues),
  );

  // Group cues by speaker
  const { speakers, cuesBySpeaker } = useMemo(() => {
    const speakerSet = new Set<string>();
    for (const c of cues) {
      if (c.speaker != null) speakerSet.add(c.speaker);
    }
    const speakersList = Array.from(speakerSet).sort();
    
    // Fallback if no speakers detected but we are in this mode anyway
    if (speakersList.length === 0) {
      speakersList.push('speaker_0');
    }

    const bySpeaker = new Map<string, typeof cues>();
    for (const spk of speakersList) {
      bySpeaker.set(spk, []);
    }

    for (const c of cues) {
      const spk = c.speaker ?? 'speaker_0';
      const arr = bySpeaker.get(spk);
      if (arr) {
        arr.push(c);
      } else if (!c.speaker && speakersList.length > 0) {
        // if no speaker assigned, just drop into the first bucket
        const firstSpk = speakersList[0];
        if (firstSpk) bySpeaker.get(firstSpk)?.push(c);
      }
    }

    return { speakers: speakersList, cuesBySpeaker: bySpeaker };
  }, [cues]);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setRowRef = (id: string) => (node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };

  useEffect(() => {
    if (focusedIndex == null) return;
    const c = useEditorStore.getState().cues[focusedIndex];
    if (!c) return;
    rowRefs.current.get(c.id)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [focusedIndex]);

  useEffect(() => {
    if (seekNonce === 0) return;
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

  const handleFocus = (index: number, startSec: number) => {
    selectByIndex(index);
    onSeek?.(startSec);
  };

  // Handler for text input change
  const handleTextChange = (cueId: string, newText: string) => {
    const store = useEditorStore.getState();
    const cueIndex = store.cues.findIndex(c => c.id === cueId);
    if (cueIndex < 0) return;
    
    // We update via modifying past/future to support undo, or we can just update directly.
    // Given the constraints, let's just update the cue in place for now.
    // A proper implementation would dispatch an action like `updateCueText`.
    const snapshot = store.cues.map(c => ({ ...c }));
    const nextCues = store.cues.map(c => c.id === cueId ? { ...c, text: newText } : c);
    
    const nextPast = [...store.past, snapshot];
    if (nextPast.length > 100) nextPast.shift();
    
    useEditorStore.setState({
      cues: nextCues,
      past: nextPast,
      future: [],
    });
  };

  return (
    <div className={styles.container}>
      {/* Shared sticky headers */}
      <div 
        className={styles.headerRow}
        style={{ '--column-count': speakers.length } as React.CSSProperties}
      >
        {speakers.map((speaker, colIdx) => (
          <div key={speaker} className={styles.columnHeader}>
            <User size={16} />
            <span className={styles.badge}>[{colIdx + 1}]</span>
            <span className={styles.speakerName}>{speaker}</span>
            <span className={styles.count}>({cuesBySpeaker.get(speaker)?.length || 0})</span>
          </div>
        ))}
      </div>

      <div 
        className={styles.speakerColumns} 
        style={{ '--column-count': speakers.length } as React.CSSProperties}
      >
        {cues.map((cue, globalIndex) => {
          const isFocused = focusedIndex === globalIndex;
          const isPlaying = currentCueIndex === globalIndex;
          
          const spk = cue.speaker ?? speakers[0] ?? 'speaker_0';
          const colIdx = speakers.indexOf(spk);
          
          // CSS Grid placement (1-indexed)
          const gridColumn = colIdx >= 0 ? colIdx + 1 : 1;
          
          return (
            <div 
              key={cue.id} 
              ref={setRowRef(cue.id)}
              className={`${styles.cueRow} ${isFocused ? styles.cueFocused : ''} ${isPlaying ? styles.cuePlaying : ''}`}
              style={{ gridColumn }}
            >
              <div className={styles.cueCard} onClick={() => handleFocus(globalIndex, cue.startSec)}>
                <div className={styles.timecode}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isPlaying && (
                      <span className={styles.playingIcon} aria-label="再生中">
                        <Play size={10} fill="currentColor" />
                      </span>
                    )}
                    <span>{formatTimecode(cue.startSec)}</span>
                  </div>
                  <SpeakerDropdown
                    cueId={cue.id}
                    currentSpeaker={cue.speaker}
                  />
                </div>
                <textarea
                  className={styles.textInput}
                  value={cue.text}
                  onChange={(e) => handleTextChange(cue.id, e.target.value)}
                  onFocus={() => handleFocus(globalIndex, cue.startSec)}
                  rows={Math.max(1, cue.text.split('\n').length)}
                />
              </div>
            </div>
          );
        })}
      </div>
      
      <div className={styles.hintBar}>
        <span><kbd>↑</kbd>/<kbd>↓</kbd> 選択</span>
        <span><kbd>Space</kbd> 再生</span>
        <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo</span>
      </div>
    </div>
  );
}
