import {
  X,
  Undo2,
  Redo2,
  RefreshCw,
  MousePointerClick,
  Scissors,
  MousePointerSquareDashed,
  Trash2,
  RotateCcw,
  Play
} from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import styles from './OperationsDialog.module.css';
import React from 'react';

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export function OperationsDialog({ isOpen, onClose }: Props) {
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const resetAllDeleted = useEditorStore((s) => s.resetAllDeleted);
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);
  const deletedCount = useEditorStore((s) =>
    s.cues.reduce((n, c) => n + (c.deleted ? 1 : 0), 0)
  );

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2>操作パネル</h2>
          <button type="button" onClick={onClose} className={styles.closeButton}>
            <X strokeWidth={1.5} size={20} />
          </button>
        </div>

        <div className={styles.content}>
          {/* Action Buttons */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>実行コマンド</h3>
            <div className={styles.buttonGrid}>
              <button
                className={styles.actionBtn}
                onClick={undo}
                disabled={past.length === 0}
              >
                <Undo2 size={24} strokeWidth={1.5} />
                <span>元に戻す</span>
                <kbd>Ctrl+Z</kbd>
              </button>
              <button
                className={styles.actionBtn}
                onClick={redo}
                disabled={future.length === 0}
              >
                <Redo2 size={24} strokeWidth={1.5} />
                <span>やり直し</span>
                <kbd>Ctrl+Shift+Z</kbd>
              </button>
              <button
                className={styles.actionBtn}
                onClick={resetAllDeleted}
                disabled={deletedCount === 0}
              >
                <RefreshCw size={24} strokeWidth={1.5} />
                <span>全削除リセット</span>
                <kbd>UI</kbd>
              </button>
            </div>
          </div>

          {/* Shortcuts Info */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>ショートカット・コマンド一覧</h3>
            <div className={styles.shortcutGrid}>
              <div className={styles.shortcutItem}>
                <MousePointerClick className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>選択</span>
                <kbd>↑ / ↓</kbd>
              </div>
              <div className={styles.shortcutItem}>
                <MousePointerSquareDashed className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>範囲選択</span>
                <kbd>Shift + ↑ / ↓</kbd>
              </div>
              <div className={styles.shortcutItem}>
                <Scissors className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>全選択</span>
                <kbd>Ctrl + A</kbd>
              </div>
              <div className={styles.shortcutItem}>
                <Trash2 className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>削除</span>
                <kbd>D / Backspace</kbd>
              </div>
              <div className={styles.shortcutItem}>
                <RotateCcw className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>復活</span>
                <kbd>D / Backspace</kbd>
              </div>
              <div className={styles.shortcutItem}>
                <Play className={styles.icon} strokeWidth={1.5} size={18} />
                <span className={styles.label}>再生</span>
                <kbd>Space</kbd>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
