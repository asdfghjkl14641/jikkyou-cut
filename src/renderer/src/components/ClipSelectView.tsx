import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check, RotateCcw } from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import type { CommentAnalysis as CommentAnalysisGraphType } from './CommentAnalysisGraph';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
import type {
  CommentAnalysis,
  CommentAnalysisProgress,
} from '../../../common/types';
import styles from './ClipSelectView.module.css';

type AnalysisState =
  | { kind: 'idle' }
  | { kind: 'loading'; phase: CommentAnalysisProgress['phase'] }
  | { kind: 'ready'; analysis: CommentAnalysis }
  | { kind: 'error'; message: string }
  | { kind: 'no-source' }; // local-file session, no URL to scrape from

const PHASE_LABEL: Record<CommentAnalysisProgress['phase'], string> = {
  chat: 'チャット取得中…',
  viewers: '視聴者数取得中…',
  scoring: 'スコア計算中…',
};

export default function ClipSelectView() {
  const filePath = useEditorStore((s) => s.filePath);
  const sourceUrl = useEditorStore((s) => s.sourceUrl);
  const durationSec = useEditorStore((s) => s.durationSec);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setPhase = useEditorStore((s) => s.setPhase);
  const setClipRange = useEditorStore((s) => s.setClipRange);

  const [localRange, setLocalRange] = useState<{ startSec: number; endSec: number } | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ kind: 'idle' });

  // Mock fallback while loading / on error / for local-file sessions —
  // gives the user something to drag against rather than a blank panel.
  const mockAnalysis = useMemo<CommentAnalysisGraphType>(() => {
    return generateMockAnalysis(durationSec ?? 0);
  }, [durationSec]);

  // Kick off the real comment analysis once we have URL + duration.
  // Re-runs if either changes (e.g. user goes back to load a different
  // video). Skipped for local-file sessions (sourceUrl == null).
  useEffect(() => {
    if (!filePath || durationSec == null || durationSec <= 0) return;

    if (!sourceUrl) {
      setAnalysisState({ kind: 'no-source' });
      return;
    }

    let cancelled = false;
    const cleanupProgress = window.api.commentAnalysis.onProgress((p) => {
      if (cancelled) return;
      setAnalysisState({ kind: 'loading', phase: p.phase });
    });

    setAnalysisState({ kind: 'loading', phase: 'chat' });

    window.api.commentAnalysis
      .start({ videoFilePath: filePath, sourceUrl, durationSec })
      .then((analysis) => {
        if (cancelled) return;
        setAnalysisState({ kind: 'ready', analysis });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[clip-select] comment analysis failed:', msg);
        setAnalysisState({ kind: 'error', message: msg });
      });

    return () => {
      cancelled = true;
      cleanupProgress();
      // Tell main to abort whatever's still running. Failures are
      // harmless if it's already done.
      void window.api.commentAnalysis.cancel().catch(() => {});
    };
  }, [filePath, sourceUrl, durationSec]);

  const graphAnalysis = useMemo<CommentAnalysisGraphType>(() => {
    if (analysisState.kind === 'ready') {
      // The IPC `CommentAnalysis` is a superset of the renderer-side
      // `CommentAnalysis`(adds hasViewerStats / chatMessageCount /
      // generatedAt). The graph component only uses the core fields.
      return analysisState.analysis;
    }
    return mockAnalysis;
  }, [analysisState, mockAnalysis]);

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
            />
          </div>
        </div>

        <div className={styles.graphWrapper}>
          <div className={styles.graphContainer}>
            <CommentAnalysisGraph
              analysis={graphAnalysis}
              onSeek={handleSeekInternal}
              selectionRange={localRange}
              onSelectionChange={setLocalRange}
            />
            <div className={styles.graphLabel}>
              {analysisState.kind === 'loading' && (
                <span className={styles.hintText}>{PHASE_LABEL[analysisState.phase]}(モックデータ表示中)</span>
              )}
              {analysisState.kind === 'error' && (
                <span className={styles.hintText}>分析失敗: {analysisState.message}(モックデータ表示中)</span>
              )}
              {analysisState.kind === 'no-source' && (
                <span className={styles.hintText}>
                  ローカル動画のためコメント分析はスキップ(モックデータ表示中)
                </span>
              )}
              {analysisState.kind === 'ready' && !localRange && (
                <span className={styles.hintText}>
                  分析完了: {analysisState.analysis.chatMessageCount} 件のコメント
                  {analysisState.analysis.hasViewerStats ? ' + 視聴者数' : '(視聴者数なし)'}
                  。グラフをドラッグして範囲を選択
                </span>
              )}
              {(analysisState.kind === 'ready' || analysisState.kind === 'no-source' || analysisState.kind === 'error') && localRange && (
                <span className={styles.rangeText}>
                  選択範囲: {formatTime(localRange.startSec)} - {formatTime(localRange.endSec)}
                  ({(localRange.endSec - localRange.startSec).toFixed(1)}s)
                </span>
              )}
              {analysisState.kind === 'idle' && !localRange && (
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
