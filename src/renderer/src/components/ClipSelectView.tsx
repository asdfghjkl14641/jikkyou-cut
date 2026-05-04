import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check, Sparkles, X } from 'lucide-react';
import { useEditorStore, MAX_CLIP_SEGMENTS } from '../store/editorStore';
import VideoPlayer from './VideoPlayer';
import EmbeddedVideoPlayer, { type EmbeddedVideoPlayerHandle } from './EmbeddedVideoPlayer';
import CommentAnalysisGraph from './CommentAnalysisGraph';
import WindowSizeSlider from './WindowSizeSlider';
import ClipSegmentsList from './ClipSegmentsList';
import LiveCommentFeed from './LiveCommentFeed';
import SegmentContextMenu from './SegmentContextMenu';
import { generateMockAnalysis } from './CommentAnalysisGraph.mock';
// GeminiAnalysisDialog file kept as residual code — was the test
// button's result modal in Task 1, retired in Task 2 once Gemini got
// integrated into the auto-extract pipeline.
// CreatorPickerDialog import retired with M1.5b — the picker UI was
// part of the per-creator prompt path, replaced by global.json. Kept
// the component file as residual code for a possible future revival.
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

// AnalysisState was retired in stage 6a — comment-analysis lifecycle
// now lives in editorStore.commentAnalysisStatus (CommentAnalysisLoadStatus).
// The 'no-source' case (local file drop, no URL) is derived from
// (filePath && !sourceUrl && status === 'idle') instead of being its
// own kind in the union.

const PHASE_LABEL: Record<CommentAnalysisProgress['phase'], string> = {
  chat: 'チャット取得中…',
  viewers: '視聴者数取得中…',
  scoring: 'スコア計算中…',
};

// Choices for the auto-extract target-count dropdown. 3 is the
// default ("just give me a couple of highlights"); 10 is the soft cap
// — past that, the AI struggles to maintain quality and the user is
// better served clearing existing picks before re-extracting.
const AUTO_EXTRACT_TARGET_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10] as const;

// 5-step progress indicator. The orchestrator emits 6 phases
// (cache-check / audio-extract / gemini / detect / refine / titles),
// but `detect` is sub-millisecond and gets folded into the `refine`
// step for UX. `geminiSkipped` paints the gemini step struck through
// instead of progressing — surfaced when the user has no Gemini key
// or the analysis itself failed mid-flight.
type StepKey = 'cache-check' | 'audio-extract' | 'gemini' | 'refine' | 'titles';

const STEP_ORDER: StepKey[] = ['cache-check', 'audio-extract', 'gemini', 'refine', 'titles'];
const STEP_LABEL: Record<StepKey, string> = {
  'cache-check': '1. キャッシュ確認',
  'audio-extract': '2. 音声抽出',
  'gemini': '3. Gemini 構造理解',
  'refine': '4. AI 絞り込み',
  'titles': '5. タイトル生成',
};

function phaseToStep(phase: AutoExtractProgress['phase']): StepKey {
  if (phase === 'detect') return 'refine';
  return phase as StepKey;
}

function AutoExtractStepIndicator(props: {
  phase: AutoExtractProgress['phase'];
  geminiSkipped: boolean;
}) {
  const currentStep = phaseToStep(props.phase);
  const currentIdx = STEP_ORDER.indexOf(currentStep);
  return (
    <div className={styles.autoExtractStepRow}>
      {STEP_ORDER.map((step) => {
        const myIdx = STEP_ORDER.indexOf(step);
        const skipped = step === 'gemini' && props.geminiSkipped;
        // CSS module access is typed `string | undefined` under
        // strict; allow undefined and let React drop unset className.
        let cls: string | undefined;
        if (skipped) {
          cls = styles.autoExtractStepSkipped ?? styles.autoExtractStepDone;
        } else if (myIdx < currentIdx) {
          cls = styles.autoExtractStepDone;
        } else if (myIdx === currentIdx) {
          cls = styles.autoExtractStepActive;
        } else {
          cls = styles.autoExtractStepPending;
        }
        return (
          <span key={step} className={cls}>
            {skipped ? `⊘ ${STEP_LABEL[step]}(skip)` : STEP_LABEL[step]}
          </span>
        );
      })}
    </div>
  );
}

export default function ClipSelectView() {
  const filePath = useEditorStore((s) => s.filePath);
  // Stage 2 — audio-first DL fills audioFilePath / sessionId BEFORE
  // filePath. The view renders as soon as either is present so AI
  // extract can run before the video DL completes. videoDownloadStatus
  // drives the in-player overlay.
  const audioFilePath = useEditorStore((s) => s.audioFilePath);
  const sessionId = useEditorStore((s) => s.sessionId);
  const videoDownloadStatus = useEditorStore((s) => s.videoDownloadStatus);
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
  // Stage 6a — comment-analysis lifecycle promoted to the store so
  // App.tsx can fire the IPC at URL-input time (parallel with video DL)
  // instead of waiting for this view to mount + run a useEffect.
  const commentAnalysisStatus = useEditorStore((s) => s.commentAnalysisStatus);
  // Re-render log — fires every render so we see when ClipSelectView
  // sees a new status snapshot (or doesn't).
  const _msgCount =
    commentAnalysisStatus.kind === 'ready'
      ? commentAnalysisStatus.analysis.allMessages.length
      : 0;
  console.log(
    `[comment-debug:clip] re-render: status=${commentAnalysisStatus.kind}, messageCount=${_msgCount}, sessionId=${sessionId}, filePath=${filePath ? 'set' : 'null'}, audioFilePath=${audioFilePath ? 'set' : 'null'}, durationSec=${durationSec}`,
  );
  useEffect(() => {
    console.log(
      `[comment-debug:clip] MOUNT: status=${commentAnalysisStatus.kind}, messageCount=${_msgCount}, sessionId=${sessionId}`,
    );
    return () => {
      console.log('[comment-debug:clip] UNMOUNT');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Derive the legacy 'no-source' label for the status pill: only
  // applies when a local file is loaded (filePath set, sourceUrl null,
  // status idle = nothing pending).
  const isLocalNoSource =
    !!filePath && !sourceUrl && commentAnalysisStatus.kind === 'idle';
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
    | {
        kind: 'running';
        phase: AutoExtractProgress['phase'];
        percent: number;
        // Sticky skip indicator. When the orchestrator emits the
        // 'gemini' phase with `skipped: true`, we remember it for the
        // rest of the run so subsequent phase transitions can keep
        // showing the gemini step struck through.
        geminiSkipped: boolean;
      }
    | { kind: 'error'; message: string };
  const [autoState, setAutoState] = useState<AutoExtractState>({ kind: 'idle' });
  const [autoTargetCount, setAutoTargetCount] = useState(3);
  // M1.5a's per-file estimateCreator + picker UI was retired in M1.5b.
  // The AI prompt now uses a single global.json (cross-creator) pattern
  // feed loaded main-side; no renderer state needed.
  // Task 2 — the standalone Gemini test button + progress modal +
  // result dialog were removed once Gemini got merged into the
  // auto-extract pipeline. Gemini's skip-vs-active state is now
  // surfaced via the integrated AutoExtractProgress payload's
  // `skipped` flag, not a separate UI state.

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

  // Stage 6a — comment analysis is fired from App.tsx at URL-input
  // time. ClipSelectView is now read-only on this state, no useEffect
  // trigger needed.

  const graphAnalysis = useMemo<CommentAnalysis>(() => {
    if (commentAnalysisStatus.kind === 'ready') {
      return commentAnalysisStatus.analysis;
    }
    return mockAnalysis;
  }, [commentAnalysisStatus, mockAnalysis]);

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
      aiSource: 'manual',
    });
  }, [addClipSegment]);

  const handleMutateSegment = useCallback(
    (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => {
      updateClipSegment(id, patch);
    },
    [updateClipSegment],
  );

  const videoRef = React.useRef<any>(null);
  const embeddedRef = React.useRef<EmbeddedVideoPlayerHandle>(null);

  // Stage 4 — embed→local swap state.
  // `swappedToLocal` flips once the local VideoPlayer should take
  // over (filePath has arrived AND we've snapshot the embed's current
  // time). The render condition lags filePath by one effect tick so
  // EmbeddedVideoPlayer is still mounted when we read getCurrentTime().
  const [swappedToLocal, setSwappedToLocal] = useState(false);
  const [initialSeekSec, setInitialSeekSec] = useState<number | undefined>(undefined);
  const [shouldAutoPlay, setShouldAutoPlay] = useState(false);
  const [embedPlaying, setEmbedPlaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Reset swap state when the session changes (different URL / fresh
  // local drop). For local drops sessionId is null — the swap state
  // stays in its default and the render path falls straight through
  // to VideoPlayer because the embed branch's `sessionId` test fails.
  useEffect(() => {
    setSwappedToLocal(false);
    setInitialSeekSec(undefined);
    setShouldAutoPlay(false);
    setEmbedPlaying(false);
  }, [sessionId]);

  // Trigger the swap when filePath arrives during an embed-active
  // session. Snapshot getCurrentTime BEFORE flipping `swappedToLocal`
  // — the render that reacts to the flip will unmount the embed.
  useEffect(() => {
    if (!filePath || !sessionId || swappedToLocal) return;
    let captured = 0;
    try {
      captured = embeddedRef.current?.getCurrentTime() ?? 0;
    } catch {
      // ignore — embed may not be ready, fall back to 0
    }
    setInitialSeekSec(captured);
    setShouldAutoPlay(embedPlaying);
    setSwappedToLocal(true);
    setToast('ローカル再生に切替しました');
  }, [filePath, sessionId, swappedToLocal, embedPlaying]);

  // Toast auto-dismiss after 3 s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // The `useLocalPlayer` derivation drives the render:
  //   - filePath + (no embed session OR swap completed) → VideoPlayer
  //   - filePath + embed session + not yet swapped → still EmbeddedVideoPlayer
  //   - no filePath + sessionId → EmbeddedVideoPlayer (audio-first window)
  //   - neither → DL overlay
  const useLocalPlayer = !!filePath && (!sessionId || swappedToLocal);

  const handleSeekInternal = useCallback((sec: number) => {
    // Both refs reflect the active player. Whichever is mounted, the
    // imperative handle's seekTo / play / pause matches the same shape.
    if (videoRef.current?.seekTo) {
      videoRef.current.seekTo(sec);
    } else if (embeddedRef.current) {
      embeddedRef.current.seekTo(sec);
    }
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
  //   - already 10+ segments → ask user to clear first (we don't want
  //     the "extract" action to silently no-op when it can't add).
  //     Threshold matches AUTO_EXTRACT_MAX_TARGET below.
  const autoExtractEnabled =
    hasAnthropicApiKey &&
    commentAnalysisStatus.kind === 'ready' &&
    clipSegments.length < 10;
  const autoExtractDisabledReason = !hasAnthropicApiKey
    ? '設定画面で Anthropic API キーを登録してください'
    : commentAnalysisStatus.kind !== 'ready'
    ? 'コメント分析の完了を待ってから実行してください'
    : clipSegments.length >= 10
    ? '既存の区間が 10 個以上あります。クリアしてから実行してください'
    : undefined;

  const handleAutoExtract = useCallback(async () => {
    // Either filePath OR audioFilePath is enough — Stage 2 lets the
    // user trigger AI extract before the video DL completes.
    if (commentAnalysisStatus.kind !== 'ready' || (!filePath && !audioFilePath)) return;
    if (!hasAnthropicApiKey) {
      setAutoState({ kind: 'error', message: '設定画面で Anthropic API キーを登録してください' });
      return;
    }
    setAutoState({ kind: 'running', phase: 'cache-check', percent: 0, geminiSkipped: false });
    const cleanup = window.api.aiSummary.onAutoExtractProgress((p) => {
      setAutoState((prev) => {
        const wasSkipped = prev.kind === 'running' ? prev.geminiSkipped : false;
        const nowSkipped = wasSkipped || (p.phase === 'gemini' && p.skipped === true);
        return {
          kind: 'running',
          phase: p.phase,
          percent: p.percent,
          geminiSkipped: nowSkipped,
        };
      });
    });
    try {
      const analysis = commentAnalysisStatus.analysis;
      // Cache key prefers sessionId (URL-DL flow, stable across the
      // audio→video transition); falls back to filePath for local
      // drops. audioFilePath / videoFilePath are passed for the
      // orchestrator to choose between fast-path (skip ffmpeg) and
      // legacy extract.
      const result = await window.api.aiSummary.autoExtract({
        videoKey: sessionId ?? filePath ?? audioFilePath ?? 'unknown',
        buckets: analysis.buckets,
        windowSec: analysisWindowSec,
        hasViewerStats: analysis.hasViewerStats,
        videoDurationSec: analysis.videoDurationSec,
        targetCount: autoTargetCount,
        ...(audioFilePath ? { audioFilePath } : {}),
        ...(filePath ? { videoFilePath: filePath } : {}),
      });
      // Apply each segment via the store. Stop early if we hit the
      // hard limit (already-existing segments + new ones could exceed
      // 20 in pathological cases).
      let added = 0;
      for (const seg of result.segments) {
        // Spread so any future ClipSegment field added on the main side
        // (e.g. aiConfidence once Stage 2 returns it) flows through
        // without another renderer change.
        const r = addClipSegment({
          ...seg,
          aiSource: seg.aiSource ?? 'auto-extract',
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
  }, [commentAnalysisStatus, filePath, audioFilePath, sessionId, hasAnthropicApiKey, analysisWindowSec, autoTargetCount, addClipSegment]);

  const handleCancelAutoExtract = useCallback(() => {
    // aiSummary.cancel cancels the Anthropic refine call. The Gemini
    // step inside the orchestrator runs against gemini.cancelAnalysis;
    // we fire both so a mid-extraction cancel is honoured regardless
    // of which phase is in flight.
    void window.api.aiSummary.cancel();
    void window.api.gemini.cancelAnalysis();
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

  // Stage 2 — render as soon as either filePath (local drop / video DL
  // complete) OR audioFilePath (audio-first DL) is available. The
  // VideoPlayer is replaced by an overlay when video is still loading.
  if (!filePath && !audioFilePath) return null;
  const editGateReason = !filePath
    ? '動画ダウンロードが完了するまで編集に進めません'
    : clipSegments.length === 0
    ? '先に区間を選択してください'
    : undefined;

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
              {AUTO_EXTRACT_TARGET_OPTIONS.map((n) => (
                <option key={n} value={n}>{`${n} 個`}</option>
              ))}
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
            disabled={clipSegments.length === 0 || !filePath}
            title={editGateReason}
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
              {useLocalPlayer && filePath ? (
                <VideoPlayer
                  ref={videoRef}
                  filePath={filePath}
                  initialSec={initialSeekSec}
                  shouldAutoPlay={shouldAutoPlay}
                  onDuration={setDuration}
                  onCurrentTime={setCurrentSec}
                />
              ) : sessionId ? (
                // Stage 3 — embedded YouTube/Twitch player while the
                // local video DL is still in flight. Stage 4 swaps to
                // VideoPlayer when filePath arrives + the swap effect
                // has captured the current playback position.
                <>
                  <EmbeddedVideoPlayer
                    ref={embeddedRef}
                    sessionId={sessionId}
                    onTimeUpdate={setCurrentSec}
                    onDuration={setDuration}
                    onPlayStateChange={setEmbedPlaying}
                  />
                  <div className={styles.embedDlBadge}>
                    {videoDownloadStatus.status === 'error' ? (
                      <span title={videoDownloadStatus.error ?? ''}>
                        ⚠ DL 失敗
                      </span>
                    ) : videoDownloadStatus.status === 'done' ? (
                      <span>✓ DL 完了(切替中…)</span>
                    ) : (
                      <span>
                        📥 DL {Math.round(videoDownloadStatus.progress * 100)}%
                      </span>
                    )}
                  </div>
                  <div className={styles.embedHint}>
                    ℹ プレビュー視聴中 — 字幕確認・カット確認は DL 完了後
                  </div>
                </>
              ) : (
                <div className={styles.videoDlOverlay}>
                  <div className={styles.videoDlIcon}>📥</div>
                  <div className={styles.videoDlTitle}>動画ダウンロード中</div>
                  <div className={styles.videoDlBar}>
                    <div
                      className={styles.videoDlBarFill}
                      style={{
                        width: `${Math.round(videoDownloadStatus.progress * 100)}%`,
                      }}
                    />
                  </div>
                  <div className={styles.videoDlPercent}>
                    {Math.round(videoDownloadStatus.progress * 100)}%
                  </div>
                  <div className={styles.videoDlHint}>
                    AI 抽出は今すぐ実行可能(音声は既に取得済み)
                  </div>
                </div>
              )}
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
                {commentAnalysisStatus.kind === 'loading' && (
                  <CommentAnalysisProgressStrip phase={commentAnalysisStatus.phase} />
                )}
                {commentAnalysisStatus.kind === 'error' && (
                  <span className={styles.hintText}>分析失敗: {commentAnalysisStatus.message} (モック表示)</span>
                )}
                {isLocalNoSource && (
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
                  {autoState.phase === 'cache-check' && 'キャッシュ確認中...'}
                  {autoState.phase === 'audio-extract' && '音声抽出中...'}
                  {autoState.phase === 'gemini' &&
                    (autoState.geminiSkipped
                      ? 'Gemini はスキップ(キー未登録 or 失敗)'
                      : 'Gemini 構造理解中...(1-3 分)')}
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
                <AutoExtractStepIndicator
                  phase={autoState.phase}
                  geminiSkipped={autoState.geminiSkipped}
                />
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

      {/* Stage 4 — transient toast for embed→local swap announcement. */}
      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}

// 2026-05-04 — Compact progress strip shown while comment analysis is
// in flight. Maps the discrete `chat → viewers → scoring` phase axis
// to a 3-step percentage so the user sees forward motion (otherwise
// the previous "モック表示" text gave no indication that work was
// actually happening). The strip auto-hides once the status flips
// to 'ready' — the parent's PHASE_LABEL fallback handles 'error'.
function CommentAnalysisProgressStrip({ phase }: { phase: CommentAnalysisProgress['phase'] }) {
  const percent = phase === 'chat' ? 33 : phase === 'viewers' ? 66 : 100;
  return (
    <span
      className={styles.hintText}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-xs)' }}
    >
      <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 38 }}>
        {PHASE_LABEL[phase]}
      </span>
      <span
        style={{
          flex: 1,
          maxWidth: 200,
          minWidth: 80,
          height: 4,
          background: 'var(--border-subtle)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${percent}%`,
            height: '100%',
            background: 'linear-gradient(90deg, var(--accent-primary), #818CF8)',
            transition: 'width 0.3s ease-out',
          }}
        />
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
        {percent}%
      </span>
      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>(モック表示)</span>
    </span>
  );
}
