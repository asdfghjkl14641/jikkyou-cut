import { Info } from 'lucide-react';
import styles from './WindowSizeSlider.module.css';

type Props = {
  value: number;
  onChange: (sec: number) => void;
};

const formatWindowLabel = (sec: number): string => {
  if (sec < 60) return `${sec} 秒`;
  const mins = sec / 60;
  // Step is 30 s, so we only ever see X or X.5 minutes — never deeper.
  if (Number.isInteger(mins)) return `${mins} 分`;
  return `${mins.toFixed(1)} 分`;
};

export default function WindowSizeSlider({ value, onChange }: Props) {
  return (
    <div className={styles.container}>
      <div className={styles.labelGroup}>
        <span className={styles.labelText}>ウィンドウ</span>
        <span className={styles.value}>{formatWindowLabel(value)}</span>
      </div>
      <input
        type="range"
        min={30}
        max={300}
        step={30}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={styles.slider}
        aria-label="ウィンドウサイズ"
      />
      <span
        className={styles.hint}
        title="切り抜き候補の最小幅。短いほど瞬間ピーク重視、長いほど持続的な盛り上がり重視"
      >
        <Info size={11} aria-hidden />
        ピーク検出粒度を調整
      </span>
    </div>
  );
}
