import React, { useState } from 'react';
import styles from './TermsOfServiceModal.module.css';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

type Props = {
  isOpen: boolean;
  onAccept: () => void;
  onClose: () => void;
};

export default function TermsOfServiceModal({ isOpen, onAccept, onClose }: Props) {
  const [checked, setChecked] = useState(false);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <ShieldCheck size={24} className={styles.headerIcon} />
          <h2 className={styles.title}>利用規約と同意のお願い</h2>
        </div>
        
        <div className={styles.content}>
          <p>
            URL動画ダウンロード機能（yt-dlp統合）をご利用いただく前に、以下の内容をご確認ください。
          </p>
          
          <div className={styles.warningBox}>
            <AlertTriangle size={20} className={styles.warningIcon} />
            <div className={styles.warningText}>
              <strong>重要: 著作権と利用許諾について</strong>
              <p>
                本機能は、技術的なデモンストレーションおよび、ユーザ自身が正当な権利を持つ、または権利者から明確な許諾を得たコンテンツの編集を支援することを目的としています。
              </p>
            </div>
          </div>
          
          <ul className={styles.list}>
            <li>公序良俗に反する使用、または他者の著作権を侵害する行為は禁止されています。</li>
            <li>ダウンロードしたコンテンツの取り扱い（再配布、公開など）については、各プラットフォームの利用規約および法令を遵守してください。</li>
            <li>本ツールの使用によって生じた不利益や損害について、開発者は一切の責任を負いません。</li>
          </ul>
        </div>
        
        <div className={styles.footer}>
          <label className={styles.checkboxLabel}>
            <input 
              type="checkbox" 
              checked={checked} 
              onChange={(e) => setChecked(e.target.checked)} 
            />
            <span>権利者から許諾を得たコンテンツのみ使用することを了承します。</span>
          </label>
          
          <div className={styles.actions}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              キャンセル
            </button>
            <button 
              type="button" 
              className={styles.acceptButton} 
              disabled={!checked} 
              onClick={onAccept}
            >
              同意して利用する
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
