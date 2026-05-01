import React from 'react';
import styles from './UrlDownloadProgressDialog.module.css';
import { Download, X } from 'lucide-react';
import type { UrlDownloadProgress } from '../../../common/types';

type Props = {
  isOpen: boolean;
  progress: UrlDownloadProgress | null;
  onCancel: () => void;
};

export default function UrlDownloadProgressDialog({ isOpen, progress, onCancel }: Props) {
  if (!isOpen) return null;

  const percent = progress?.percent || 0;

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <Download size={20} className={styles.headerIcon} />
          <h2 className={styles.title}>ダウンロード中</h2>
        </div>
        
        <div className={styles.body}>
          <div className={styles.progressContainer}>
            <div className={styles.progressBar}>
              <div 
                className={styles.progressFill} 
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className={styles.percentText}>{percent.toFixed(1)}%</span>
          </div>
          
          <div className={styles.meta}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>速度:</span>
              <span className={styles.metaValue}>{progress?.speed || '--'}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>残り時間:</span>
              <span className={styles.metaValue}>{progress?.eta || '--'}</span>
            </div>
          </div>
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
