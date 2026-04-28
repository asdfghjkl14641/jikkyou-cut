import { KeyRound } from 'lucide-react';
import styles from './ApiKeySetupBanner.module.css';

type Props = {
  onOpenSettings: () => void;
};

export default function ApiKeySetupBanner({ onOpenSettings }: Props) {
  return (
    <div className={styles.banner}>
      <div className={styles.message}>
        <KeyRound size={16} className={styles.icon} />
        <span>
          Gemini APIキーが設定されていません。文字起こしを行うにはAPIキーを設定してください。
        </span>
      </div>
      <button type="button" className={styles.cta} onClick={onOpenSettings}>
        設定を開く
      </button>
    </div>
  );
}
