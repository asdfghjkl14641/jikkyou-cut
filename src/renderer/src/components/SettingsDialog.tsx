import { useEffect, useRef } from 'react';
import { X, KeyRound, Database } from 'lucide-react';
import styles from './SettingsDialog.module.css';

// Trimmed-down Settings dialog. As of the API-management refactor +
// the data-collection tab move (2026-05-03), this dialog is now
// effectively a thin shell that points users at the API management
// screen for everything related to API keys, data collection
// controls, and the creator targeting list. Kept around so users who
// reach for "Settings" out of habit still find a way in.

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenApiManagement: () => void;
};

export default function SettingsDialog({ open, onClose, onOpenApiManagement }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>設定</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="閉じる"
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className={styles.body}>
        {/* Single hand-off section. Both API keys and data-collection
            controls (有効化 / 1 回だけ取得 / 取得を停止 / 配信者リスト)
            now live in the API 管理 screen. The Settings dialog is
            mostly a discoverability fallback. */}
        <div className={styles.section}>
          <label className={styles.label}>API キー / データ収集の設定</label>
          <div className={styles.help} style={{ marginTop: 0, marginBottom: 8 }}>
            Gladia / Anthropic / YouTube の API キー、データ収集の開始 / 停止、配信者リストはすべて「API 管理」画面に集約されています(メニュー → API 管理、または Ctrl+Shift+A)。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => {
                onClose();
                onOpenApiManagement();
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <KeyRound size={14} />
              API キー画面を開く
            </button>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => {
                onClose();
                onOpenApiManagement();
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="API 管理画面の「データ収集」タブで開始 / 停止できます"
            >
              <Database size={14} />
              データ収集画面を開く
            </button>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onClose}
        >
          閉じる
        </button>
      </div>
    </dialog>
  );
}
