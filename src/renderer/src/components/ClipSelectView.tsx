import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check } from 'lucide-react';
import { useEditorStore, MAX_CLIP_SEGMENTS } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import WindowSizeSlider from './WindowSizeSlider';
import ClipSegmentsList from './ClipSegmentsList';
import LiveCommentFeed from './LiveCommentFeed';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
import type {
  CommentAnalysis,
  CommentAnalysisProgress,
  ClipSegment,
  ReactionCategory,
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
  const currentSec = useEditorStore((s) => s.currentSec);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setCurrentSec = useEditorStore((s) => s.setCurrentSec);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setPhase = useEditorStore((s) => s.setPhase);
  const analysisWindowSec = useEditorStore((s) => s.analysisWindowSec);
  const setAnalysisWindowSec = useEditorStore((s) => s.setAnalysisWindowSec);

  const clipSegments = useEditorStore((s) => s.clipSegments);
  const eyecatches = useEditorStore((s) => s.eyecatches);
  const addClipSegment = useEditorStore((s) => s.addClipSegment);
  const removeClipSegment = useEditorStore((s) => s.removeClipSegment);
  const updateClipSegment = useEditorStore((s) => s.updateClipSegment);
  const reorderClipSegments = useEditorStore((s) => s.reorderClipSegments);
  const clearAllSegments = useEditorStore((s) => s.clearAllSegments);
  const updateEyecatch = useEditorStore((s) => s.updateEyecatch);

  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
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
    if (clipSegments.length >= 1) {
      setPhase('edit');
    }
  }, [clipSegments.length, setPhase]);

  const handleAddFromDrag = useCallback((args: {
    startSec: number;
    endSec: number;
    dominantCategory: ReactionCategory | null;
  }) => {
    return addClipSegment({
      startSec: args.startSec,
      endSec: args.endSec,
      title: null,
      dominantCategory: args.dominantCategory,
    });
  }, [addClipSegment]);

  const handleMutateSegment = useCallback(
    (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => {
      updateClipSegment(id, patch);
    },
    [updateClipSegment],
  );

  const videoRef = React.useRef<any>(null);

  const handleSeekInternal = useCallback((sec: number) => {
    videoRef.current?.seekTo(sec);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        if (selectedSegmentId) {
          setSelectedSegmentId(null);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSegmentId) {
        removeClipSegment(selectedSegmentId);
        setSelectedSegmentId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSegmentId, removeClipSegment]);

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
          <button
            type="button"
            className={styles.editButton}
            onClick={handleEdit}
            disabled={clipSegments.length === 0}
            title={clipSegments.length === 0 ? '先に区間を選択してください' : undefined}
          >
            <Check size={18} />
            この区間を編集 ({clipSegments.length})
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
                segments={clipSegments}
                onSeek={handleSeekInternal}
                onAddSegmentRequested={handleAddFromDrag}
                onMutateSegment={handleMutateSegment}
                onRemoveSegment={(id) => { removeClipSegment(id); setSelectedSegmentId(null); }}
                onSelectSegment={setSelectedSegmentId}
                selectedSegmentId={selectedSegmentId}
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

          <div className={styles.segmentsListWrapper}>
            <ClipSegmentsList
              segments={clipSegments}
              eyecatches={eyecatches}
              maxSegments={MAX_CLIP_SEGMENTS}
              selectedSegmentId={selectedSegmentId}
              onSelectSegment={setSelectedSegmentId}
              onUpdateSegment={updateClipSegment}
              onRemoveSegment={(id) => { removeClipSegment(id); setSelectedSegmentId(null); }}
              onUpdateEyecatch={updateEyecatch}
              onClearAll={clearAllSegments}
              onReorder={reorderClipSegments}
            />
          </div>
        </div>

        <aside className={styles.sidePanel}>
          <LiveCommentFeed
            messages={graphAnalysis.allMessages}
            currentSec={currentSec}
            onCommentClick={handleSeekInternal}
          />
        </aside>
      </main>
    </div>
  );
}
