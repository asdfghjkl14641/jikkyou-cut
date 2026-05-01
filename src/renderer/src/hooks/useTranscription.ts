import { useCallback, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { TRANSCRIPTION_CANCELLED } from '../../../common/types';

export function useTranscription() {
  const filePath = useEditorStore((s) => s.filePath);
  const durationSec = useEditorStore((s) => s.durationSec);
  const status = useEditorStore((s) => s.transcriptionStatus);
  const collaborationMode = useEditorStore((s) => s.collaborationMode);
  const expectedSpeakerCount = useEditorStore((s) => s.expectedSpeakerCount);

  const startState = useEditorStore((s) => s.startTranscription);
  const setProgress = useEditorStore((s) => s.setTranscriptionProgress);
  const succeed = useEditorStore((s) => s.succeedTranscription);
  const fail = useEditorStore((s) => s.failTranscription);
  const cancelState = useEditorStore((s) => s.cancelTranscription);

  useEffect(
    () => window.api.onTranscriptionProgress(setProgress),
    [setProgress],
  );

  const start = useCallback(async () => {
    if (!filePath || durationSec == null) return;
    startState();
    try {
      const result = await window.api.startTranscription({
        videoFilePath: filePath,
        durationSec,
        collaborationMode,
        expectedSpeakerCount,
      });
      succeed(result);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === TRANSCRIPTION_CANCELLED) {
        cancelState();
      } else {
        fail(e.message ?? '不明なエラーが発生しました');
      }
    }
  }, [filePath, durationSec, collaborationMode, expectedSpeakerCount, startState, succeed, fail, cancelState]);

  const cancel = useCallback(async () => {
    if (status !== 'running') return;
    await window.api.cancelTranscription();
  }, [status]);

  return { start, cancel };
}
