import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT') return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
};

const isInsideOpenDialog = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('dialog[open]') !== null;
};

type Options = {
  togglePlayPause: () => void;
};

export function useEditKeyboard(opts: Options) {
  // Latest-callback ref — lets the keydown listener stay attached for the
  // whole session while still calling the freshest closure each time.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || isInsideOpenDialog(e.target)) return;

      const store = useEditorStore.getState();
      const key = e.key;
      const ctrl = e.ctrlKey || e.metaKey;

      // Space — play/pause toggle. Available even before transcription.
      if (!ctrl && !e.shiftKey && (key === ' ' || key === 'Spacebar')) {
        e.preventDefault();
        optsRef.current.togglePlayPause();
        return;
      }

      // Everything below operates on cues; bail if there are none.
      if (store.cues.length === 0) return;

      // If we are in speaker-column mode, block cut/range/delete operations
      const isSpeakerColumn = store.viewMode === 'speaker-column';

      // Undo / Redo (allowed in both)
      if (ctrl && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          store.redo();
        } else {
          store.undo();
        }
        return;
      }
      if (ctrl && (key === 'y' || key === 'Y')) {
        e.preventDefault();
        store.redo();
        return;
      }

      if (isSpeakerColumn) {
        // Speaker Column Mode Navigation
        // Block forbidden actions
        if (ctrl && (key === 'a' || key === 'A')) {
          e.preventDefault();
          return;
        }
        if (!ctrl && !e.shiftKey && (key === 'd' || key === 'D')) {
          e.preventDefault();
          return;
        }
        if (!ctrl && e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
          e.preventDefault();
          return;
        }

        // Custom 2D navigation
        if (!ctrl && !e.shiftKey) {
          const cues = store.cues;
          const currentIndex = store.focusedIndex ?? 0;
          const currentCue = cues[currentIndex];
          if (!currentCue) return;

          // Identify speakers to establish column order
          const speakers = Array.from(new Set(cues.map(c => c.speaker || 'speaker_0'))).sort();
          const currentSpeaker = currentCue.speaker || 'speaker_0';
          const colIdx = speakers.indexOf(currentSpeaker);

          if (key === 'ArrowDown' || key === 'ArrowUp') {
            e.preventDefault();
            const dir = key === 'ArrowDown' ? 1 : -1;
            // Find next/prev cue in the same column
            let nextIdx = currentIndex + dir;
            while (nextIdx >= 0 && nextIdx < cues.length) {
              const cueAtIdx = cues[nextIdx];
              if (!cueAtIdx) break;
              const spk = cueAtIdx.speaker || 'speaker_0';
              if (spk === currentSpeaker) {
                store.selectByIndex(nextIdx);
                break;
              }
              nextIdx += dir;
            }
            return;
          }

          if (key === 'ArrowRight' || key === 'ArrowLeft') {
            e.preventDefault();
            const dir = key === 'ArrowRight' ? 1 : -1;
            const targetColIdx = colIdx + dir;
            if (targetColIdx >= 0 && targetColIdx < speakers.length) {
              const targetSpeaker = speakers[targetColIdx];
              // Find the closest cue in the target column (closest in time/index)
              // We'll search outwards from currentIndex
              let closestIdx = -1;
              let minDistance = Infinity;
              for (let i = 0; i < cues.length; i++) {
                const cueAtI = cues[i];
                if (!cueAtI) continue;
                const spk = cueAtI.speaker || 'speaker_0';
                if (spk === targetSpeaker) {
                  const dist = Math.abs(i - currentIndex);
                  if (dist < minDistance) {
                    minDistance = dist;
                    closestIdx = i;
                  }
                }
              }
              if (closestIdx !== -1) {
                store.selectByIndex(closestIdx);
              }
            }
            return;
          }
        }
        
        // If it's something else we don't explicitly handle, just return
        return;
      }

      // --- Linear Mode Operations ---

      // Select all
      if (ctrl && (key === 'a' || key === 'A')) {
        e.preventDefault();
        store.selectAll();
        return;
      }

      // Toggle delete on selection
      if (!ctrl && !e.shiftKey && (key === 'd' || key === 'D')) {
        e.preventDefault();
        store.toggleDeletedOnSelection();
        return;
      }

      // Range extension with Shift+↑↓
      if (!ctrl && e.shiftKey && key === 'ArrowDown') {
        e.preventDefault();
        store.extendSelectionBy(+1);
        return;
      }
      if (!ctrl && e.shiftKey && key === 'ArrowUp') {
        e.preventDefault();
        store.extendSelectionBy(-1);
        return;
      }

      // Plain focus movement
      if (!ctrl && !e.shiftKey && key === 'ArrowDown') {
        e.preventDefault();
        store.moveFocus(+1);
        return;
      }
      if (!ctrl && !e.shiftKey && key === 'ArrowUp') {
        e.preventDefault();
        store.moveFocus(-1);
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
