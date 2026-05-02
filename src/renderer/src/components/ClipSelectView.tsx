import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check, RotateCcw } from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import PeakDetailPanel from './PeakDetailPanel';
import WindowSizeSlider from './WindowSizeSlider';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
import type {
  CommentAnalysis,
  CommentAnalysisProgress,
  ScoreSample,
} from '../../../common/types';
import styles from './ClipSelectView.module.css';

type AnalysisState =
  | { kind: 'idle' }
  | { kind: 'loading'; phase: CommentAnalysisProgress['phase'] }
  | { kind: 'ready'; analysis: CommentAnalysis }
  | { kind: 'error'; message: string }
  | { kind: 'no-source' };

const PHASE_LABEL: Record<CommentAnalysisProgress['phase'], string> = {
  chat: 'チャット取得中…',
  viewers: '視聴者数取得中…',
  scoring: 'スコア計算中…',
};

export default function ClipSelectView() {
  const filePath = useEditorStore((s) => s.filePath);
  const sourceUrl = useEditorStore((s) => s.sourceUrl);
  const durationSec = useEditorStore((s) => s.durationSec);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setCurrentSec = useEditorStore((s) => s.setCurrentSec);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setPhase = useEditorStore((s) => s.setPhase);
  const setClipRange = useEditorStore((s) => s.setClipRange);
  const analysisWindowSec = useEditorStore((s) => s.analysisWindowSec);
  const setAnalysisWindowSec = useEditorStore((s) => s.setAnalysisWindowSec);

  const [localRange, setLocalRange] = useState<{ startSec: number; endSec: number } | null>(null);
  const [selectedPeak, setSelectedPeak] = useState<ScoreSample | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ kind: 'idle' });

  const mockAnalysis = useMemo<CommentAnalysis>(() => {
    return generateMockAnalysis(durationSec ?? 0) as CommentAnalysis;
  }, [durationSec]);

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
      void window.api.commentAnalysis.cancel().catch(() => {});
    };
  }, [filePath, sourceUrl, durationSec]);

  const graphAnalysis = useMemo<CommentAnalysis>(() => {
    if (analysisState.kind === 'ready') {
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
    setSelectedPeak(null);
  }, []);

  const handleSetRange = useCallback((start: number, end: number) => {
    setClipRange({ startSec: start, endSec: end });
    setPhase('edit');
  }, [setClipRange, setPhase]);

  const videoRef = React.useRef<any>(null);

  const handleSeekInternal = (sec: number) => {
    videoRef.current?.seekTo(sec);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedPeak) {
          setSelectedPeak(null);
        } else {
          handleClearRange();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPeak, handleClearRange]);

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
          {(localRange || selectedPeak) && (
            <button type="button" className={styles.clearButton} onClick={handleClearRange} title="クリア (Esc)">
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
        <div className={styles.mainWorkarea}>
          <div className={styles.videoWrapper}>
            <div className={styles.videoContainer}>
              <VideoPlayer
                ref={videoRef}
                filePath={filePath}
                onDuration={setDuration}
                onCurrentTime={setCurrentSec}
              />
            </div>
          </div>

          <div className={styles.graphWrapper}>
            <WindowSizeSlider
              value={analysisWindowSec}
              onChange={setAnalysisWindowSec}
            />
            <div className={styles.graphContainer}>
              <CommentAnalysisGraph
                analysis={graphAnalysis}
                windowSec={analysisWindowSec}
                onSeek={handleSeekInternal}
                selectionRange={localRange}
                onSelectionChange={setLocalRange}
                onPeakClick={setSelectedPeak}
              />
              <div className={styles.statusLabel}>
                {analysisState.kind === 'loading' && (
                  <span className={styles.hintText}>{PHASE_LABEL[analysisState.phase]} (モック表示)</span>
                )}
                {analysisState.kind === 'error' && (
                  <span className={styles.hintText}>分析失敗: {analysisState.message} (モック表示)</span>
                )}
                {analysisState.kind === 'no-source' && (
                  <span className={styles.hintText}>ローカル動画 (モック表示)</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {selectedPeak && (
          <PeakDetailPanel
            sample={selectedPeak}
            analysis={graphAnalysis}
            onClose={() => setSelectedPeak(null)}
            onSetRange={handleSetRange}
          />
        )}
      </main>
    </div>
  );
}

