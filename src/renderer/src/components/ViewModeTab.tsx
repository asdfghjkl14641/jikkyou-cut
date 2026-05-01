import React from 'react';
import { useEditorStore } from '../store/editorStore';
import { AlignLeft, Columns3 } from 'lucide-react';
import styles from './ViewModeTab.module.css';

export default function ViewModeTab() {
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const cues = useEditorStore((s) => s.cues);
  
  // Calculate if we have multiple speakers
  const uniqueSpeakers = new Set<string>();
  for (const c of cues) {
    if (c.speaker != null) {
      uniqueSpeakers.add(c.speaker);
    }
  }
  
  const hasMultipleSpeakers = uniqueSpeakers.size > 1;

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={`${styles.tab} ${viewMode === 'linear' ? styles.active : ''}`}
        onClick={() => setViewMode('linear')}
        title="時系列で全てのキューを1列に表示"
      >
        <AlignLeft size={16} />
        リニア
      </button>
      
      <button
        type="button"
        className={`${styles.tab} ${viewMode === 'speaker-column' ? styles.active : ''} ${!hasMultipleSpeakers ? styles.disabled : ''}`}
        onClick={() => {
          if (hasMultipleSpeakers) {
            setViewMode('speaker-column');
          }
        }}
        disabled={!hasMultipleSpeakers}
        title={hasMultipleSpeakers ? "話者ごとにカラムを分けて表示" : "コラボ動画(複数話者)でのみ利用可能"}
      >
        <Columns3 size={16} />
        話者カラム
      </button>
      
      {viewMode === 'speaker-column' && (
        <div className={styles.note}>
          ※テキスト編集・コピペ専用モード (削除や範囲選択は無効)
        </div>
      )}
    </div>
  );
}
