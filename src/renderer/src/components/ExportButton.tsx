import { useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useExport } from '../hooks/useExport';
import { deriveKeptRegions } from '../../../common/segments';
import { Download } from 'lucide-react';
import styles from './ExportButton.module.css';

export default function ExportButton() {
  const filePath = useEditorStore((s) => s.filePath);
  const cues = useEditorStore((s) => s.cues);
  const exportStatus = useEditorStore((s) => s.exportStatus);
  const { start } = useExport();

  const keptRegionCount = useMemo(
    () => deriveKeptRegions(cues).length,
    [cues],
  );

  const disabledReason: string | null = !filePath
    ? '動画を読み込んでください'
    : cues.length === 0
      ? '文字起こしを実行してください'
      : keptRegionCount === 0
        ? '全てのキューが削除されているため書き出しできません'
        : exportStatus === 'running'
          ? '書き出し中です'
          : null;

  return (
    <button
      type="button"
      className={styles.button}
      onClick={start}
      disabled={disabledReason !== null}
      title={disabledReason ?? '書き出しを実行'}
    >
      <Download strokeWidth={1.5} size={18} />
    </button>
  );
}
