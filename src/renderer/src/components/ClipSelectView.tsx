import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { ChevronLeft, Check, RotateCcw } from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
import styles from './ClipSelectView.module.css';

export default function ClipSelectView() {
  const filePath = useEditorStore((s) => s.filePath);
  const durationSec = useEditorStore((s) => s.durationSec);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setPhase = useEditorStore((s) => s.setPhase);
  const setClipRange = useEditorStore((s) => s.setClipRange);
  const bumpSeekNonce = useEditorStore((s) => s.bumpSeekNonce);

  const [localRange, setLocalRange] = useState<{ startSec: number; endSec: number } | null>(null);

  // Generate mock analysis based on actual duration
  const analysis = useMemo(() => {
    return generateMockAnalysis(durationSec ?? 0);
  }, [durationSec]);

  const handleBack = useCallback(() => {
    clearFile();
  }, [clearFile]);

  const handleEdit = useCallback(() => {
    if (localRange) {
      setClipRange(localRange);
      setPhase('edit');
    }
  }, [localRange, setClipRange, setPhase]);

  const handleClearRange = useCallback(() => {
    setLocalRange(null);
  }, []);

  const handleSeek = useCallback((sec: number) => {
    // We need a way to tell VideoPlayer to seek. 
    // VideoPlayer listens to currentTime if it changes, but usually we use a ref.
    // In App.tsx we have handleSeek which uses videoRef.current?.seekTo(sec).
    // Here we can use the same pattern if we had a ref, or just trigger a seekNonce bump
    // and have VideoPlayer react? No, VideoPlayer doesn't react to seekNonce.
    // Actually, App.tsx's handleSeek is passed to Timeline.
    // I'll use a local ref for VideoPlayer here.
  }, []);

  const videoRef = React.useRef<any>(null); // VideoPlayerHandle

  const handleSeekInternal = (sec: number) => {
    videoRef.current?.seekTo(sec);
  };

  // Esc to clear range
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClearRange();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClearRange]);

  if (!filePath) return null;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button type="button" className={styles.backButton} onClick={handleBack}>
            <ChevronLeft size={18} />
            戻る
          </button>
        </div>
        <div className={styles.headerRight}>
          {localRange && (
            <button type="button" className={styles.clearButton} onClick={handleClearRange} title="範囲をクリア (Esc)">
              <RotateCcw size={16} />
              クリア
            </button>
          )}
          <button 
            type="button" 
            className={styles.editButton} 
            onClick={handleEdit}
            disabled={!localRange}
          >
            <Check size={18} />
            この区間を編集
          </button>
        </div>
      </header>

      <main className={styles.content}>
        <div className={styles.videoWrapper}>
          <div className={styles.videoContainer}>
            <VideoPlayer 
              ref={videoRef}
              filePath={filePath}
              // No SubtitleOverlay here as requested
            />
          </div>
        </div>

        <div className={styles.graphWrapper}>
          <div className={styles.graphContainer}>
            <CommentAnalysisGraph 
              analysis={analysis}
              onSeek={handleSeekInternal}
              selectionRange={localRange}
              onSelectionChange={setLocalRange}
            />
            <div className={styles.graphLabel}>
              {localRange ? (
                <span className={styles.rangeText}>
                  選択範囲: {formatTime(localRange.startSec)} - {formatTime(localRange.endSec)} 
                  ({(localRange.endSec - localRange.startSec).toFixed(1)}s)
                </span>
              ) : (
                <span className={styles.hintText}>グラフをドラッグして編集したい範囲を選択してください</span>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}
