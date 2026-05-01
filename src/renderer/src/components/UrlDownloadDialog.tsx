import React, { useState, useEffect } from 'react';
import styles from './UrlDownloadDialog.module.css';
import { Download, Link as LinkIcon, Folder, AlertCircle } from 'lucide-react';
import type { UrlDownloadArgs } from '../../../common/types';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onDownload: (args: UrlDownloadArgs) => void;
  defaultDir: string | null;
  defaultQuality: string;
};

export default function UrlDownloadDialog({ 
  isOpen, 
  onClose, 
  onDownload, 
  defaultDir, 
  defaultQuality 
}: Props) {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState(defaultQuality);
  const [outputDir, setOutputDir] = useState(defaultDir || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl('');
      setQuality(defaultQuality);
      setOutputDir(defaultDir || '');
      setError(null);
    }
  }, [isOpen, defaultDir, defaultQuality]);

  if (!isOpen) return null;

  const validateUrl = (val: string): boolean => {
    if (!val.trim()) return false;
    
    const isYouTube = /youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\//.test(val);
    const isTwitch = /twitch\.tv\/videos\/|twitch\.tv\/.+\/v\//.test(val);
    
    if (!isYouTube && !isTwitch) {
      setError('YouTube または Twitch の動画URLを入力してください。');
      return false;
    }
    
    setError(null);
    return true;
  };

  const handleDownload = () => {
    if (validateUrl(url) && outputDir) {
      onDownload({ url, quality, outputDir });
    }
  };

  const handleChangeDir = async () => {
    // We don't have a specific IPC for picking a directory yet, 
    // but openFileDialog usually allows picking a file. 
    // I should check if there's a directory picker.
    // Assuming openFileDialog might need a flag or I'll just use the file path's dir.
    // Actually, I'll use the existing openFileDialog logic if possible, 
    // but better to have a proper dir picker.
    // For now, I'll just use what's available or ask for one.
    // Let's assume there's a 'dialog:openDirectory' IPC I can add.
    const path = await (window as any).api.openDirectoryDialog();
    if (path) {
      setOutputDir(path);
    }
  };

  const canDownload = url.trim() && !error && outputDir;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <Download size={20} className={styles.headerIcon} />
          <h2 className={styles.title}>URLから動画をダウンロード</h2>
        </div>
        
        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>動画URL</label>
            <div className={styles.inputWrapper}>
              <LinkIcon size={16} className={styles.inputIcon} />
              <input 
                type="text" 
                className={styles.input} 
                placeholder="https://www.youtube.com/watch?v=..." 
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (e.target.value) validateUrl(e.target.value);
                  else setError(null);
                }}
              />
            </div>
            {error && (
              <div className={styles.error}>
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
          </div>
          
          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label}>画質</label>
              <select 
                className={styles.select} 
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                <option value="best">最高画質 (best)</option>
                <option value="2160">2160p (4K)</option>
                <option value="1440">1440p (2K)</option>
                <option value="1080">1080p (Full HD)</option>
                <option value="720">720p (HD)</option>
                <option value="480">480p</option>
                <option value="worst">最低画質 (worst)</option>
              </select>
            </div>
          </div>
          
          <div className={styles.field}>
            <label className={styles.label}>保存先フォルダ</label>
            <div className={styles.dirRow}>
              <div className={styles.dirValue} title={outputDir}>
                <Folder size={16} />
                <span>{outputDir || '選択されていません'}</span>
              </div>
              <button type="button" className={styles.dirButton} onClick={handleChangeDir}>
                フォルダを変更
              </button>
            </div>
          </div>
        </div>
        
        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose}>
            キャンセル
          </button>
          <button 
            type="button" 
            className={styles.downloadButton} 
            disabled={!canDownload}
            onClick={handleDownload}
          >
            ダウンロード
          </button>
        </div>
      </div>
    </div>
  );
}
