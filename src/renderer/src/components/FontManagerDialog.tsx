import { useCallback, useEffect, useRef, useState } from 'react';
import { X, CheckCircle2, Download, Loader2, AlertCircle } from 'lucide-react';
import type { AvailableFont, FontDownloadProgress } from '../../../common/types';
import styles from './FontManagerDialog.module.css';

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function FontManagerDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  
  const [availableFonts, setAvailableFonts] = useState<AvailableFont[]>([]);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, FontDownloadProgress>>({});

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
      // Load fonts
      window.api.fonts.listAvailable().then(setAvailableFonts).catch(err => {
        console.error('Failed to load available fonts', err);
      });
      // Clear selection
      setSelectedFamilies(new Set());
      setDownloadProgress({});
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  // Subscribe to progress
  useEffect(() => {
    if (!open) return;
    const unsubscribe = window.api.onFontDownloadProgress((progress) => {
      setDownloadProgress((prev) => ({
        ...prev,
        [progress.family]: progress,
      }));
    });
    return unsubscribe;
  }, [open]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === dialogRef.current && !isDownloading) {
      onClose();
    }
  };

  const toggleSelection = (family: string) => {
    if (isDownloading) return;
    const next = new Set(selectedFamilies);
    if (next.has(family)) {
      next.delete(family);
    } else {
      next.add(family);
    }
    setSelectedFamilies(next);
  };

  const handleDownload = async () => {
    if (selectedFamilies.size === 0) return;
    setIsDownloading(true);
    
    try {
      const families = Array.from(selectedFamilies);
      const result = await window.api.fonts.download(families);
      
      // Update local state to reflect installation
      setAvailableFonts(prev => prev.map(f => {
        if (result.succeeded.includes(f.family)) {
          return { ...f, installed: true };
        }
        return f;
      }));
      
      // Clear successful selections
      const nextSelection = new Set(selectedFamilies);
      result.succeeded.forEach(f => nextSelection.delete(f));
      setSelectedFamilies(nextSelection);
      
      // Load the newly downloaded fonts dynamically
      try {
        const installedFonts = await window.api.fonts.listInstalled();
        for (const font of installedFonts) {
          if (result.succeeded.includes(font.family)) {
            const fontUrl = `file://${font.filePath.replace(/\\/g, '/')}`;
            const fontFace = new FontFace(font.family, `url("${fontUrl}")`);
            await fontFace.load();
            document.fonts.add(fontFace);
          }
        }
      } catch (err) {
        console.warn('Failed to load newly downloaded fonts', err);
      }
      
    } catch (err) {
      console.error('Download failed', err);
    } finally {
      setIsDownloading(false);
      // We don't automatically close so user can see errors or download more
    }
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} onClick={handleBackdropClick} onCancel={(e) => {
      if (isDownloading) e.preventDefault();
      else onClose();
    }}>
      <div className={styles.header}>
        <h2 className={styles.title}>フォント管理</h2>
        <button type="button" className={styles.closeButton} onClick={onClose} disabled={isDownloading} title="閉じる">
          <X strokeWidth={1.5} size={20} />
        </button>
      </div>

      <div className={styles.body}>
        {/* Load @font-face rules for all available fonts dynamically */}
        <style dangerouslySetInnerHTML={{
          __html: availableFonts.map(f => `
            @font-face {
              font-family: "Preview-${f.family}";
              src: url("${f.url}");
            }
          `).join('\n')
        }} />

        <ul className={styles.fontList}>
          {availableFonts.map((font) => {
            const progress = downloadProgress[font.family];
            const isSelected = selectedFamilies.has(font.family);
            
            return (
              <li 
                key={font.family} 
                className={`${styles.fontItem} ${font.installed && !isSelected ? styles.disabled : ''}`}
                onClick={() => {
                  if (!font.installed || progress?.status === 'failed') {
                    toggleSelection(font.family);
                  }
                }}
              >
                <div className={styles.checkboxWrapper}>
                  <input 
                    type="checkbox" 
                    className={styles.checkbox}
                    checked={isSelected || font.installed}
                    disabled={font.installed || isDownloading}
                    readOnly
                  />
                </div>
                
                <div className={styles.fontInfo}>
                  <div className={styles.fontHeader}>
                    <span className={styles.fontFamily}>{font.family}</span>
                    {font.installed && (
                      <span className={styles.installedBadge}>
                        <CheckCircle2 size={12} /> インストール済み
                      </span>
                    )}
                  </div>
                  <div 
                    className={styles.fontSample} 
                    style={{ fontFamily: `"Preview-${font.family}", sans-serif` }}
                  >
                    あいうえおABC 123
                  </div>
                  
                  {progress && (
                    <div className={`${styles.downloadStatus} ${progress.status === 'failed' ? styles.error : ''}`}>
                      {progress.status === 'starting' && <><Loader2 size={12} className={styles.loadingSpinner} /> ダウンロード中...</>}
                      {progress.status === 'done' && <><CheckCircle2 size={12} /> 完了</>}
                      {progress.status === 'failed' && <><AlertCircle size={12} /> 失敗: {progress.error}</>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.footer}>
        <button 
          type="button" 
          className={styles.cancelButton} 
          onClick={onClose}
          disabled={isDownloading}
        >
          閉じる
        </button>
        <button 
          type="button" 
          className={styles.downloadButton}
          onClick={handleDownload}
          disabled={isDownloading || selectedFamilies.size === 0}
        >
          {isDownloading ? (
            <><Loader2 size={16} className={styles.loadingSpinner} /> ダウンロード中...</>
          ) : (
            <><Download size={16} /> 選択したフォントをダウンロード</>
          )}
        </button>
      </div>
    </dialog>
  );
}
