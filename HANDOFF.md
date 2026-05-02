# jikkyou-cut HANDOFF — 引き継ぎドキュメント

> 想定読み手: 次セッションでこのリポジトリを触る担当(Claude Code / Antigravity / 人間)。
> プロジェクト全体像・現在の機能セット・主要型 / IPC・データフロー・運用注意・改修の方向性を 1 ファイルにまとめる。

---

## 1. プロジェクト概要

### jikkyou-cut とは

ゲーム実況・配信切り抜きに特化した、**完全無料・オープンソース**の動画編集ツール。
Electron + React + TypeScript 製。**現在は配布前の "自分用ツール" 段階** — まずは作者のワークフローに最適化、配布バイナリ化や配布サイズの懸念は脇に置く方針。

中核アイデアは「**テキストを消すと動画もカットされる**」というテキストベース編集パラダイム(Vrew 流)。長時間配信のアーカイブを **Gladia API** で文字起こしし、不要な発話キューを行単位で削除すると、対応する動画区間が削除セグメントとしてマークされる。最終的に FFmpeg で連結 + 字幕焼き込みで書き出す。

### ターゲットユーザ

- ゲーム実況を YouTube に投稿する人
- 長時間配信(数時間級)アーカイブを切り抜きたい VTuber / ストリーマー
- ソロ実況・コラボ実況の両方に対応(コラボでは話者分離 + 話者ごとの字幕スタイル)

### 既存ツールとの差別化

| 既存 | 課題 | jikkyou-cut |
|---|---|---|
| Vrew | 汎用 + 従量課金 + 長尺動画でコスト爆発 | 実況特化 + BYOK で無制限 |
| LosslessCut | テキスト編集なし、AI 機能なし | テキスト編集 + Gladia 文字起こし + 字幕焼き込み |
| DaVinci / Premiere | プロ向け、習得コスト高 | 切り抜き作業に特化、低学習コスト |

### 現在の達成状況(2026-05-01 時点)

- **MVP 完成**(タグ `v0.1.0-mvp` = commit `abb589a`)
- **字幕機能 Phase A**(基盤 + UI + 焼き込み): 完了
- **字幕機能 Phase B-1**(コラボ ON/OFF + 話者数指定): 完了
- **字幕機能 Phase B-2**(話者ID 手動修正 UI + DnD): 完了
- **字幕機能 Phase B-3**(話者プリセット + キュー単位スタイル上書き): 完了
- **URL 動画 DL**(yt-dlp 統合、YouTube + Twitch): 完了
- **DropZone への URL 入力統合**: 完了
- **3 フェーズ構造への再編**: 完了 (Load -> Clip Select -> Edit)
- **コメント分析グラフ(UI MVP)**: 完了 (モックデータ表示 + ドラッグ選択)
- **コメント分析 rolling window スコア + W スライダー**: 完了 (5 要素 / 30 秒〜5 分可変 / Stage 1+2 分離)
- **複数区間選択 + 感情 9 カテゴリ + アイキャッチ枠**: 完了 (clipSegments[] 最大 20 / 区間バー drag / ClipSegmentsList / eyecatches 自動同期。AI タイトル生成とアイキャッチ実体動画化は次タスク)
- **操作系整理 + ライブコメントビュー**: 完了 (波形は左=シーク・右ドラッグ=区間追加、PeakDetailPanel 廃止、LiveCommentFeed 常駐)
- **操作感改善 + 区間バー右クリックメニュー**: 完了 (左クリック即時シーク + ホバー圧縮 + コメント行コンパクト化 + SegmentContextMenu)
- **AI タイトル要約**: 完了 (Anthropic BYOK、Claude Haiku 4.5、3 並列 + キャッシュ、Settings UI と ClipSegmentsList ボタン)
- **切り抜き候補の自動抽出**: 完了 (アルゴリズム peak 検出 + AI 精査 + タイトル生成を 1 ボタンで一気通貫、ClipSelectView ヘッダの ✨ ボタン)
- **データ収集パイプライン Phase 1**: 完了 (better-sqlite3 + YouTube Data API + yt-dlp で切り抜き動画蓄積、Settings UI、1 時間ごとバックグラウンド収集)
- **「API 管理」専用画面**: 完了 (メニューバー直配置 + Ctrl+Shift+A、Gladia/Anthropic/YouTube 統合、CollectionLogViewer で収集ログ GUI 表示)— モーダル → 全画面フェーズ swap に変更(`phase: 'api-management'`)

### 次フェーズ
- **進行中**: コメント分析画面 (バックエンド実装待ち) — 詳細は `docs/COMMENT_ANALYSIS_DESIGN.md`
- 長期構想は `IDEAS.md` 参照(AI動画ディレクター方向)

---

## 2. 技術スタック

| 項目 | 採用 |
|---|---|
| ランタイム | Electron 33 |
| ビルドツール | electron-vite 2(内部で Vite 5) |
| UI | React 18 + TypeScript 5(strict + noUncheckedIndexedAccess) |
| 状態管理 | **zustand 5**(Redux/Recoil 等は不採用) |
| スタイル | **CSS Modules 専用**(Tailwind/Radix/shadcn 不採用) |
| アイコン | **lucide-react**(絵文字は廃止済み) |
| 動画処理 | システム導入済み **FFmpeg 8.1** を `execa` で呼び出す |
| 文字起こし | **Gladia v2 API**(BYOK)。`/v2/upload` + `/v2/pre-recorded` + ポーリング |
| 動画ダウンロード | **yt-dlp**(同梱、`resources/yt-dlp/` 配下) |
| APIキー保存 | Electron `safeStorage`(Windows: DPAPI で暗号化) |
| プロジェクト保存 | `<basename>.jcut.json` を動画と同階層に自動書き出し(debounce 1 秒) |
| 字幕レンダリング | ASS フォーマット → FFmpeg `subtitles` フィルタで焼き込み(libass) |
| パッケージマネージャ | npm |

---

## 3. ディレクトリ構成

```
jikkyou-cut/
├── electron.vite.config.ts    # ビルド設定
├── tsconfig.{json,common,main,web,node}.json
├── package.json
├── README.md
├── CLAUDE.md                  # 開発方針 (Claude 向け)
├── HANDOFF.md                 # この文書
├── DECISIONS.md               # 直近の意思決定ログ
├── TODO.md                    # 残タスク
├── IDEAS.md                   # 将来構想
├── docs/
│   └── COMMENT_ANALYSIS_DESIGN.md   # コメント分析画面 MVP 設計
├── resources/
│   └── yt-dlp/                # 同梱 yt-dlp バイナリ
├── LICENSE                    # GPL-2.0-or-later
└── src/
    ├── common/                # main↔renderer 共有コード
    │   ├── config.ts          # AppConfig 型 + DEFAULT_CONFIG
    │   ├── segments.ts        # deriveKeptRegions / decidePreviewSkip / findCueIndexForCurrent
    │   ├── speakers.ts        # defaultSpeakerName 等の話者ヘルパ
    │   ├── srt.ts             # parseSrt 純関数
    │   ├── subtitle.ts        # buildAss / convertTimecode / hexToAss / formatAssTime
    │   ├── subtitleResolution.ts  # cue → 適用スタイル決定の優先順位ロジック
    │   ├── transcriptionContext.ts # buildCustomVocabulary 純関数
    │   └── types.ts           # TranscriptCue / SpeakerStyle / SpeakerPreset / IpcApi 等
    ├── main/                  # Electron メインプロセス
    │   ├── index.ts           # エントリ + IPC ハンドラ登録
    │   ├── audioExtraction.ts # 動画→MP3 抽出(Gladia 用)
    │   ├── config.ts          # config.json load/save
    │   ├── export.ts          # FFmpeg trim+concat + 字幕焼き込み
    │   ├── fileDialog.ts      # ファイル / ディレクトリ選択ダイアログ
    │   ├── fonts.ts           # Google Fonts カタログ + DL + 一覧 + 削除
    │   ├── gladia.ts          # Gladia v2 API クライアント
    │   ├── mediaProtocol.ts   # media:// プロトコル(Range 対応)
    │   ├── menu.ts            # アプリメニュー
    │   ├── progress.ts        # FFmpeg -progress パーサ
    │   ├── project.ts         # <basename>.jcut.json load/save/clear
    │   ├── secureStorage.ts   # safeStorage で APIキー暗号化保存
    │   ├── subtitleSettings.ts # subtitle-settings.json load/save
    │   ├── urlDownload.ts     # yt-dlp 呼び出し(URL DL)
    │   ├── aiSummary.ts       # Anthropic Claude Haiku で区間タイトル生成 + 1-ボタン自動抽出
    │   ├── commentAnalysis/   # コメント分析オーケストレータ + 実装(peakDetection.ts も含む)
    │   └── dataCollection/    # 切り抜き動画データ収集 Phase 1(SQLite + YouTube API + yt-dlp)
    │       ├── index.ts       # DataCollectionManager(バックグラウンド 1 時間ループ)
    │       ├── database.ts    # better-sqlite3 ラッパ + スキーマ + upsert + per-key クォータ + creator_group migration
    │       ├── youtubeApi.ts  # search.list / videos.list / channels.list + キーローテーション + クォータ管理
    │       ├── ytDlpExtractor.ts # heatmap + chapters + サムネ + 上位 3 ピーク抽出
    │       ├── searchQueries.ts  # ブロード検索クエリ + per-creator 多角化クエリ(切り抜き / 神回 / 名場面)
    │       ├── seedCreators.ts # 配信者 40 人 seed + seedCreatorsIfEmpty + resolveCreatorChannelIds
    │       ├── creatorList.ts # userData/data-collection/creators.json の CRUD(group フィールド対応)
    │       ├── logger.ts      # ISO 8601 [LEVEL] message 形式の append + console echo
    │       └── logReader.ts   # collection.log の末尾 N 行読み出し + パース
    │       ├── index.ts       # analyze({chat→viewers→scoring})オーケストレータ
    │       ├── chatReplay.ts  # yt-dlp で live_chat / rechat を取得 + パース
    │       ├── viewerStats.ts # playboard.co スクレイピング(ヒューリスティック)
    │       └── scoring.ts     # 5 秒バケット + 3 要素重み付き統合スコア
    ├── preload/
    │   └── index.ts           # contextBridge で window.api を expose
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx       # React エントリ
            ├── App.tsx        # 全体レイアウト + IPC wire
            ├── App.module.css
            ├── styles.css     # html/body リセット + CSS 変数(色/space/font)
            ├── store/
            │   └── editorStore.ts   # zustand 全アプリ状態
            ├── hooks/
            │   ├── useEditKeyboard.ts     # キーボードショートカット
            │   ├── useExport.ts
            │   ├── useProjectAutoSave.ts
            │   ├── useSettings.ts
            │   └── useTranscription.ts
            └── components/
                ├── ClipSelectView.tsx          # フェーズ2: 切り抜き範囲選択画面(2-column 配置)
                ├── CommentAnalysisGraph.tsx    # 盛り上がりグラフ(左クリック=シーク、右ドラッグ=区間追加)
                ├── LiveCommentFeed.tsx         # フェーズ2 右パネル: 常駐ライブコメント(独自仮想スクロール、ROW_HEIGHT 40)
                ├── ClipSegmentsList.tsx        # フェーズ2: 切り抜き区間カード一覧 + アイキャッチ行 + AI タイトル生成ボタン
                ├── SegmentContextMenu.tsx      # フェーズ2: 区間バー右クリックメニュー(削除 / タイトル編集)
                ├── WindowSizeSlider.tsx        # フェーズ2: rolling window 幅(W)スライダー
                ├── DropZone.tsx                # フェーズ1: ファイル DnD + URL 入力
                ├── EditableTranscriptList.tsx  # フェーズ3: キュー一覧(リニア表示)
                ├── SpeakerColumnView.tsx       # フェーズ3: 話者カラム表示モード
                ├── VideoPlayer.tsx             # 動画プレイヤ
                ├── SubtitleOverlay.tsx         # 字幕プレビュー
                └── ... (その他ダイアログ等)
```

---

## 4. 状態管理 (zustand `editorStore`)

### State 抜粋
```ts
type EditorState = {
  // フェーズ。'api-management' は API 管理画面の全画面 swap モード。
  phase: 'load' | 'clip-select' | 'edit' | 'api-management';
  // API 管理画面に入った時の元 phase(戻り先)。Esc / 戻るボタンで
  // ここへ復帰。null = 'api-management' 中ではない。
  previousPhase: 'load' | 'clip-select' | 'edit' | null;

  // 切り抜き区間群(旧 clipRange の置き換え)。最大 20 個。setFile /
  // clearFile / clearAllSegments で空に戻る。順序は addClipSegment で
  // startSec 昇順に維持される(reorder で手動入替も可能)
  clipSegments: ClipSegment[];
  // 区間と区間の間の divider。length は常に max(0, clipSegments.length - 1)
  // で自動同期。各 Eyecatch には text(「場面 N」初期値)、durationSec、
  // skip(直結フラグ)を持つ
  eyecatches: Eyecatch[];

  // ファイル
  filePath: string | null;
  fileName: string | null;
  durationSec: number | null;
  currentSec: number;

  // 文字起こし結果
  cues: TranscriptCue[];

  // コメント分析グラフの rolling window 幅(秒)。30..300 の 30 秒
  // ステップ。`WindowSizeSlider` から書き、`CommentAnalysisGraph` が
  // 読んで `computeRollingScores` を再計算する。setFile / clearFile で
  // 初期値 120 にリセット。永続化はせず(プロトタイプ範囲)
  analysisWindowSec: number;
  // ...
};
```

---

## 5. IPC 通信

**メインプロセスが唯一の真実源**。preload で `window.api` として expose される。
主要な名前空間: `fonts`, `subtitleSettings`, `urlDownload`, `commentAnalysis`, `loadProject`, `saveProject`, `startTranscription`, `startExport` 等。
- `commentAnalysis.{start, cancel, onProgress}` — `videoFilePath` + `sourceUrl`(URL DL 由来)+ `durationSec` を渡すと、yt-dlp チャット取得 → playboard 視聴者数取得 → 5 秒バケット集計(Stage 1)を順次実行して `CommentAnalysis` を返す(`buckets[]` を含む)。実際のスコア(`ScoreSample[]`)は renderer で `src/renderer/src/lib/rollingScore.ts` の `computeRollingScores` が W スライダーの値で都度計算する Stage 2。`onProgress` は phase=chat/viewers/scoring の 3 段階で発火。失敗時は graceful degradation(チャット 0 件 / 視聴者数なしモードで重み切替)。
- `hasAnthropicApiKey` / `setAnthropicApiKey` / `clearAnthropicApiKey` / `validateAnthropicApiKey` — Gladia キーと並列の BYOK スロット。`safeStorage`(Windows DPAPI)で `userData/anthropicKey.bin` に暗号化保存。検証は Anthropic API への 1-token ping で実施
- `aiSummary.{generate, cancel, onProgress}` — `clipSegments[]` の各区間に対して Claude Haiku 4.5 でタイトル生成。3 並列 + 429/5xx で指数バックオフ + per-request 30 秒タイムアウト。結果は `userData/comment-analysis/<videoKey>-summaries.json` にキャッシュ(キー = `${start}-${end}-${msgCount}` で 2 桁丸め)。`onProgress` は `done/total` を発火、UI は ClipSegmentsList の進捗ラベルで表示
- `aiSummary.{autoExtract, onAutoExtractProgress}` — 1 ボタン全自動。`{videoKey, buckets, windowSec, hasViewerStats, videoDurationSec, targetCount}` を渡すと、Stage 1(`peakDetection.ts` のアルゴリズム)→ Stage 2(Claude Haiku 4.5 で 10 → N に refine、JSON 出力)→ Stage 4(`generateSegmentTitles` 再利用)を順次実行。Stage 2 結果は `userData/comment-analysis/<videoKey>-extractions.json` にキャッシュ。失敗時はスコア順フォールバック + warning。進捗は `{phase: 'detect'|'refine'|'titles', percent}` で 3 段階発火
- `youtubeApiKeys.{hasKeys, getKeyCount, setKeys, clear}` — YouTube Data API キー BYOK(複数、**最大 50 個**)。`userData/youtubeApiKeys.bin` に DPAPI 暗号化保存。**renderer には件数だけ返し、生キーは戻さない**(Gladia / Anthropic と同パターン)。secureStorage 側に 100KB の defensive cap + Set による dedupe + diagnostic log(件数 / JSON 長 / 書き込みバイト数)あり
- `creators.{list, add, remove}` — 配信者ターゲットリスト。`userData/data-collection/creators.json` の JSON CRUD。Settings UI から編集 + 手動編集どちらも可能
- `dataCollection.{getStats, triggerNow, pause, resume, isEnabled, setEnabled}` — Phase 1 蓄積パイプラインのコントロール。`getStats` は `{videoCount, creatorCount, quotaUsedToday, isRunning, isPaused, isEnabled, lastCollectedAt}` を返す(`isRunning`/`isPaused` は mutually exclusive、両方 false で idle)。`isEnabled` は `AppConfig.dataCollectionEnabled` を反映する**永続マスタースイッチ**(再起動を跨ぐ、デフォルト `false`)。`app.whenReady()` の自動開始は `isEnabled === true` の時だけ。`setEnabled(true)` は config 保存 + `start()`、`setEnabled(false)` は config 保存 + `pause()`(進行中バッチ即停止)
- `collectionLog.{read, openInExplorer, getQuotaPerKey}` — 収集ログビューア用。`read(limit)` で末尾 N 行(デフォルト 5000)を `LogEntry[]`(`{timestamp, level, message}`)で返す。`openInExplorer` は `shell.openPath` で OS デフォルトエディタ。`getQuotaPerKey` は per-key の今日の消費量を返す(API 管理画面のキー別バー用)

---

## 6. データフロー

1. **Load**: `DropZone` でファイルを取得。`editorStore.setFile` が呼ばれ `phase` が `clip-select` へ遷移。
2. **Select**: `ClipSelectView` で `CommentAnalysisGraph` を見ながら範囲選択。`setClipRange` し、`phase` が `edit` へ遷移。
3. **Edit**: `EditableTranscriptList` でテキスト編集。`clipRange` に基づいた文字起こしや書き出しを行う。
4. **Export**: `startExport` で FFmpeg を叩き、カット連結 + 字幕焼き込みを行う。

---

## 7. UI レイアウト (3フェーズ構成)

アプリは以下の 3 フェーズで進行する：

### Phase 1: 動画読み込み (`load`)
```
┌────────────────────────────────────────────────┐
│           [動画ファイルをドロップ]             │
│                    または                      │
│           [YouTube / Twitch URL 入力]          │
└────────────────────────────────────────────────┘
```

### Phase 2: 切り抜き選択 (`clip-select`)
```
┌─────────────────────────────────────────────────────────────────────┐
│ [戻る]    [3個▼ ✨自動抽出]   [全削除][この区間を編集 (N)]         │
├───────────────────────────────────────────────┬─────────────────────┤
│                                               │                     │
│                Video Preview                  │  LiveCommentFeed    │
│                                               │  (常駐、再生位置追従) │
├───────────────────────────────────────────────┤                     │
│  [ウィンドウ:2分 ━━●━━━━]  ピーク検出粒度       │                     │
│   [ ~~~~~~~~~~~~ SVG Waveform ~~~~~~~~~~~~ ]  │                     │
│   (左クリック=シーク、右ドラッグ=区間追加)        │                     │
├───────────────────────────────────────────────┤                     │
│  [ClipSegmentsList: 区間カード一覧 + アイキャッチ]│                     │
└───────────────────────────────────────────────┴─────────────────────┘
```
- 波形の上に rolling window 幅スライダー(`WindowSizeSlider`)。30 秒〜5 分(30 秒ステップ、初期 2 分)で連続可変、波形は変更に追従して都度再描画される(renderer 内 `computeRollingScores`、IPC 往復なし)。
- ヘッダの「✨ 自動抽出」ボタン:1 クリックで Stage 1+2+4 を一気通貫実行、3-step 進捗 modal で経過表示。件数 select(3/4/5)で出力区間数指定。

### Phase 3: 編集 (`edit`)
```
┌─────────────────┬──────────────────────────────┐
│ [← 範囲選び直し] │ [文字起こし] [字幕設定] [⚙]  │
├─────────────────┼──────────────────────────────┤
│  Video Preview  │  Editable Transcript List    │
│  + Subtitles    │  (Linear / Speaker Column)   │
├─────────────────┤                              │
│  Timeline       │                              │
│  ExportPreview  │                              │
└─────────────────┴──────────────────────────────┘
```

---

## 8. キーボードショートカット (編集画面)

- `Space`: 再生/停止
- `D`: キュー削除/復活
- `Ctrl + Z / Y`: Undo / Redo
- `↑ / ↓`: キュー移動
- `Ctrl + Shift + O`: 操作一覧表示

---

## 9. 運用上の注意

- **yt-dlp**: `resources/yt-dlp/` にバイナリを同梱。`getYtDlpPath()` で dev / packaged を分岐。
- **URL DL の選択フォーマット**: `<video>` 互換のため **H.264+AAC(MP4 コンテナ)を強制取得** する(`buildFormatSelector`)。5 段フォールバック `avc1+m4a / avc1+anything / anything+anything / mp4-single / anything-single` で常に MP4 コンテナに落とし、`--merge-output-format mp4` でコンテナ固定。**merger 経路では `--postprocessor-args 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart'` で音声を必ず AAC 192 kbps に再エンコ + moov atom を頭に**(2026-05-02 20:30 修正、Opus-in-MP4 で `<video>` が音声 silent drop する不具合の根本対策)。4K AV1 や 1440p VP9-mkv は犠牲(最大 1080p AVC1)、**Chromium `<video>` のネイティブ再生互換性を優先**。新しい URL DL のみ修正対象 — **旧形式で DL 済みファイルは音声出ない可能性、再 DL 必須**。
- **URL DL の音声フォーマット強制**: `--postprocessor-args 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart'` は merger PP 経由でのみ走る。`best[ext=mp4]` 単体ファイル fallback では postprocessor が走らない経路もあるが、その場合は元ファイルが既に MP4 なのでそのまま使える。診断は `[url-download] yt-dlp resolved formats: JCUT_FMT vfmt=... acodec=...` 行で確認、`acodec=none` なら format selector が video-only に落ちた事故。
- **URL DL の audio fragment 損失対策**(2026-05-02 21:30 修正): yt-dlp デフォルトの `--skip-unavailable-fragments` は失敗 fragment を silent skip するため、partial audio が merger に渡って **動画長 ≠ 音声長 の壊れた MP4** が出来る不具合が報告された。`--abort-on-unavailable-fragment` + `--retries 30 --fragment-retries 30` で fragment 失敗時は hard error 化、加えて **post-DL ffprobe validation** で video/audio duration ±5 秒以上ずれてたら renderer に明示エラーを投げる。ffprobe 自体が失敗した場合は warning 出して DL 成功扱い(belt-and-braces で過剰に reject しない)
- **URL DL の進捗パース**: yt-dlp デフォルト出力は `Unknown%` / merge 中ドロップで不安定なので、`--progress-template "download:JCUT_PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s"` で固定フォーマット化。renderer 側の進捗ダイアログに 250ms throttle で送る。
- **yt-dlp の `--print` + `--progress` は必ずセット**: `--print` を渡すと yt-dlp は暗黙に quiet モードに入り、進捗を含む全デフォルト出力を抑制する。`--progress-template` だけでは「テンプレートを使う」設定にしかならず、出力自体は復活しない。`--progress` フラグ(`Show progress bar, even if in quiet mode`)を **必ずセットで指定** する。`src/main/urlDownload.ts` の spawn args にコメント警告残置。
- **URL DL は video + audio の 2 パス DL**: `bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]` の指定で video ストリームと audio ストリームを別々に DL してから `--merge-output-format mp4` で結合する。renderer の進捗バーは 0→100, 0→100 と 2 度上がる動作になる(自分用ツール段階としては許容、merger フェーズ「結合中…」表示は将来検討)。
- **Google Fonts**: Google Fonts API から TTF を動的に取得し `userData/fonts` に保存。
- **プロジェクト保存**: 動画と同じ階層に `<basename>.jcut.json` として自動保存。
- **Gladia API**: 文字起こしに使用。APIキーは `safeStorage` で保存。
- **データ収集はデフォルト無効** (2026-05-03 06:30): `AppConfig.dataCollectionEnabled` が永続マスタースイッチで、デフォルト `false`。アプリ起動時の自動開始はこの flag が `true` の時のみ。ユーザが「API 管理 / 切り抜きデータ収集 → 有効化する」を明示的に押さない限りバックグラウンドで何も走らない設計(検索クエリ戦略未確定でクォータを浪費しないため)。**`isPaused` / `isRunning` はセッション内のモードに過ぎず、再起動を跨ぐ ON/OFF はこの flag を見る**。
- **配信者リストは差分マージで投入** (2026-05-03 08:30): `seedOrUpdateCreators()` が 75 人(にじ 20 / ホロ 15 / ぶいすぽ 15 / ネオポルテ 5 / ストリーマー 20)を起動時に差分追加する。**既存名は触らず保持**(channelId / 順序保持、null group のみ backfill)、新規名のみ append。ユーザが Settings UI で手動追加 / 削除した結果も尊重。channelId は各バッチ先頭で `searchChannelByName` により未解決のみ解決(no-op fastpath、初回のみ +35 × 100u)。`creators.creator_group` は `'nijisanji' \| 'hololive' \| 'vspo' \| 'neoporte' \| 'streamer' \| null`。per-creator クエリは「切り抜き / 神回 / 名場面」の 3 角化。**サイクル間隔は 2 時間**(75 × 3 = 22.5K/サイクル + 周辺で ~23.75K → 12 サイクル/日 = 285K で 50 キー × 500K/日 予算に余裕)。creator の全 3 クエリで 0 件なら collection.log に警告(neoporte 等の流動箱の表記揺れ検出用)。
