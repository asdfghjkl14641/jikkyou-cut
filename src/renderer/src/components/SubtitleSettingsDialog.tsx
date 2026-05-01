import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { X, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { SubtitleSettings, SubtitleStyle, InstalledFont } from '../../../common/types';
import FontManagerDialog from './FontManagerDialog';
import styles from './SubtitleSettingsDialog.module.css';

type Props = {
  open: boolean;
  onClose: () => void;
};

// Debounce helper
function useDebounce<T extends (...args: any[]) => void>(
  callback: T,
  delay: number,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        callback(...args);
      }, delay);
    },
    [callback, delay],
  );
}

export default function SubtitleSettingsDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);
  const updateSubtitleSettings = useEditorStore((s) => s.updateSubtitleSettings);

  const [installedFonts, setInstalledFonts] = useState<InstalledFont[]>([]);
  const [fontManagerOpen, setFontManagerOpen] = useState(false);

  // Fetch fonts when dialog opens or when returning from FontManager
  const loadFonts = useCallback(async () => {
    try {
      const fonts = await window.api.fonts.listInstalled();
      setInstalledFonts(fonts);
    } catch (err) {
      console.warn('Failed to load installed fonts', err);
    }
  }, []);

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
      void loadFonts();
    } else {
      dialogRef.current?.close();
    }
  }, [open, loadFonts]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  // Debounced API save
  const debouncedSave = useDebounce((settings: SubtitleSettings) => {
    window.api.subtitleSettings.save(settings).catch((err) => {
      console.error('Failed to save subtitle settings', err);
    });
  }, 500);

  const updateSettings = useCallback(
    (newSettings: SubtitleSettings) => {
      updateSubtitleSettings(newSettings);
      debouncedSave(newSettings);
    },
    [updateSubtitleSettings, debouncedSave],
  );

  const activeStyle = useMemo(() => {
    if (!subtitleSettings) return null;
    return subtitleSettings.styles.find((s) => s.id === subtitleSettings.activeStyleId) ?? subtitleSettings.styles[0];
  }, [subtitleSettings]);

  if (!subtitleSettings || !activeStyle) return null;

  const handleMasterToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateSettings({ ...subtitleSettings, enabled: e.target.checked });
  };

  const handleSelectStyle = (id: string) => {
    updateSettings({ ...subtitleSettings, activeStyleId: id });
  };

  const handleDuplicateStyle = () => {
    const newStyle: SubtitleStyle = {
      ...activeStyle,
      id: nanoid(),
      name: `${activeStyle.name} (コピー)`,
      isBuiltin: false,
    };
    updateSettings({
      ...subtitleSettings,
      styles: [...subtitleSettings.styles, newStyle],
      activeStyleId: newStyle.id,
    });
  };

  const handleDeleteStyle = (id: string) => {
    const styleToDelete = subtitleSettings.styles.find((s) => s.id === id);
    if (!styleToDelete || styleToDelete.isBuiltin) return;
    
    const newStyles = subtitleSettings.styles.filter((s) => s.id !== id);
    let newActiveId = subtitleSettings.activeStyleId;
    if (newActiveId === id) {
      newActiveId = newStyles[0]?.id ?? '';
    }
    updateSettings({
      ...subtitleSettings,
      styles: newStyles,
      activeStyleId: newActiveId,
    });
  };

  const updateActiveStyle = (updates: Partial<SubtitleStyle>) => {
    const newStyles = subtitleSettings.styles.map((s) =>
      s.id === activeStyle.id ? { ...s, ...updates } : s,
    );
    updateSettings({ ...subtitleSettings, styles: newStyles });
  };

  const updateShadow = (updates: Partial<SubtitleStyle['shadow']>) => {
    updateActiveStyle({ shadow: { ...activeStyle.shadow, ...updates } });
  };

  const activeFont = installedFonts.find((f) => f.family === activeStyle.fontFamily);

  // Dynamic style for preview
  const previewStyle: React.CSSProperties = {
    fontFamily: `"${activeStyle.fontFamily}", sans-serif`,
    fontSize: `${activeStyle.fontSize}px`,
    color: activeStyle.textColor,
    // -webkit-text-stroke requires webkit prefix in React
    WebkitTextStroke: `${activeStyle.outlineWidth}px ${activeStyle.outlineColor}`,
    paintOrder: 'stroke fill', // to keep fill on top of stroke
  };

  if (activeStyle.shadow.enabled) {
    const s = activeStyle.shadow;
    previewStyle.filter = `drop-shadow(0px ${s.offsetPx}px 0px ${s.color})`;
  }

  let alignSelf = 'center';
  if (activeStyle.position === 'top') alignSelf = 'flex-start';
  if (activeStyle.position === 'bottom') alignSelf = 'flex-end';

  return (
    <>
      <dialog ref={dialogRef} className={styles.dialog} onClick={handleBackdropClick} onCancel={onClose}>
        <div className={styles.header}>
          <h2 className={styles.title}>字幕設定</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} title="閉じる">
            <X strokeWidth={1.5} size={20} />
          </button>
        </div>

        <div className={styles.body}>
          {/* Left Column: Styles and Preview */}
          <div className={styles.leftColumn}>
            <div className={styles.styleListSection}>
              <div className={styles.sectionTitle}>
                <span>スタイル</span>
                <button type="button" className={styles.iconButton} onClick={handleDuplicateStyle} title="現在のスタイルを複製">
                  <Plus size={16} />
                </button>
              </div>
              <ul className={styles.styleList}>
                {subtitleSettings.styles.map((style) => (
                  <li
                    key={style.id}
                    className={`${styles.styleItem} ${style.id === activeStyle.id ? styles.active : ''}`}
                    onClick={() => handleSelectStyle(style.id)}
                  >
                    <span className={styles.styleName}>{style.name}</span>
                    <div className={styles.styleActions}>
                      {!style.isBuiltin && (
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.danger}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteStyle(style.id);
                          }}
                          title="削除"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className={styles.previewSection}>
              {/* Inject font-face dynamically for the preview if we have the file path */}
              {activeFont && (
                <style dangerouslySetInnerHTML={{
                  __html: `
                    @font-face {
                      font-family: "${activeFont.family}";
                      src: url("file:///${activeFont.filePath.replace(/\\/g, '/')}");
                    }
                  `
                }} />
              )}
              <div
                className={styles.previewText}
                style={{ ...previewStyle, alignSelf }}
              >
                ご視聴ありがとうございました
              </div>
            </div>
          </div>

          {/* Right Column: Settings */}
          <div className={styles.rightColumn}>
            <div className={styles.settingGroup} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className={styles.settingLabel} style={{ marginBottom: 0 }}>字幕を有効にする</span>
              <label className={styles.switch}>
                <input type="checkbox" checked={subtitleSettings.enabled} onChange={handleMasterToggle} />
                <span className={styles.slider}></span>
              </label>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: 'var(--space-2) 0' }} />

            {!activeStyle.isBuiltin && (
              <div className={styles.settingGroup}>
                <span className={styles.settingLabel}>スタイル名</span>
                <input
                  type="text"
                  className={styles.input}
                  value={activeStyle.name}
                  onChange={(e) => updateActiveStyle({ name: e.target.value })}
                />
              </div>
            )}

            <div className={styles.settingGroup}>
              <div className={styles.settingLabel}>
                <span>フォント</span>
                <button type="button" className={styles.linkButton} onClick={() => setFontManagerOpen(true)}>
                  + フォントをダウンロード
                </button>
              </div>
              <select
                className={styles.select}
                value={activeStyle.fontFamily}
                onChange={(e) => updateActiveStyle({ fontFamily: e.target.value })}
                disabled={activeStyle.isBuiltin}
              >
                {installedFonts.map((f) => (
                  <option key={f.family} value={f.family}>{f.family}</option>
                ))}
                {/* Fallback if active font is not in installed list yet */}
                {!installedFonts.find(f => f.family === activeStyle.fontFamily) && (
                  <option value={activeStyle.fontFamily}>{activeStyle.fontFamily} (未インストール)</option>
                )}
              </select>
            </div>

            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>
                <span>サイズ</span>
                <span className={styles.settingLabelValue}>{activeStyle.fontSize}px</span>
              </span>
              <input
                type="range"
                className={styles.rangeInput}
                min="20"
                max="100"
                value={activeStyle.fontSize}
                onChange={(e) => updateActiveStyle({ fontSize: Number(e.target.value) })}
                disabled={activeStyle.isBuiltin}
              />
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingGroup} style={{ flex: 1 }}>
                <span className={styles.settingLabel}>本文色</span>
                <div className={styles.colorInputWrapper}>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={activeStyle.textColor}
                    onChange={(e) => updateActiveStyle({ textColor: e.target.value })}
                    disabled={activeStyle.isBuiltin}
                  />
                  <span className={styles.settingLabelValue}>{activeStyle.textColor}</span>
                </div>
              </div>
              <div className={styles.settingGroup} style={{ flex: 1 }}>
                <span className={styles.settingLabel}>縁の色</span>
                <div className={styles.colorInputWrapper}>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={activeStyle.outlineColor}
                    onChange={(e) => updateActiveStyle({ outlineColor: e.target.value })}
                    disabled={activeStyle.isBuiltin}
                  />
                  <span className={styles.settingLabelValue}>{activeStyle.outlineColor}</span>
                </div>
              </div>
            </div>

            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>
                <span>縁の太さ</span>
                <span className={styles.settingLabelValue}>{activeStyle.outlineWidth}px</span>
              </span>
              <input
                type="range"
                className={styles.rangeInput}
                min="0"
                max="10"
                value={activeStyle.outlineWidth}
                onChange={(e) => updateActiveStyle({ outlineWidth: Number(e.target.value) })}
                disabled={activeStyle.isBuiltin}
              />
            </div>

            <div className={styles.settingGroup}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={activeStyle.shadow.enabled}
                  onChange={(e) => updateShadow({ enabled: e.target.checked })}
                  disabled={activeStyle.isBuiltin}
                />
                影をつける
              </label>
              
              {activeStyle.shadow.enabled && (
                <div className={styles.settingRow} style={{ marginTop: 'var(--space-2)' }}>
                  <div className={styles.colorInputWrapper}>
                    <input
                      type="color"
                      className={styles.colorInput}
                      value={activeStyle.shadow.color}
                      onChange={(e) => updateShadow({ color: e.target.value })}
                      disabled={activeStyle.isBuiltin}
                    />
                  </div>
                  <input
                    type="range"
                    className={styles.rangeInput}
                    min="1"
                    max="10"
                    value={activeStyle.shadow.offsetPx}
                    onChange={(e) => updateShadow({ offsetPx: Number(e.target.value) })}
                    disabled={activeStyle.isBuiltin}
                    style={{ flex: 1 }}
                  />
                  <span className={styles.settingLabelValue} style={{ width: '30px', textAlign: 'right' }}>
                    {activeStyle.shadow.offsetPx}px
                  </span>
                </div>
              )}
            </div>

            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>表示位置</span>
              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    className={styles.radio}
                    name="position"
                    value="top"
                    checked={activeStyle.position === 'top'}
                    onChange={() => updateActiveStyle({ position: 'top' })}
                    disabled={activeStyle.isBuiltin}
                  />
                  上
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    className={styles.radio}
                    name="position"
                    value="middle"
                    checked={activeStyle.position === 'middle'}
                    onChange={() => updateActiveStyle({ position: 'middle' })}
                    disabled={activeStyle.isBuiltin}
                  />
                  中央
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    className={styles.radio}
                    name="position"
                    value="bottom"
                    checked={activeStyle.position === 'bottom'}
                    onChange={() => updateActiveStyle({ position: 'bottom' })}
                    disabled={activeStyle.isBuiltin}
                  />
                  下
                </label>
              </div>
            </div>
          </div>
        </div>
      </dialog>

      {fontManagerOpen && (
        <FontManagerDialog
          open={fontManagerOpen}
          onClose={() => {
            setFontManagerOpen(false);
            void loadFonts(); // Refresh list after potential downloads
          }}
        />
      )}
    </>
  );
}
