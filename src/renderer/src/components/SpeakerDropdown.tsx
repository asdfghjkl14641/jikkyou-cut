import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Check, Plus, UserMinus } from 'lucide-react';
import styles from './SpeakerDropdown.module.css';

type Props = {
  cueId: string;
  currentSpeaker: string | undefined;
  // Allows customizing how the current speaker badge is displayed
  renderBadge?: (speaker: string | undefined, onClick: () => void, isOpen: boolean) => React.ReactNode;
};

function generateNewSpeakerId(existingSpeakers: string[]): string {
  const numbers = existingSpeakers
    .map(s => parseInt(s.replace('speaker_', ''), 10))
    .filter(n => !Number.isNaN(n));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 0;
  return `speaker_${next}`;
}

import { defaultSpeakerName } from '../../../common/speakers';

export default function SpeakerDropdown({ cueId, currentSpeaker, renderBadge }: Props) {
  const cues = useEditorStore((s) => s.cues);
  const updateCueSpeaker = useEditorStore((s) => s.updateCueSpeaker);
  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);

  const [isOpen, setIsOpen] = useState(false);
  const [dropdownUp, setDropdownUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activePreset = useMemo(() => {
    if (!subtitleSettings) return null;
    return subtitleSettings.presets.find(p => p.id === subtitleSettings.activePresetId) ?? null;
  }, [subtitleSettings]);

  const getSpeakerDisplayName = (speakerId: string | undefined): string => {
    if (!speakerId) return '— なし —';
    if (activePreset) {
      const style = activePreset.speakerStyles.find(s => s.speakerId === speakerId);
      if (style && style.speakerName) return style.speakerName;
    }
    return defaultSpeakerName(speakerId);
  };

  const availableSpeakers = useMemo(() => {
    const set = new Set<string>();
    for (const cue of cues) {
      if (cue.speaker) set.add(cue.speaker);
    }
    return Array.from(set).sort();
  }, [cues]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
      
      // Check space below to see if we should open upwards
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        // Estimate 200px height for dropdown
        if (spaceBelow < 200 && rect.top > 200) {
          setDropdownUp(true);
        } else {
          setDropdownUp(false);
        }
      }
    }

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (speakerId: string | undefined) => {
    updateCueSpeaker(cueId, speakerId);
    setIsOpen(false);
  };

  const handleAddNew = () => {
    const newId = generateNewSpeakerId(availableSpeakers);
    updateCueSpeaker(cueId, newId);
    setIsOpen(false);
  };

  // Default badge renderer
  const defaultRenderBadge = () => {
    let badgeText = '[—]';
    if (currentSpeaker) {
      const name = getSpeakerDisplayName(currentSpeaker);
      badgeText = `[${name}]`;
    }
    
    return (
      <span 
        className={`${styles.badge} ${isOpen ? styles.badgeActive : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="話者を変更"
      >
        {badgeText}{isOpen ? '▲' : '▼'}
      </span>
    );
  };

  return (
    <div className={styles.badgeWrapper} ref={containerRef}>
      {renderBadge 
        ? renderBadge(currentSpeaker, () => setIsOpen(!isOpen), isOpen) 
        : defaultRenderBadge()}
        
      {isOpen && (
        <div className={`${styles.dropdownContainer} ${dropdownUp ? styles.dropdownContainerUp : ''}`}>
          {availableSpeakers.map((spk) => {
            const isActive = spk === currentSpeaker;
            return (
              <button
                key={spk}
                type="button"
                className={`${styles.dropdownItem} ${isActive ? styles.dropdownItemActive : ''}`}
                onClick={() => handleSelect(spk)}
              >
                {isActive ? <Check size={16} /> : <span className={styles.iconPlaceholder} />}
                {getSpeakerDisplayName(spk)}
              </button>
            );
          })}
          
          <div className={styles.separator} />
          
          <button
            type="button"
            className={styles.dropdownItem}
            onClick={handleAddNew}
          >
            <Plus size={16} className={styles.newSpeakerText} />
            <span className={styles.newSpeakerText}>新規話者を追加</span>
          </button>
          
          <button
            type="button"
            className={styles.dropdownItem}
            onClick={() => handleSelect(undefined)}
          >
            <UserMinus size={16} />
            — なし —
          </button>
        </div>
      )}
    </div>
  );
}
