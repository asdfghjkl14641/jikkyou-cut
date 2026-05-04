import styles from './UrlDownloadProgressDialog.module.css';
import { Download, X } from 'lucide-react';
import type { UrlDownloadProgress } from '../../../common/types';

// 2026-05-04 — 4-bar progress dialog. Each row reflects one parallel
// task (audio / video / comment / scoring). The audio row keeps the
// speed + ETA mini-block underneath because that's the user's
// dominant signal for "how long until I can start editing". Other
// rows just show percent.
//
// Status semantics per row:
//   - waiting : dimmed, 0% bar, "—" percent text. Used while a task
//               hasn't fired yet (e.g. comment waiting on metadata
//               pre-fetch).
//   - active  : normal bar fill, percent text shown.
//   - done    : green bar at 100%, ✓ percent text.
type RowStatus = 'waiting' | 'active' | 'done';

export type DialogProgress = {
  audio: { status: RowStatus; percent: number; speed?: string; eta?: string };
  video: { status: RowStatus; percent: number };
  comment: { status: RowStatus; percent: number };
  scoring: { status: RowStatus; percent: number };
};

type Props = {
  isOpen: boolean;
  progress: DialogProgress;
  onCancel: () => void;
};

export default function UrlDownloadProgressDialog({ isOpen, progress, onCancel }: Props) {
  if (!isOpen) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <Download size={20} className={styles.headerIcon} />
          <h2 className={styles.title}>ダウンロード中</h2>
        </div>

        <div className={styles.body}>
          <ProgressRow label="音声" {...progress.audio} />
          {progress.audio.status === 'active' && (progress.audio.speed || progress.audio.eta) && (
            <div className={styles.audioMeta}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>速度</span>
                <span className={styles.metaValue}>{progress.audio.speed || '--'}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>残り時間</span>
                <span className={styles.metaValue}>{progress.audio.eta || '--'}</span>
              </div>
            </div>
          )}
          <ProgressRow label="動画" {...progress.video} />
          <ProgressRow label="コメント" {...progress.comment} />
          <ProgressRow label="解析" {...progress.scoring} />
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onCancel}>
            <X size={16} />
            <span>キャンセル</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgressRow({
  label,
  status,
  percent,
}: {
  label: string;
  status: RowStatus;
  percent: number;
}) {
  const labelClass =
    status === 'done' ? styles.rowDone : status === 'waiting' ? styles.rowWaiting : styles.rowLabel;
  const fillClass =
    status === 'done'
      ? `${styles.progressFill} ${styles.progressFillDone}`
      : status === 'waiting'
      ? `${styles.progressFill} ${styles.progressFillIdle}`
      : styles.progressFill;
  const percentText =
    status === 'done' ? '✓' : status === 'waiting' ? '—' : `${percent.toFixed(0)}%`;
  const percentClass =
    status === 'done' || status === 'active' ? styles.percentText : `${styles.percentText} ${styles.percentTextMuted}`;
  const fillWidth = status === 'done' ? 100 : status === 'waiting' ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div className={styles.row}>
      <span className={labelClass}>{label}</span>
      <div className={styles.progressBar}>
        <div className={fillClass} style={{ width: `${fillWidth}%` }} />
      </div>
      <span className={percentClass}>{percentText}</span>
    </div>
  );
}

// Helper for App.tsx — derive a DialogProgress from the existing
// progress event shapes. Keeps the dialog dumb (no IPC awareness).
export function buildDialogProgress(args: {
  audio: { active: boolean; done: boolean; raw: UrlDownloadProgress | null };
  video: { active: boolean; done: boolean; percent: number };
  comment: { active: boolean; done: boolean; phase: 'chat' | 'viewers' | 'scoring' | null };
  scoringDone: boolean;
}): DialogProgress {
  const audioRow: DialogProgress['audio'] = args.audio.done
    ? { status: 'done', percent: 100 }
    : args.audio.active
    ? {
        status: 'active',
        percent: args.audio.raw?.percent ?? 0,
        speed: args.audio.raw?.speed ?? undefined,
        eta: args.audio.raw?.eta ?? undefined,
      }
    : { status: 'waiting', percent: 0 };

  const videoRow: DialogProgress['video'] = args.video.done
    ? { status: 'done', percent: 100 }
    : args.video.active
    ? { status: 'active', percent: args.video.percent }
    : { status: 'waiting', percent: 0 };

  // Comment row maps the 'chat' / 'viewers' phase to a 0-66% range
  // (phases run sequentially inside main; ~equal time). 'scoring'
  // moves to the next row.
  let commentRow: DialogProgress['comment'];
  if (args.comment.done) {
    commentRow = { status: 'done', percent: 100 };
  } else if (args.comment.active) {
    const pct =
      args.comment.phase === 'chat' ? 33 :
      args.comment.phase === 'viewers' ? 66 :
      args.comment.phase === 'scoring' ? 100 : 0;
    commentRow = { status: 'active', percent: pct };
  } else {
    commentRow = { status: 'waiting', percent: 0 };
  }

  // Scoring is the final phase of comment analysis. We keep it as a
  // separate row for visual clarity; it sits at 'waiting' until the
  // scoring phase fires, then jumps to 'done' on completion.
  const scoringRow: DialogProgress['scoring'] = args.scoringDone
    ? { status: 'done', percent: 100 }
    : args.comment.active && args.comment.phase === 'scoring'
    ? { status: 'active', percent: 50 }
    : { status: 'waiting', percent: 0 };

  return {
    audio: audioRow,
    video: videoRow,
    comment: commentRow,
    scoring: scoringRow,
  };
}
