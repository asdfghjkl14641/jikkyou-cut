import { useCallback, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { deriveKeptRegions } from '../../../common/segments';
import { EXPORT_CANCELLED } from '../../../common/types';

export function useExport() {
  const filePath = useEditorStore((s) => s.filePath);
  const cues = useEditorStore((s) => s.cues);
  const durationSec = useEditorStore((s) => s.durationSec);
  const videoWidth = useEditorStore((s) => s.videoWidth);
  const videoHeight = useEditorStore((s) => s.videoHeight);
  const status = useEditorStore((s) => s.exportStatus);

  const startState = useEditorStore((s) => s.startExportState);
  const setProgress = useEditorStore((s) => s.setExportProgress);
  const succeed = useEditorStore((s) => s.succeedExport);
  const fail = useEditorStore((s) => s.failExport);
  const cancelState = useEditorStore((s) => s.cancelExportState);

  useEffect(
    () => window.api.onExportProgress(setProgress),
    [setProgress],
  );

  const start = useCallback(async () => {
    if (!filePath || cues.length === 0) return;
    const regions = deriveKeptRegions(cues, durationSec);
    if (regions.length === 0) return;

    // Force-flush the project file before export so the user's last edits
    // are durably saved even if the export crashes the app.
    try {
      await window.api.saveProject(filePath, cues);
    } catch (err) {
      console.warn('[export] preflight project save failed:', err);
    }

    startState();
    try {
      // Default to 1920x1080 if metadata never reported (defensive — the
      // export will still run; subtitles will just be sized as if for FHD).
      const w = videoWidth && videoWidth > 0 ? videoWidth : 1920;
      const h = videoHeight && videoHeight > 0 ? videoHeight : 1080;
      const result = await window.api.startExport({
        videoFilePath: filePath,
        regions: regions.map((r) => ({
          startSec: r.startSec,
          endSec: r.endSec,
        })),
        cues,
        videoWidth: w,
        videoHeight: h,
      });
      succeed(result);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === EXPORT_CANCELLED) {
        cancelState();
      } else {
        fail(e.message ?? '不明なエラーが発生しました');
      }
    }
  }, [filePath, cues, videoWidth, videoHeight, durationSec, startState, succeed, fail, cancelState]);

  const cancel = useCallback(async () => {
    if (status !== 'running') return;
    await window.api.cancelExport();
  }, [status]);

  return { start, cancel };
}
