import { useEditorStore } from '../store/editorStore';
import styles from './TranscriptList.module.css';

const formatTimecode = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function TranscriptList() {
  const transcription = useEditorStore((s) => s.transcription);
  const status = useEditorStore((s) => s.transcriptionStatus);

  if (status === 'success' && transcription && transcription.cues.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          文字起こし結果が0件でした(音声が検出されませんでした)。
        </div>
      </div>
    );
  }

  if (!transcription || transcription.cues.length === 0) {
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
      <div className={styles.summary}>
        {transcription.cues.length} 件 · 保存先: {transcription.srtFilePath}
      </div>
      <div className={styles.list}>
        {transcription.cues.map((cue) => (
          <div key={cue.id} className={styles.cue}>
            <div className={styles.timecode}>{formatTimecode(cue.startSec)}</div>
            <div className={styles.text}>{cue.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
