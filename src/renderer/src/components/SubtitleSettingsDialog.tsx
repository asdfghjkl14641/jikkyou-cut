import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { X, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { SubtitleSettings, SpeakerPreset, SpeakerStyle, InstalledFont } from '../../../common/types';
import { defaultSpeakerName } from '../../../common/speakers';
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
  const setActivePresetId = useEditorStore((s) => s.setActivePresetId);
  const cues = useEditorStore((s) => s.cues);

  const [installedFonts, setInstalledFonts] = useState<InstalledFont[]>([]);
  const [fontManagerOpen, setFontManagerOpen] = useState(false);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('default');

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

  const activePreset = useMemo(() => {
    if (!subtitleSettings) return null;
    const p = subtitleSettings.presets.find((x) => x.id === subtitleSettings.activePresetId);
    if (!p) return null;

    const newStyles = [...p.speakerStyles];
    const knownSpeakers = new Set(newStyles.map(s => s.speakerId));
    const defaultStyle = newStyles.find(s => s.speakerId === 'default') ?? newStyles[0]!;

    let changed = false;

    // Migrate old names if they look like "話者 (speaker_0)"
    for (const style of newStyles) {
      if (style.speakerName === `話者 (${style.speakerId})`) {
        style.speakerName = defaultSpeakerName(style.speakerId);
        changed = true;
      }
    }

    for (const c of cues) {
      if (c.speaker && !knownSpeakers.has(c.speaker)) {
        newStyles.push({ ...defaultStyle, speakerId: c.speaker, speakerName: defaultSpeakerName(c.speaker) });
        knownSpeakers.add(c.speaker);
        changed = true;
      }
    }

    if (changed) {
      return { ...p, speakerStyles: newStyles };
    }
    return p;
  }, [subtitleSettings, cues]);

  // If the active preset changed dynamically, we should save it if the user modifies anything.
  // The actual save happens in `updateActivePreset`.

  const updateActivePreset = useCallback((updates: Partial<SpeakerPreset>) => {
    if (!subtitleSettings || !activePreset) return;
    const newPresets = subtitleSettings.presets.map((p) =>
      p.id === activePreset.id ? { ...activePreset, ...updates, updatedAt: Date.now() } : p
    );
    updateSettings({ ...subtitleSettings, presets: newPresets });
  }, [subtitleSettings, activePreset, updateSettings]);

  if (!subtitleSettings || !activePreset) return null;

  const handleMasterToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateSettings({ ...subtitleSettings, enabled: e.target.checked });
  };

  const handleSelectPreset = (id: string) => {
    setActivePresetId(id);
  };

  const handleNewPreset = () => {
    const name = window.prompt('新しいプリセット名を入力してください:', `${activePreset.name} (コピー)`);
    if (!name) return;
    
    const newPreset: SpeakerPreset = {
      ...activePreset,
      id: nanoid(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    updateSettings({
      ...subtitleSettings,
      presets: [...subtitleSettings.presets, newPreset],
      activePresetId: newPreset.id,
    });
  };

  const handleDeletePreset = (id: string) => {
    if (id === 'preset-default') {
      window.alert('デフォルトプリセットは削除できません。');
      return;
    }
    if (!window.confirm('このプリセットを削除しますか？')) return;
    
    const newPresets = subtitleSettings.presets.filter((p) => p.id !== id);
    let newActiveId = subtitleSettings.activePresetId;
    if (newActiveId === id) {
      newActiveId = 'preset-default';
    }
    updateSettings({
      ...subtitleSettings,
      presets: newPresets,
      activePresetId: newActiveId,
    });
  };

  const activeSpeakerStyle = activePreset.speakerStyles.find(s => s.speakerId === selectedSpeakerId) ?? activePreset.speakerStyles[0]!;

  const updateActiveSpeaker = (updates: Partial<SpeakerStyle>) => {
    const newStyles = activePreset.speakerStyles.map((s) =>
      s.speakerId === activeSpeakerStyle.speakerId ? { ...s, ...updates } : s
    );
    updateActivePreset({ speakerStyles: newStyles });
  };

  const updateShadow = (updates: Partial<SpeakerStyle['shadow']>) => {
    updateActiveSpeaker({ shadow: { ...activeSpeakerStyle.shadow, ...updates } });
  };

  const handleAddSpeaker = () => {
    const existingIds = activePreset.speakerStyles.map(s => s.speakerId);
    const numbers = existingIds
      .map(s => parseInt(s.replace('speaker_', ''), 10))
      .filter(n => !Number.isNaN(n));
    const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 0;
    const newId = `speaker_${nextNum}`;
    
    const newStyles = [
      ...activePreset.speakerStyles,
      { ...activeSpeakerStyle, speakerId: newId, speakerName: defaultSpeakerName(newId) }
    ];
    updateActivePreset({ speakerStyles: newStyles });
    setSelectedSpeakerId(newId);
  };

  const handleDeleteSpeaker = (speakerId: string) => {
    if (speakerId === 'default') return;

    const isUsed = cues.some((c) => c.speaker === speakerId);
    if (isUsed) {
      window.alert('この話者は現在の動画内で使用されているため、削除できません。');
      return;
    }

    if (!window.confirm('この話者を削除しますか？')) return;
    
    const newStyles = activePreset.speakerStyles.filter(s => s.speakerId !== speakerId);
    updateActivePreset({ speakerStyles: newStyles });
    if (selectedSpeakerId === speakerId) {
      setSelectedSpeakerId('default');
    }
  };

  const activeFont = installedFonts.find((f) => f.family === activeSpeakerStyle.fontFamily);

  // Dynamic style for preview
  const previewStyle: React.CSSProperties = {
    fontFamily: `"${activeSpeakerStyle.fontFamily}", sans-serif`,
    fontSize: `${activeSpeakerStyle.fontSize}px`,
    color: activeSpeakerStyle.textColor,
    WebkitTextStroke: `${activeSpeakerStyle.outlineWidth}px ${activeSpeakerStyle.outlineColor}`,
    paintOrder: 'stroke fill',
  };

  if (activeSpeakerStyle.shadow.enabled) {
    const s = activeSpeakerStyle.shadow;
    previewStyle.filter = `drop-shadow(0px ${s.offsetPx}px 0px ${s.color})`;
  }

  let alignSelf = 'center';
  if (activeSpeakerStyle.position === 'top') alignSelf = 'flex-start';
  if (activeSpeakerStyle.position === 'bottom') alignSelf = 'flex-end';

  return (
    <>
      <dialog ref={dialogRef} className={styles.dialog} onClick={handleBackdropClick} onCancel={onClose}>
        <div className={styles.header}>
          <h2 className={styles.title}>字幕設定</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} title="閉じる">
            <X strokeWidth={1.5} size={20} />
          </button>
        </div>
        
        <div className={styles.topBar}>
          <div className={styles.presetGroup}>
            <span className={styles.settingLabel} style={{ marginBottom: 0 }}>プリセット:</span>
            <select
              className={styles.select}
              value={activePreset.id}
              onChange={(e) => handleSelectPreset(e.target.value)}
            >
              {subtitleSettings.presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button type="button" className={styles.newStyleButton} style={{ marginTop: 0 }} onClick={handleNewPreset}>
              <Plus size={16} /> 新規保存
            </button>
            {activePreset.id !== 'preset-default' && (
              <button 
                type="button" 
                className={`${styles.iconButton} ${styles.danger}`} 
                onClick={() => handleDeletePreset(activePreset.id)}
                title="プリセットを削除"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <div className={styles.settingGroup} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <span className={styles.settingLabel} style={{ marginBottom: 0 }}>字幕を有効にする</span>
            <label className={styles.switch}>
              <input type="checkbox" checked={subtitleSettings.enabled} onChange={handleMasterToggle} />
              <span className={styles.slider}></span>
            </label>
          </div>
        </div>

        <div className={styles.body}>
          {/* Left Column: Speakers List */}
          <div className={styles.leftColumn}>
            <div className={styles.styleListSection}>
              <div className={styles.sectionTitle}>
                <span>スピーカー</span>
                <button type="button" className={styles.iconButton} onClick={handleAddSpeaker} title="話者を追加">
                  <Plus size={16} />
                </button>
              </div>
              <ul className={styles.styleList}>
                {activePreset.speakerStyles.map((speaker) => (
                  <li
                    key={speaker.speakerId}
                    className={`${styles.styleItem} ${speaker.speakerId === selectedSpeakerId ? styles.active : ''}`}
                    onClick={() => setSelectedSpeakerId(speaker.speakerId)}
                  >
                    <span className={styles.styleName}>{speaker.speakerName}</span>
                    {speaker.speakerId !== 'default' && (
                      <div className={styles.styleActions}>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.danger}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSpeaker(speaker.speakerId);
                          }}
                          title="削除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right Column: Settings & Preview */}
          <div className={styles.rightColumn}>
            <div className={styles.sectionTitle}>詳細設定</div>
            
            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>話者名</span>
              <input
                type="text"
                className={styles.input}
                value={activeSpeakerStyle.speakerName}
                onChange={(e) => updateActiveSpeaker({ speakerName: e.target.value })}
                disabled={activeSpeakerStyle.speakerId === 'default'}
              />
            </div>

            <div className={styles.settingGroup}>
              <div className={styles.settingLabel}>
                <span>フォント</span>
                <button type="button" className={styles.linkButton} onClick={() => setFontManagerOpen(true)}>
                  + フォントをダウンロード
                </button>
              </div>
              <select
                className={styles.select}
                value={activeSpeakerStyle.fontFamily}
                onChange={(e) => updateActiveSpeaker({ fontFamily: e.target.value })}
              >
                {installedFonts.map((f) => (
                  <option key={f.family} value={f.family}>{f.family}</option>
                ))}
                {!installedFonts.find(f => f.family === activeSpeakerStyle.fontFamily) && (
                  <option value={activeSpeakerStyle.fontFamily}>{activeSpeakerStyle.fontFamily} (未インストール)</option>
                )}
              </select>
            </div>

            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>
                <span>サイズ</span>
                <span className={styles.settingLabelValue}>{activeSpeakerStyle.fontSize}px</span>
              </span>
              <input
                type="range"
                className={styles.rangeInput}
                min="20"
                max="100"
                value={activeSpeakerStyle.fontSize}
                onChange={(e) => updateActiveSpeaker({ fontSize: Number(e.target.value) })}
              />
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingGroup} style={{ flex: 1 }}>
                <span className={styles.settingLabel}>本文色</span>
                <div className={styles.colorInputWrapper}>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={activeSpeakerStyle.textColor}
                    onChange={(e) => updateActiveSpeaker({ textColor: e.target.value })}
                  />
                  <input 
                    type="text" 
                    className={styles.input} 
                    value={activeSpeakerStyle.textColor}
                    onChange={(e) => updateActiveSpeaker({ textColor: e.target.value })}
                    style={{ width: '80px', flex: 'none' }}
                  />
                </div>
              </div>
              <div className={styles.settingGroup} style={{ flex: 1 }}>
                <span className={styles.settingLabel}>縁の色</span>
                <div className={styles.colorInputWrapper}>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={activeSpeakerStyle.outlineColor}
                    onChange={(e) => updateActiveSpeaker({ outlineColor: e.target.value })}
                  />
                  <input 
                    type="text" 
                    className={styles.input} 
                    value={activeSpeakerStyle.outlineColor}
                    onChange={(e) => updateActiveSpeaker({ outlineColor: e.target.value })}
                    style={{ width: '80px', flex: 'none' }}
                  />
                </div>
              </div>
            </div>

            <div className={styles.settingGroup}>
              <span className={styles.settingLabel}>
                <span>縁の太さ</span>
                <span className={styles.settingLabelValue}>{activeSpeakerStyle.outlineWidth}px</span>
              </span>
              <input
                type="range"
                className={styles.rangeInput}
                min="0"
                max="10"
                value={activeSpeakerStyle.outlineWidth}
                onChange={(e) => updateActiveSpeaker({ outlineWidth: Number(e.target.value) })}
              />
            </div>

            <div className={styles.settingGroup}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={activeSpeakerStyle.shadow.enabled}
                  onChange={(e) => updateShadow({ enabled: e.target.checked })}
                />
                影をつける
              </label>
              
              {activeSpeakerStyle.shadow.enabled && (
                <div className={styles.settingRow} style={{ marginTop: 'var(--space-2)' }}>
                  <div className={styles.colorInputWrapper}>
                    <input
                      type="color"
                      className={styles.colorInput}
                      value={activeSpeakerStyle.shadow.color}
                      onChange={(e) => updateShadow({ color: e.target.value })}
                    />
                    <input 
                      type="text" 
                      className={styles.input} 
                      value={activeSpeakerStyle.shadow.color}
                      onChange={(e) => updateShadow({ color: e.target.value })}
                      style={{ width: '80px', flex: 'none' }}
                    />
                  </div>
                  <input
                    type="range"
                    className={styles.rangeInput}
                    min="1"
                    max="10"
                    value={activeSpeakerStyle.shadow.offsetPx}
                    onChange={(e) => updateShadow({ offsetPx: Number(e.target.value) })}
                    style={{ flex: 1 }}
                  />
                  <span className={styles.settingLabelValue} style={{ width: '30px', textAlign: 'right' }}>
                    {activeSpeakerStyle.shadow.offsetPx}px
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
                    checked={activeSpeakerStyle.position === 'top'}
                    onChange={() => updateActiveSpeaker({ position: 'top' })}
                  />
                  上
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    className={styles.radio}
                    name="position"
                    value="middle"
                    checked={activeSpeakerStyle.position === 'middle'}
                    onChange={() => updateActiveSpeaker({ position: 'middle' })}
                  />
                  中央
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    className={styles.radio}
                    name="position"
                    value="bottom"
                    checked={activeSpeakerStyle.position === 'bottom'}
                    onChange={() => updateActiveSpeaker({ position: 'bottom' })}
                  />
                  下
                </label>
              </div>
            </div>

            <div className={styles.previewSection}>
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
                サンプルテキスト
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
            void loadFonts();
          }}
        />
      )}
    </>
  );
}
