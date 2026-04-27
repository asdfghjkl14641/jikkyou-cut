import styles from './ModelSetupBanner.module.css';

type Props = {
  onOpenSettings: () => void;
};

export default function ModelSetupBanner({ onOpenSettings }: Props) {
  return (
    <div className={styles.banner}>
      <div className={styles.message}>
        <span className={styles.icon}>⚠</span>
        <span>Whisperモデルが設定されていません。文字起こしを行うにはモデルを設定してください。</span>
      </div>
      <button type="button" className={styles.cta} onClick={onOpenSettings}>
        設定を開く
      </button>
    </div>
  );
}
