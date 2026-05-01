import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';

const DEBOUNCE_MS = 1000;

// Persists the cue list (with `deleted` flags) to `<basename>.jcut.json`
// next to the video. Disk failures are swallowed with a `console.warn` —
// editing must keep working even on read-only paths.
export function useProjectAutoSave() {
  const filePath = useEditorStore((s) => s.filePath);
  const cues = useEditorStore((s) => s.cues);
  const activePresetId = useEditorStore((s) => s.subtitleSettings?.activePresetId);

  useEffect(() => {
    if (!filePath || cues.length === 0) return;

    const handle = setTimeout(() => {
      window.api.saveProject(filePath, cues, activePresetId ?? undefined).catch((err) => {
        console.warn('[project] save failed:', err);
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [filePath, cues, activePresetId]);
}
