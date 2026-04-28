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

      // Undo / Redo
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
