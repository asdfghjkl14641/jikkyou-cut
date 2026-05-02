import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check, Sparkles, X } from 'lucide-react';
import { useEditorStore, MAX_CLIP_SEGMENTS } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import WindowSizeSlider from './WindowSizeSlider';
import ClipSegmentsList from './ClipSegmentsList';
import LiveCommentFeed from './LiveCommentFeed';
import SegmentContextMenu from './SegmentContextMenu';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
import type {
  CommentAnalysis,
  CommentAnalysisProgress,
  ClipSegment,
  ReactionCategory,
  AiSummarySegment,
  AiSummaryProgress,
  AutoExtractProgress,
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
  // Right-click-on-segment context menu state. Position is viewport-
  // space (clientX/Y), the menu uses position: fixed.
  const [segmentMenu, setSegmentMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Triggers ClipSegmentsList to enter title-edit mode for a specific
  // segment. Cleared by the list once handled.
  const [editTitleRequestId, setEditTitleRequestId] = useState<string | null>(null);

  // AI title generation lifecycle. The list panel reads this and
  // disables its button / shows a progress label accordingly.
  type AiState =
    | { kind: 'idle' }
    | { kind: 'running'; done: number; total: number }
    | { kind: 'error'; message: string };
  const [aiState, setAiState] = useState<AiState>({ kind: 'idle' });
  const [hasAnthropicApiKey, setHasAnthropicApiKey] = useState(false);

  // Auto-extract (1-button "find me clips") lifecycle. Owns its own
  // state separate from the manual-title path so progress dialogs
  // don't fight each other.
  type AutoExtractState =
    | { kind: 'idle' }
    | { kind: 'running'; phase: AutoExtractProgress['phase']; percent: number }
    | { kind: 'error'; message: string };
  const [autoState, setAutoState] = useState<AutoExtractState>({ kind: 'idle' });
  const [autoTargetCount, setAutoTargetCount] = useState(3);

  // Refresh the Anthropic key flag whenever this view mounts (covers the
  // "user opened Settings, saved a key, then came back" path).
  useEffect(() => {
    let alive = true;
    void window.api.hasAnthropicApiKey().then((has) => {
      if (alive) setHasAnthropicApiKey(has);
    });
    return () => { alive = false; };
  }, []);

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

  // Slice the analysis bucket messages by each segment's bounds so the
  // AI gets only the comments that actually fall inside the window.
  // Buckets are time-ordered; we walk once per segment which is cheap
  // even for 20 segments.
  const buildSummarySegments = useCallback((): AiSummarySegment[] => {
    return clipSegments.map((seg) => {
      const messages: AiSummarySegment['messages'] = [];
      for (const b of graphAnalysis.buckets) {
        if (b.timeSec + graphAnalysis.bucketSizeSec <= seg.startSec) continue;
        if (b.timeSec >= seg.endSec) break;
        for (const m of b.messages) {
          if (m.timeSec >= seg.startSec && m.timeSec < seg.endSec) messages.push(m);
        }
      }
      return {
        id: seg.id,
        startSec: seg.startSec,
        endSec: seg.endSec,
        messages,
      };
    });
  }, [clipSegments, graphAnalysis]);

  // 1-button auto-extract flow. Disabled conditions:
  //   - no Anthropic key → button greyed out, tooltip explains
  //   - analysis not ready → can't peak-detect without buckets
  //   - already 5+ segments → ask user to clear first (we don't want
  //     the "extract" action to silently no-op when it can't add)
  const autoExtractEnabled =
    hasAnthropicApiKey &&
    analysisState.kind === 'ready' &&
    clipSegments.length < 5;
  const autoExtractDisabledReason = !hasAnthropicApiKey
    ? '設定画面で Anthropic API キーを登録してください'
    : analysisState.kind !== 'ready'
    ? 'コメント分析の完了を待ってから実行してください'
    : clipSegments.length >= 5
    ? '既存の区間が 5 個以上あります。クリアしてから実行してください'
    : undefined;

  const handleAutoExtract = useCallback(async () => {
    if (analysisState.kind !== 'ready' || !filePath) return;
    if (!hasAnthropicApiKey) {
      setAutoState({ kind: 'error', message: '設定画面で Anthropic API キーを登録してください' });
      return;
    }
    setAutoState({ kind: 'running', phase: 'detect', percent: 0 });
    const cleanup = window.api.aiSummary.onAutoExtractProgress((p) => {
      setAutoState({ kind: 'running', phase: p.phase, percent: p.percent });
    });
    try {
      const analysis = analysisState.analysis;
      const result = await window.api.aiSummary.autoExtract({
        videoKey: filePath,
        buckets: analysis.buckets,
        windowSec: analysisWindowSec,
        hasViewerStats: analysis.hasViewerStats,
        videoDurationSec: analysis.videoDurationSec,
        targetCount: autoTargetCount,
      });
      // Apply each segment via the store. Stop early if we hit the
      // hard limit (already-existing segments + new ones could exceed
      // 20 in pathological cases).
      let added = 0;
      for (const seg of result.segments) {
        const r = addClipSegment({
          startSec: seg.startSec,
          endSec: seg.endSec,
          title: seg.title,
          dominantCategory: seg.dominantCategory,
        });
        if (r.ok) added += 1;
      }
      setAutoState({ kind: 'idle' });
      if (result.warning) {
        // Surface the warning on the manual-title aiState slot — it
        // shares a styling with the existing "AI 失敗" banner so it
        // appears in the segments list area where the user is looking.
        setAiState({ kind: 'error', message: result.warning });
      }
      if (added === 0) {
        setAutoState({ kind: 'error', message: '抽出結果なし(候補が見つかりませんでした)' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAutoState({ kind: 'error', message: msg });
    } finally {
      cleanup();
    }
  }, [analysisState, filePath, hasAnthropicApiKey, analysisWindowSec, autoTargetCount, addClipSegment]);

  const handleCancelAutoExtract = useCallback(() => {
    void window.api.aiSummary.cancel();
    setAutoState({ kind: 'idle' });
  }, []);

  const handleGenerateAiTitles = useCallback(async () => {
    if (clipSegments.length === 0) return;
    if (!hasAnthropicApiKey) {
      setAiState({ kind: 'error', message: '設定画面で Anthropic API キーを登録してください' });
      return;
    }
    const segs = buildSummarySegments();
    setAiState({ kind: 'running', done: 0, total: segs.length });
    const cleanup = window.api.aiSummary.onProgress((p: AiSummaryProgress) => {
      setAiState({ kind: 'running', done: p.done, total: p.total });
    });
    try {
      // videoKey: use the file path so the on-disk cache shards per
      // video. filePath was checked non-null at the top of this
      // component (early return), so it's safe to assume here.
      const videoKey = filePath ?? 'unknown';
      const results = await window.api.aiSummary.generate({ videoKey, segments: segs });
      // Apply each successful title back to the store. Errors stay on
      // the result entry but we don't surface per-segment errors in
      // the UI yet (a single global error message is sufficient for
      // the prototype).
      let firstError: string | null = null;
      for (const r of results) {
        if (r.title) {
          updateClipSegment(r.segmentId, { title: r.title });
        } else if (!firstError && r.error && r.error !== 'cancelled') {
          firstError = r.error;
        }
      }
      if (firstError) {
        setAiState({ kind: 'error', message: firstError });
      } else {
        setAiState({ kind: 'idle' });
      }
    } catch (err) {
      setAiState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      cleanup();
    }
  }, [clipSegments.length, hasAnthropicApiKey, buildSummarySegments, filePath, updateClipSegment]);

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
          <div className={styles.autoExtractGroup} title={autoExtractDisabledReason}>
            <select
              className={styles.autoExtractCount}
              value={autoTargetCount}
              onChange={(e) => setAutoTargetCount(Number(e.target.value))}
              disabled={!autoExtractEnabled || autoState.kind === 'running'}
              aria-label="抽出する区間数"
            >
              <option value={3}>3 個</option>
              <option value={4}>4 個</option>
              <option value={5}>5 個</option>
            </select>
            <button
              type="button"
              className={styles.autoExtractButton}
              onClick={handleAutoExtract}
              disabled={!autoExtractEnabled || autoState.kind === 'running'}
            >
              <Sparkles size={14} />
              自動で切り抜き候補を抽出
            </button>
          </div>
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
                onSelectSegment={setSelectedSegmentId}
                selectedSegmentId={selectedSegmentId}
                onSegmentContextMenu={(id, x, y) => {
                  setSelectedSegmentId(id);
                  setSegmentMenu({ id, x, y });
                }}
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
              editTitleRequestId={editTitleRequestId}
              onEditTitleRequestHandled={() => setEditTitleRequestId(null)}
              onSelectSegment={setSelectedSegmentId}
              onUpdateSegment={updateClipSegment}
              onRemoveSegment={(id) => { removeClipSegment(id); setSelectedSegmentId(null); }}
              onUpdateEyecatch={updateEyecatch}
              onClearAll={clearAllSegments}
              onReorder={reorderClipSegments}
              hasAnthropicApiKey={hasAnthropicApiKey}
              aiGenerationState={aiState}
              onGenerateAiTitles={handleGenerateAiTitles}
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

      {segmentMenu && (
        <SegmentContextMenu
          x={segmentMenu.x}
          y={segmentMenu.y}
          onDelete={() => {
            removeClipSegment(segmentMenu.id);
            setSelectedSegmentId(null);
            setSegmentMenu(null);
          }}
          onEditTitle={() => {
            setEditTitleRequestId(segmentMenu.id);
            setSegmentMenu(null);
          }}
          onClose={() => setSegmentMenu(null)}
        />
      )}

      {(autoState.kind === 'running' || autoState.kind === 'error') && (
        <div className={styles.autoExtractOverlay}>
          <div className={styles.autoExtractDialog}>
            {autoState.kind === 'running' ? (
              <>
                <div className={styles.autoExtractTitle}>
                  <Sparkles size={16} />
                  <span>切り抜き候補を抽出中...</span>
                </div>
                <div className={styles.autoExtractPhase}>
                  {autoState.phase === 'detect' && 'ピーク検出中...'}
                  {autoState.phase === 'refine' && 'AI が候補を精査中...'}
                  {autoState.phase === 'titles' && 'タイトル生成中...'}
                </div>
                <div className={styles.autoExtractBar}>
                  <div
                    className={styles.autoExtractBarFill}
                    style={{ width: `${autoState.percent}%` }}
                  />
                </div>
                <div className={styles.autoExtractStepRow}>
                  <span className={autoState.phase === 'detect' ? styles.autoExtractStepActive : styles.autoExtractStepDone}>
                    1. 検出
                  </span>
                  <span className={
                    autoState.phase === 'refine' ? styles.autoExtractStepActive
                    : autoState.phase === 'titles' ? styles.autoExtractStepDone
                    : styles.autoExtractStepPending
                  }>
                    2. 精査
                  </span>
                  <span className={autoState.phase === 'titles' ? styles.autoExtractStepActive : styles.autoExtractStepPending}>
                    3. タイトル
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.autoExtractCancel}
                  onClick={handleCancelAutoExtract}
                >
                  キャンセル
                </button>
              </>
            ) : (
              <>
                <div className={styles.autoExtractTitle}>
                  <span>抽出に失敗しました</span>
                </div>
                <div className={styles.autoExtractError}>
                  {autoState.message}
                </div>
                <button
                  type="button"
                  className={styles.autoExtractCancel}
                  onClick={() => setAutoState({ kind: 'idle' })}
                >
                  <X size={14} />
                  閉じる
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
