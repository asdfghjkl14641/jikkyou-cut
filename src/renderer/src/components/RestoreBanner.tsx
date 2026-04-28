import { useEffect } from 'react';
import { CheckCircle } from 'lucide-react';
import styles from './RestoreBanner.module.css';

type Props = {
  total: number;
  deleted: number;
  onDismiss: () => void;
};

const AUTO_DISMISS_MS = 5000;

export default function RestoreBanner({ total, deleted, onDismiss }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className={styles.banner}
      onClick={onDismiss}
      role="status"
      aria-live="polite"
    >
      <CheckCircle size={16} className={styles.icon} />
      <span className={styles.message}>
        編集状態を復元しました({total}件、{deleted}件削除済み)
      </span>
    </div>
  );
}
