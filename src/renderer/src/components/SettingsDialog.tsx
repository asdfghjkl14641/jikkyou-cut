import { useEffect, useRef } from 'react';
import { X, KeyRound } from 'lucide-react';
import DataCollectionSettings from './DataCollectionSettings';
import styles from './SettingsDialog.module.css';

// Trimmed-down Settings dialog. As of the API-management refactor, all
// API-key entry has moved into the dedicated ApiManagementDialog
// (menu: API 管理 / Ctrl+Shift+A). This dialog now hosts the
// per-creator targeting list + collection-status summary, plus a hand-
// off button to the API management screen.

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
        {/* Hand-off banner so users who came here looking for API key
            entry get pointed at the new dedicated screen. */}
        <div className={styles.section}>
          <label className={styles.label}>API キーの設定</label>
          <div className={styles.help} style={{ marginTop: 0, marginBottom: 8 }}>
            Gladia / Anthropic / YouTube の各 API キーは「API 管理」画面に移動しました(メニュー → API 管理、または Ctrl+Shift+A)。
          </div>
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
            API 管理画面を開く
          </button>
        </div>

        {/* Data-collection: per-creator list + status panel. The API key
            section inside DataCollectionSettings has been removed; that
            component now hosts only the creator list + manager controls. */}
        <DataCollectionSettings />
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
