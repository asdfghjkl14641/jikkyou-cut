import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { X, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { SubtitleSettings, SpeakerPreset, SpeakerStyle, InstalledFont, StylePreset } from '../../../common/types';
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
  const [activeTab, setActiveTab] = useState<'speaker' | 'style'>('speaker');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('default');
  const [selectedStylePresetId, setSelectedStylePresetId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab === 'style' && !selectedStylePresetId && subtitleSettings?.stylePresets && subtitleSettings.stylePresets.length > 0) {
      setSelectedStylePresetId(subtitleSettings.stylePresets[0]!.id);
    }
  }, [activeTab, selectedStylePresetId, subtitleSettings]);

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
  const activeStylePreset = subtitleSettings.stylePresets.find(p => p.id === selectedStylePresetId) ?? subtitleSettings.stylePresets[0];

  const currentEditingStyle = activeTab === 'speaker' ? activeSpeakerStyle : activeStylePreset?.style;
  const isEditingDefaultSpeaker = activeTab === 'speaker' && activeSpeakerStyle.speakerId === 'default';

  const updateCurrentStyle = (updates: Partial<SpeakerStyle>) => {
    if (activeTab === 'speaker') {
      const newStyles = activePreset.speakerStyles.map((s) =>
        s.speakerId === activeSpeakerStyle.speakerId ? { ...s, ...updates } : s
      );
      updateActivePreset({ speakerStyles: newStyles });
    } else if (activeStylePreset) {
      const newPresets = subtitleSettings.stylePresets.map(p => 
        p.id === activeStylePreset.id ? { ...p, style: { ...p.style, ...updates } } : p
      );
      updateSettings({ ...subtitleSettings, stylePresets: newPresets });
    }
  };

  const updateShadow = (updates: Partial<SpeakerStyle['shadow']>) => {
    if (!currentEditingStyle) return;
    updateCurrentStyle({ shadow: { ...currentEditingStyle.shadow, ...updates } });
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

  const handleAddStylePreset = () => {
    const newPreset: StylePreset = {
      id: nanoid(),
      name: 'カスタムスタイル',
      style: {
        fontFamily: 'Noto Sans JP',
        fontSize: 48,
        textColor: '#FFFFFF',
        outlineColor: '#000000',
        outlineWidth: 4,
        shadow: { enabled: true, color: '#000000', offsetPx: 3 },
        position: 'bottom',
      }
    };
    updateSettings({ ...subtitleSettings, stylePresets: [...subtitleSettings.stylePresets, newPreset] });
    setSelectedStylePresetId(newPreset.id);
  };

  const handleDeleteStylePreset = (id: string) => {
    if (!window.confirm('このスタイルプリセットを削除しますか？')) return;
    const newPresets = subtitleSettings.stylePresets.filter(p => p.id !== id);
    updateSettings({ ...subtitleSettings, stylePresets: newPresets });
    if (selectedStylePresetId === id) {
      setSelectedStylePresetId(newPresets[0]?.id ?? null);
    }
  };

  const activeFont = currentEditingStyle ? installedFonts.find((f) => f.family === currentEditingStyle.fontFamily) : undefined;

  // Dynamic style for preview
  const previewStyle: React.CSSProperties | undefined = currentEditingStyle ? {
    fontFamily: `"${currentEditingStyle.fontFamily}", sans-serif`,
    fontSize: `${currentEditingStyle.fontSize}px`,
    color: currentEditingStyle.textColor,
    WebkitTextStroke: `${currentEditingStyle.outlineWidth}px ${currentEditingStyle.outlineColor}`,
    paintOrder: 'stroke fill',
  } : undefined;

  if (currentEditingStyle?.shadow.enabled && previewStyle) {
    const s = currentEditingStyle.shadow;
    previewStyle.filter = `drop-shadow(0px ${s.offsetPx}px 0px ${s.color})`;
  }

  let alignSelf = 'center';
  if (currentEditingStyle?.position === 'top') alignSelf = 'flex-start';
  if (currentEditingStyle?.position === 'bottom') alignSelf = 'flex-end';

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

        <div className={styles.tabBar}>
          <button 
            type="button" 
            className={`${styles.tabButton} ${activeTab === 'speaker' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('speaker')}
          >
            スピーカー設定
          </button>
          <button 
            type="button" 
            className={`${styles.tabButton} ${activeTab === 'style' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('style')}
          >
            スタイルプリセット
          </button>
        </div>

        <div className={styles.body}>
          {/* Left Column: List */}
          <div className={styles.leftColumn}>
            {activeTab === 'speaker' ? (
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
            ) : (
              <div className={styles.styleListSection}>
                <div className={styles.sectionTitle}>
                  <span>プリセット</span>
                  <button type="button" className={styles.iconButton} onClick={handleAddStylePreset} title="スタイルを追加">
                    <Plus size={16} />
                  </button>
                </div>
                <ul className={styles.styleList}>
                  {subtitleSettings.stylePresets.map((preset) => (
                    <li
                      key={preset.id}
                      className={`${styles.styleItem} ${preset.id === selectedStylePresetId ? styles.active : ''}`}
                      onClick={() => setSelectedStylePresetId(preset.id)}
                    >
                      <span className={styles.styleName}>{preset.name}</span>
                      <div className={styles.styleActions}>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.danger}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteStylePreset(preset.id);
                          }}
                          title="削除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right Column: Settings & Preview */}
          <div className={styles.rightColumn}>
            {currentEditingStyle && (
              <>
                <div className={styles.sectionTitle}>詳細設定</div>
                
                {activeTab === 'speaker' ? (
                  <div className={styles.settingGroup}>
                    <span className={styles.settingLabel}>話者名</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={activeSpeakerStyle.speakerName}
                      onChange={(e) => updateCurrentStyle({ speakerName: e.target.value } as any)}
                      disabled={isEditingDefaultSpeaker}
                    />
                  </div>
                ) : (
                  <div className={styles.settingGroup}>
                    <span className={styles.settingLabel}>プリセット名</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={activeStylePreset?.name || ''}
                      onChange={(e) => {
                        const newPresets = subtitleSettings.stylePresets.map(p => 
                          p.id === activeStylePreset?.id ? { ...p, name: e.target.value } : p
                        );
                        updateSettings({ ...subtitleSettings, stylePresets: newPresets });
                      }}
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
                    value={currentEditingStyle.fontFamily}
                    onChange={(e) => updateCurrentStyle({ fontFamily: e.target.value })}
                  >
                    {installedFonts.map((f) => (
                      <option key={f.family} value={f.family}>{f.family}</option>
                    ))}
                    {!installedFonts.find(f => f.family === currentEditingStyle.fontFamily) && (
                      <option value={currentEditingStyle.fontFamily}>{currentEditingStyle.fontFamily} (未インストール)</option>
                    )}
                  </select>
                </div>

                <div className={styles.settingGroup}>
                  <span className={styles.settingLabel}>
                    <span>サイズ</span>
                    <span className={styles.settingLabelValue}>{currentEditingStyle.fontSize}px</span>
                  </span>
                  <input
                    type="range"
                    className={styles.rangeInput}
                    min="20"
                    max="100"
                    value={currentEditingStyle.fontSize}
                    onChange={(e) => updateCurrentStyle({ fontSize: Number(e.target.value) })}
                  />
                </div>

                <div className={styles.settingRow}>
                  <div className={styles.settingGroup} style={{ flex: 1 }}>
                    <span className={styles.settingLabel}>本文色</span>
                    <div className={styles.colorInputWrapper}>
                      <input
                        type="color"
                        className={styles.colorInput}
                        value={currentEditingStyle.textColor}
                        onChange={(e) => updateCurrentStyle({ textColor: e.target.value })}
                      />
                      <input 
                        type="text" 
                        className={styles.input} 
                        value={currentEditingStyle.textColor}
                        onChange={(e) => updateCurrentStyle({ textColor: e.target.value })}
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
                        value={currentEditingStyle.outlineColor}
                        onChange={(e) => updateCurrentStyle({ outlineColor: e.target.value })}
                      />
                      <input 
                        type="text" 
                        className={styles.input} 
                        value={currentEditingStyle.outlineColor}
                        onChange={(e) => updateCurrentStyle({ outlineColor: e.target.value })}
                        style={{ width: '80px', flex: 'none' }}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.settingGroup}>
                  <span className={styles.settingLabel}>
                    <span>縁の太さ</span>
                    <span className={styles.settingLabelValue}>{currentEditingStyle.outlineWidth}px</span>
                  </span>
                  <input
                    type="range"
                    className={styles.rangeInput}
                    min="0"
                    max="10"
                    value={currentEditingStyle.outlineWidth}
                    onChange={(e) => updateCurrentStyle({ outlineWidth: Number(e.target.value) })}
                  />
                </div>

                <div className={styles.settingGroup}>
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={currentEditingStyle.shadow.enabled}
                      onChange={(e) => updateShadow({ enabled: e.target.checked })}
                    />
                    影をつける
                  </label>
                  
                  {currentEditingStyle.shadow.enabled && (
                    <div className={styles.settingRow} style={{ marginTop: 'var(--space-2)' }}>
                      <div className={styles.colorInputWrapper}>
                        <input
                          type="color"
                          className={styles.colorInput}
                          value={currentEditingStyle.shadow.color}
                          onChange={(e) => updateShadow({ color: e.target.value })}
                        />
                        <input 
                          type="text" 
                          className={styles.input} 
                          value={currentEditingStyle.shadow.color}
                          onChange={(e) => updateShadow({ color: e.target.value })}
                          style={{ width: '80px', flex: 'none' }}
                        />
                      </div>
                      <input
                        type="range"
                        className={styles.rangeInput}
                        min="1"
                        max="10"
                        value={currentEditingStyle.shadow.offsetPx}
                        onChange={(e) => updateShadow({ offsetPx: Number(e.target.value) })}
                        style={{ flex: 1 }}
                      />
                      <span className={styles.settingLabelValue} style={{ width: '30px', textAlign: 'right' }}>
                        {currentEditingStyle.shadow.offsetPx}px
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
                        checked={currentEditingStyle.position === 'top'}
                        onChange={() => updateCurrentStyle({ position: 'top' })}
                      />
                      上
                    </label>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        className={styles.radio}
                        name="position"
                        value="middle"
                        checked={currentEditingStyle.position === 'middle'}
                        onChange={() => updateCurrentStyle({ position: 'middle' })}
                      />
                      中央
                    </label>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        className={styles.radio}
                        name="position"
                        value="bottom"
                        checked={currentEditingStyle.position === 'bottom'}
                        onChange={() => updateCurrentStyle({ position: 'bottom' })}
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
              </>
            )}
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
