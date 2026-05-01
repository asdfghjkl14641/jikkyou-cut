import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { findCueIndexForCurrent } from '../../../common/segments';
import { resolveSubtitleStyle } from '../../../common/subtitleResolution';
import { defaultSpeakerName } from '../../../common/speakers';
import { Play, User, Wand2 } from 'lucide-react';
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
  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);
  
  const selectByIndex = useEditorStore((s) => s.selectByIndex);
  
  const activePreset = useMemo(() => {
    if (!subtitleSettings) return null;
    return subtitleSettings.presets.find(p => p.id === subtitleSettings.activePresetId) ?? null;
  }, [subtitleSettings]);

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

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    cueId: string;
  } | null>(null);

  useEffect(() => {
    const handleOutsideClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('mousedown', handleOutsideClick);
      return () => document.removeEventListener('mousedown', handleOutsideClick);
    }
  }, [contextMenu]);

  return (
    <div className={styles.container}>
      {/* Shared sticky headers */}
      <div 
        className={styles.headerRow}
        style={{ '--column-count': speakers.length } as React.CSSProperties}
      >
        {speakers.map((speaker, colIdx) => (
          <ColumnHeader
            key={speaker}
            speakerId={speaker}
            speakerIndex={colIdx}
            count={cuesBySpeaker.get(speaker)?.length || 0}
          />
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
                  {cue.styleOverride && (
                    <span 
                      className={styles.overrideIcon} 
                      title={`${cue.styleOverride.speakerName} 適用中`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, cueId: cue.id });
                      }}
                    >
                      <Wand2 size={12} color="var(--accent-primary)" />
                    </span>
                  )}
                  {!cue.styleOverride && (
                    <span 
                      className={styles.overrideIconHover}
                      title="字幕スタイル上書き"
                      onClick={(e) => {
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, cueId: cue.id });
                      }}
                    >
                      <Wand2 size={12} color="var(--text-muted)" />
                    </span>
                  )}
                </div>
                {(() => {
                  const subtitleStyle = subtitleSettings && subtitleSettings.enabled && activePreset ? resolveSubtitleStyle(cue, activePreset) : null;
                  let textAreaStyle: React.CSSProperties = {};
                  
                  if (subtitleStyle && !isFocused) {
                    textAreaStyle = {
                      fontFamily: `"${subtitleStyle.fontFamily}", sans-serif`,
                      color: subtitleStyle.textColor,
                      WebkitTextStroke: `${subtitleStyle.outlineWidth}px ${subtitleStyle.outlineColor}`,
                      paintOrder: 'stroke fill',
                    };
                    if (subtitleStyle.shadow.enabled) {
                      const s = subtitleStyle.shadow;
                      textAreaStyle.filter = `drop-shadow(0px ${s.offsetPx}px 0px ${s.color})`;
                    }
                  }

                  return (
                    <textarea
                      className={styles.textInput}
                      value={cue.text}
                      onChange={(e) => handleTextChange(cue.id, e.target.value)}
                      onFocus={() => handleFocus(globalIndex, cue.startSec)}
                      rows={Math.max(1, cue.text.split('\n').length)}
                      style={textAreaStyle}
                    />
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
      


      {contextMenu && (
        <CueContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          cueId={contextMenu.cueId}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function CueContextMenu({ x, y, cueId, onClose }: { x: number, y: number, cueId: string, onClose: () => void }) {
  const subtitleSettings = useEditorStore(s => s.subtitleSettings);
  const cues = useEditorStore(s => s.cues);
  const updateCueStyleOverride = useEditorStore(s => s.updateCueStyleOverride);
  
  const cue = cues.find(c => c.id === cueId);
  const [showStyleSubMenu, setShowStyleSubMenu] = React.useState(false);
  
  if (!cue || !subtitleSettings) return null;

  const stylePresets = subtitleSettings.stylePresets;
  const isOverride = !!cue.styleOverride;

  const handleApplyPreset = (presetId: string | null) => {
    if (presetId === null) {
      updateCueStyleOverride(cueId, undefined);
    } else {
      const p = stylePresets.find(p => p.id === presetId);
      if (p) {
        const styleToSave = { ...p.style, speakerId: cue.id, speakerName: '上書きスタイル' };
        updateCueStyleOverride(cueId, styleToSave);
      }
    }
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
        padding: '4px 0',
        minWidth: '200px',
        zIndex: 1000,
        fontSize: 'var(--font-size-sm)',
        color: 'var(--text-primary)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div 
        style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}
        onMouseEnter={() => setShowStyleSubMenu(true)}
        onMouseLeave={() => setShowStyleSubMenu(false)}
      >
        <span>字幕スタイル ▶</span>
        <span style={{ color: 'var(--text-muted)' }}>
          {isOverride ? '上書き中' : 'デフォルト'}
        </span>
        
        {showStyleSubMenu && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: '100%',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
            padding: '4px 0',
            minWidth: '200px',
            zIndex: 1001,
          }}>
            <div 
              style={{ padding: '8px 16px', cursor: 'pointer', color: !isOverride ? 'var(--accent-primary)' : 'inherit' }}
              onClick={() => handleApplyPreset(null)}
            >
              {!isOverride && '✓ '}デフォルト(話者の設定)
            </div>
            <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '4px 0' }} />
            {stylePresets.map(p => (
              <div
                key={p.id}
                style={{ padding: '8px 16px', cursor: 'pointer' }}
                onClick={() => handleApplyPreset(p.id)}
              >
                {p.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ColumnHeader({ speakerId, speakerIndex, count }: { speakerId: string, speakerIndex: number, count: number }) {
  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);
  const updateSubtitleSettings = useEditorStore((s) => s.updateSubtitleSettings);
  
  const [isEditing, setIsEditing] = useState(false);
  
  const activePreset = subtitleSettings?.presets.find(p => p.id === subtitleSettings.activePresetId);
  const speakerStyle = activePreset?.speakerStyles.find(s => s.speakerId === speakerId);
  const defaultName = defaultSpeakerName(speakerId);
  const displayName = speakerStyle?.speakerName || defaultName;
  const [editValue, setEditValue] = useState(displayName);
  const isDefaultSpeaker = speakerId === 'default';

  const handleSave = () => {
    setIsEditing(false);
    if (isDefaultSpeaker || !subtitleSettings || !activePreset) return;
    
    const finalName = editValue.trim() || defaultName;
    
    const newStyles = [...activePreset.speakerStyles];
    const existingIndex = newStyles.findIndex(s => s.speakerId === speakerId);
    
    if (existingIndex >= 0) {
      newStyles[existingIndex] = { ...newStyles[existingIndex]!, speakerName: finalName };
    } else {
      const defaultStyle = newStyles.find(s => s.speakerId === 'default') ?? newStyles[0]!;
      newStyles.push({ ...defaultStyle, speakerId, speakerName: finalName });
    }
    
    const newPresets = subtitleSettings.presets.map(p => 
      p.id === activePreset.id ? { ...p, speakerStyles: newStyles, updatedAt: Date.now() } : p
    );
    
    const newSettings = { ...subtitleSettings, presets: newPresets };
    updateSubtitleSettings(newSettings);
    
    window.api.subtitleSettings.save(newSettings).catch(console.error);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(displayName);
    }
  };

  return (
    <div className={styles.columnHeader}>
      <User size={16} />
      <span className={styles.badge}>[{speakerIndex + 1}]</span>
      {isEditing && !isDefaultSpeaker ? (
        <input
          autoFocus
          className={styles.headerInput}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span 
          className={`${styles.speakerName} ${!isDefaultSpeaker ? styles.editableSpeakerName : ''}`}
          onClick={() => {
            if (!isDefaultSpeaker) {
              setEditValue(displayName);
              setIsEditing(true);
            }
          }}
          title={!isDefaultSpeaker ? "クリックして名前を編集" : undefined}
        >
          {displayName}
        </span>
      )}
      <span className={styles.count}>({count})</span>
    </div>
  );
}
