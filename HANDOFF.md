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
- 編集ループ「URL DL or ファイル読み込み → 文字起こし(話者分離 hint) → テキスト編集(話者修正・行削除・スタイル上書き) → 字幕オーバーレイで確認 → 書き出し(字幕焼き込み)」が動作

### 次フェーズ
- **進行中**: コメント分析画面 (UI 組み込み・3 フェーズ構造化完了、バックエンド待ち) — 詳細は `docs/COMMENT_ANALYSIS_DESIGN.md`
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

### 依存関係(`package.json` dependencies)

- `execa` — FFmpeg / yt-dlp 子プロセス起動
- `nanoid` — キュー / プリセット ID
- `zustand` — store
- `lucide-react` — SVG アイコン
- `react`, `react-dom`

> 注意: 旧 `@google/genai`(Gemini SDK)は Gladia 移行で削除済み

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
    │   └── urlDownload.ts     # yt-dlp 呼び出し(URL DL)
    ├── preload/
    │   └── index.ts           # contextBridge で window.api を expose
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx       # React エントリ
            ├── App.tsx        # 全体レイアウト + IPC wire
            ├── App.module.css
            ├── styles.css     # html/body リセット + CSS 変数(色/space/font)
            ├── css-modules.d.ts / global.d.ts
            ├── store/
            │   └── editorStore.ts   # zustand 全アプリ状態
            ├── hooks/
            │   ├── useEditKeyboard.ts     # キーボードショートカット
            │   ├── useExport.ts
            │   ├── useProjectAutoSave.ts
            │   ├── useSettings.ts
            │   └── useTranscription.ts
            └── components/
                ├── ApiKeySetupBanner.tsx
                ├── DropZone.tsx                # ファイル DnD + URL 入力(直近統合)
                ├── EditableTranscriptList.tsx  # キュー一覧(リニア表示)
                ├── ExportButton.tsx
                ├── ExportPreview.tsx
                ├── ExportProgressDialog.tsx
                ├── FontManagerDialog.tsx       # Google Fonts DL UI
                ├── OperationsDialog.tsx        # 操作一覧モーダル
                ├── RestoreBanner.tsx
                ├── SettingsDialog.tsx          # APIキー入力
                ├── SpeakerColumnView.tsx       # 話者カラム表示モード(DnD 対応)
                ├── SpeakerDropdown.tsx         # 話者ID 手動修正ドロップダウン
                ├── SubtitleOverlay.tsx         # <video> 上の字幕プレビュー
                ├── SubtitleSettingsDialog.tsx  # 話者プリセット + スタイルプリセット設定
                ├── TermsOfServiceModal.tsx     # URL DL 利用規約
                ├── Timeline.tsx
                ├── TranscribeButton.tsx        # マルチトグル + 話者数 select + 起動ボタン
                ├── TranscriptionContextForm.tsx
                ├── UrlDownloadProgressDialog.tsx # 進捗 + キャンセル(URL DL)
                ├── CommentAnalysisGraph.tsx    # コメント分析盛り上がりスコアグラフ(新規)
                ├── CommentAnalysisGraph.mock.ts # 分析グラフ用モックデータ生成
                ├── VideoPlayer.tsx             # <video> ラッパ + rAF + プレビュースキップ
                └── ViewModeTab.tsx             # リニア / 話者カラム 切替タブ
```

### `src/common/` 重要ファイル

| ファイル | 役割 |
|---|---|
| `types.ts` | アプリ中央型定義。`TranscriptCue` / `SpeakerStyle` / `SpeakerPreset` / `StylePreset` / `SubtitleSettings` / `ProjectFile` / `IpcApi` 等 |
| `segments.ts` | `deriveKeptRegions(cues, durationSec)` → `KeptRegion[]`(タイムライン・書き出し・プレビューの真実源)、`decidePreviewSkip(t, regions)`、`findCueIndexForCurrent(currentSec, cues)` |
| `subtitle.ts` | `buildAss({cues, keptRegions, preset, videoWidth, videoHeight})` で ASS テキストを生成。`convertTimecode` は削除区間込みの再マッピング、`hexToAss` は BGR バイトオーダー、`formatAssTime` は `H:MM:SS.cc` |
| `subtitleResolution.ts` | cue.styleOverride > preset.speakerStyles[cue.speaker] > preset.default の順で適用スタイルを決定 |
| `speakers.ts` | `speaker_0` → 「スピーカー1」のようなデフォルト名生成 |
| `transcriptionContext.ts` | `buildCustomVocabulary(ctx)` で Gladia 用語彙リスト生成(旧 buildPrompt は廃止) |

### `src/main/` 重要ファイル

| ファイル | 役割 |
|---|---|
| `index.ts` | BrowserWindow + IPC ハンドラ全登録 |
| `gladia.ts` | `validateApiKey(key)` / `transcribe()` / `cancelTranscription()`。`/v2/upload` → `/v2/pre-recorded` → ポーリング → `utterances` を `TranscriptCue[]` に変換。`diarization` + `diarization_config.{number_of_speakers,min_speakers}` を動的に送信 |
| `export.ts` | FFmpeg `filter_complex` で `[0:v]trim+[0:a]atrim` を region 数だけ並べ `concat` で連結。字幕 ON 時は `[concatv]subtitles=...[outv]` をチェーン。Windows パス escape は `\` → `/` + `:` → `\:`、4096 字超で `-filter_complex_script` ファイル渡し |
| `urlDownload.ts` | yt-dlp 呼び出し。YouTube + Twitch 対応、画質選択、進捗ストリーム |
| `subtitleSettings.ts` | `userData/subtitle-settings.json` load/save。話者プリセット + スタイルプリセット |
| `fonts.ts` | Google Fonts カタログ(厳選 12 個)、CSS API + TTF User-Agent で TTF 取得、`userData/fonts/` に保存 |
| `project.ts` | `<basename>.jcut.json` を `ProjectFile` 形式で読み書き。defensive normalisation(`speaker` / `showSubtitle` / `styleOverride` の後方互換) |
| `secureStorage.ts` | `userData/apiKey.bin` に DPAPI 暗号化で保存。renderer に **生キーを返す API は意図的に未実装** |
| `audioExtraction.ts` | FFmpeg `-vn -ac 1 -ar 16000 -b:a 64k mp3` で OS temp に MP3 抽出 |
| `mediaProtocol.ts` | `media://localhost/<encoded-path>` を実ファイルにマップ。Range 対応で `<video>` シーク必須 |

### `src/renderer/src/components/` 重要コンポーネント

| ファイル | 役割 |
|---|---|
| `App.tsx` | 全体レイアウト + IPC イベント listener。`useSettings` でハイドレート、`view` 到着時に `collaborationMode` / `expectedSpeakerCount` を store に同期 |
| `DropZone.tsx` | 動画未読込時の中央エリア。**ファイル DnD + URL 入力が統合**(クリックで OS ダイアログ、ドロップでファイル、URL 欄に貼り付けで yt-dlp DL) |
| `VideoPlayer.tsx` | `<video controls>` + rAF tick で currentTime 通知 + プレビュースキップ。`SubtitleOverlay` を子要素として乗せる。`loadedmetadata` で videoWidth/Height を store に書く |
| `SubtitleOverlay.tsx` | `<video>` 上に絶対配置で字幕をリアルタイム描画。`subtitleResolution` で cue 単位のスタイルを引く |
| `EditableTranscriptList.tsx` | リニア表示モード。2 カラム(編集列 + 字幕プレビュー列)。話者バッジ + `SpeakerDropdown` + 字幕スタイル上書きアイコン |
| `SpeakerColumnView.tsx` | 話者カラム表示モード。CSS Grid で話者ごとに列分割。**カード全体ドラッグ&ドロップで話者変更**(Plan B + C 適用済み) |
| `SpeakerDropdown.tsx` | キューバッジクリックで開く話者ID 選択ドロップダウン。新規話者追加・話者なし対応 |
| `ViewModeTab.tsx` | リニア / 話者カラムの切替タブ |
| `TranscribeButton.tsx` | マルチトグル(iOS 風)+ 話者数 `<select>`(自動/2..5/6人以上)+ 起動ボタン + 進捗バー |
| `SubtitleSettingsDialog.tsx` | 字幕設定モーダル。2 タブ(話者プリセット / スタイルプリセット)。話者ごとのフォント・色・縁・影・位置を設定 |
| `FontManagerDialog.tsx` | Google Fonts カタログから選んで DL。インストール済み一覧 + 削除 |
| `Timeline.tsx` | 動画下の横帯。kept = 青、deleted = 灰、現在位置 = 赤縦線 |
| `ExportPreview.tsx` | プレビュー再生 toggle + 元/出力時間サマリ + 書き出しボタン |
| `ExportProgressDialog.tsx` | 書き出し進捗 / 完了 / エラー / 中止モーダル |
| `TermsOfServiceModal.tsx` | URL DL 機能の初回利用同意モーダル |
| `OperationsDialog.tsx` | 操作一覧(キーボードショートカット等の参照画面) |
| `CommentAnalysisGraph.tsx` | コメント分析結果をヒートマップ状のグラフで可視化(3要素統合スコア) |
| `ClipSelectView.tsx` | フェーズ2: 切り抜き範囲選択画面。プレビュー + 盛り上がりグラフ |

---

## 4. 状態管理 (zustand `editorStore`)

`src/renderer/src/store/editorStore.ts` 1 ファイルに全アプリ状態。

### State 抜粋(全量は editorStore.ts 参照)

```ts
type EditorState = {
  // フェーズ
  phase: 'load' | 'clip-select' | 'edit';
  clipRange: { startSec: number; endSec: number } | null;

  // ファイル
  filePath: string | null;
  fileName: string | null;
  durationSec: number | null;
  videoWidth: number | null;       // ASS の PlayResX
  videoHeight: number | null;      // ASS の PlayResY
  currentSec: number;

  // 文字起こし結果
  transcription: TranscriptionResult | null;
  cues: TranscriptCue[];           // deleted / showSubtitle / speaker / styleOverride 含む
  selectedIds: Set<string>;
  focusedIndex: number | null;
  headIndex: number | null;
  past: TranscriptCue[][];         // Undo
  future: TranscriptCue[][];       // Redo (上限 100)

  // フロー status
  transcriptionStatus / Progress / Error;
  exportStatus / Progress / Result / Error;

  // プレビュー
  previewMode: boolean;
  seekNonce: number;               // シーク起点片方向プッシュ用カウンタ

  // 字幕
  subtitleSettings: SubtitleSettings | null;

  // 話者分離
  collaboratiアプリは 3 つのフェーズで構成される：

### Phase 1: 動画読み込み (`load`)
- コンポーネント: `DropZone`
- 内容: ファイルのドラッグ＆ドロップまたは URL 入力。

### Phase 2: 切り抜き選択 (`clip-select`)
- コンポーネント: `ClipSelectView`
- 内容: 盛り上がりグラフ（ヒートマップ）をドラッグして、編集したい区間を 1 つ選択する。
- 遷移: 「この区間を編集」ボタンで Phase 3 へ。

### Phase 3: 編集 (`edit`)
- コンポーネント: 既存の編集画面一式（`VideoPlayer`, `EditableTranscriptList`, `Timeline` 等）
- 内容: 文字起こし、テキストベース編集、書き出し。
- 遷移: ヘッダの「← 範囲を選び直す」ボタンで Phase 2 へ戻る。
��実源**。preload で `window.api` として expose、main で対応する `ipcMain.handle` がある。

### 名前空間別 API

```ts
// file dialogs
openFileDialog / openDirectoryDialog / getPathForFile

// menu push events
onMenuOpenFile / onMenuOpenSettings / onMenuOpenOperations

// settings (non-secret)
getSettings / saveSettings  // AppConfig は collaborationMode / expectedSpeakerCount / transcriptionContext を含む

// API key (secret) — getApiKey は意図的に未実装
hasApiKey / setApiKey / clearApiKey / validateApiKey

// transcription
startTranscription({videoFilePath, durationSec, collaborationMode, expectedSpeakerCount}) / cancelTranscription / onTranscriptionProgress

// project file
loadProject(videoFilePath): Promise<ProjectFile | null>
saveProject(videoFilePath, cues, activePresetId?)
clearProject(videoFilePath)

// export
startExport({videoFilePath, regions, cues, videoWidth, videoHeight}) / cancelExport / onExportProgress / revealInFolder

// fonts (Phase A)
fonts.{ listAvailable, listInstalled, download, remove }
onFontDownloadProgress

// subtitle settings
subtitleSettings.{ load, save }

// window title (URL DL でファイル名を表示するため)
setWindowTitle

// URL DL (yt-dlp)
urlDownload.{ start({url, quality, outputDir}), cancel, onProgress }
```

### preload の構造

`contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`。preload 経由のみ。

---

## 6. データフロー(主要)

### 動画読み込みフロー(URL DL 経路を含む)

```
[ユーザ]
 ├─ DropZone にファイル DnD or クリック → openFileDialog
 │    → setFile(absPath)
 └─ DropZone に URL 貼り付け → 利用規約同意 → urlDownload.start
      → yt-dlp で DL → setFile(downloadedPath)

[App] setFile → store reset (cues=[], 全状態クリア)
[VideoPlayer] <video src="media://localhost/<encoded>">
  ↓ loadedmetadata で setDuration + setVideoDimensions
[App useEffect: filePath] window.api.loadProject(filePath)
  ↓ ProjectFile が返れば restoreFromProject + RestoreBanner 表示(5秒)
```

### 文字起こしフロー(Gladia)

```
[ユーザ] 「マルチ」トグル + 話者数選択 → 文字起こしボタン
  → useTranscription.start
  → startTranscription({collaborationMode, expectedSpeakerCount})
  ↓ IPC
[main:gladia.transcribe]
  Phase 1: audioExtraction.ts → ffmpeg → tmp MP3
  Phase 2: /v2/upload で audio_url 取得
  Phase 3: /v2/pre-recorded を submit
    body = { audio_url, language: 'ja', diarization, [diarization_config] }
    diarization_config = { number_of_speakers: N }(N=2..5)
                       or { min_speakers: 6 }(N=6 = "6人以上")
  Phase 4: result_url を 2 秒間隔でポーリング、status='done' まで待機
  Phase 5: utterances → utterancesToCues → TranscriptCue[]
    + 副産物 SRT(<basename>.ja.srt)
  ↓ IPC return
[useTranscription] succeed → store.succeedTranscription
```

### 編集 → プレビュー → 書き出し

```
[編集]
- リニア / 話者カラム切替(ViewModeTab)
- ↑↓ + Shift で選択、D で削除/復活、Ctrl+Z/Y で Undo/Redo
- 行の話者バッジ → SpeakerDropdown で speaker 変更
- 話者カラム表示でカード全体ドラッグ → 別カラムにドロップで話者変更
- 行右クリック / 字幕アイコン → スタイル上書きメニュー
- jcut.json は 1 秒 debounce で自動保存

[プレビュー]
- VideoPlayer rAF tick で decidePreviewSkip → 削除区間を自動スキップ
- SubtitleOverlay が <video> 上に字幕をリアルタイム表示

[書き出し]
- ExportButton → useExport.start
  → jcut.json 強制保存 → deriveKeptRegions(cues)
  → window.api.startExport({videoFilePath, regions, cues, videoWidth, videoHeight})
  ↓ IPC
[main:export.startExport]
  - prepareSubtitles() で ASS 生成 → temp/jcut-subs-*.ass
  - filter_complex = trim+atrim×N + concat + (subtitles=path:fontsdir=path)
  - ffmpeg -i input.mp4 ... -c:v libx264 -crf 23 -c:a aac -movflags +faststart -f mp4 tmp.mp4
  - 進捗を onProgress → IPC → setExportProgress
  - 成功時 tmp → final rename
  - 失敗 / キャンセル時 tmp + ASS cleanup
- ExportProgressDialog success view で「エクスプローラで開く」
```

---

## 7. UI レイアウト (3フェーズ構成)

```
┌────────────────────────────────────────────────────────────────────┐
│  [マルチ●○] [話者数 ▼] [文字起こし]    [字幕設定] [⚙ 設定]        │ ← header(App.module.css)
├────────────────────────────────────────────────────────────────────┤
│  [APIキー警告 (条件付き) / 復元バナー (5秒) / URL DL進捗]            │
├────────────────────────────────────────────────────────────────────┤
│  動画未読込時:                                                      │
│  ┌────────────────────────────┐                                     │
│  │  [動画をドラッグ]          │                                     │
│  │  または                    │                                     │
│  │  [URLを貼り付け]           │                                     │
│  └────────────────────────────┘                                     │
│                                                                    │
│  動画読込後:                                                        │
│  ┌─────────────────┬────────────────────────────────────────────┐  │
│  │  動画 + 字幕    │  [リニア | 話者カラム] タブ                   │  │
│  │  オーバーレイ   ├────────────────────────────────────────────┤  │
│  │                 │  キュー一覧(リニア: 編集+プレビュー2列)        │  │
│  │  Timeline       │  または(話者カラム: 話者ごとにカラム分割)      │  │
│  │  ExportPreview  │  ※カラム表示はカード DnD で話者変更可        │  │
│  └─────────────────┴────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘

モーダル類: SettingsDialog / SubtitleSettingsDialog / FontManagerDialog /
            ExportProgressDialog / OperationsDialog / TermsOfServiceModal /
            UrlDownloadProgressDialog
```

---

## 8. キーボードショートカット

`src/renderer/src/hooks/useEditKeyboard.ts` に集約。

| キー | 動作 | 条件 |
|---|---|---|
| `↑` / `↓` | キュー選択を上下に移動(範囲リセット) | リニア表示 / 話者カラム共通 |
| `←` / `→` | 話者カラム表示時、左右の話者カラムへ移動 | 話者カラムのみ |
| `Shift + ↑↓` | 範囲選択を伸縮 | リニアのみ |
| `Ctrl + A` | 全キュー選択 | リニアのみ |
| `D` | 削除/復活トグル | 単独 |
| `Ctrl + Z` / `Ctrl + Shift + Z` / `Ctrl + Y` | Undo / Redo | Ctrl |
| `Space` | 動画再生/停止 | 単独 |
| `Esc` | DnD キャンセル / モーダルクローズ | 単独 |
| `Ctrl + O` | ファイルを開く | OS メニュー |
| `Ctrl + ,` | 設定を開く | OS メニュー |
| `Ctrl + Shift + O` | 操作一覧モーダル | OS メニュー |

無効化ロジック: `<input>` / `<textarea>` / `[contenteditable]` フォーカス中、または `<dialog open>` 内のときは早期 return。

---

## 9. 触ってよいファイル / 触らないほうがよいファイル

### ✅ 自由に触ってよい(UI 改修対象)

- `src/renderer/src/components/*.tsx` / `*.module.css`
- `src/renderer/src/App.tsx` / `App.module.css`
- `src/renderer/src/styles.css`(CSS 変数の追加など)

### ⚠ 慎重に触る

- `src/renderer/src/store/editorStore.ts` — 既存 state の型変更や削除は NG。追加は OK
- `src/renderer/src/hooks/*.ts` — 新規 hook 追加 OK、既存挙動変更は依存先を全部追う
- `src/main/*` — 新機能(IPC ハンドラ追加等)は `common/types.ts` + `preload/index.ts` と一緒に
- `src/common/types.ts` — `IpcApi` は IPC 契約。変えると main 側 IPC ハンドラの整合性チェックが必要
- `src/common/segments.ts` / `src/common/subtitle.ts` — 純関数で複数箇所が共有する真実源、しきい値・式の変更は影響範囲を確認

### 🛑 絶対触らない

- `electron.vite.config.ts` / `package.json` / `package-lock.json` / `tsconfig.*.json`

---

## 10. 既知の制約・運用上の注意

### 動画ファイルとプロジェクトファイルは同じディレクトリ前提

- `<basename>.jcut.json` / `<basename>.cut.mp4` / `<basename>.ja.srt` は動画と同じディレクトリに作る

### OneDrive 配下の動画は要注意

オンライン専用ファイル(仮想プレースホルダ)は `<video>` 経由で読めない場合あり。ローカルにコピーしてから扱うのを推奨。

### APIキー漏洩防止のルール

- `console.log(apiKey)` を絶対書かない(`maskMessage` で stderr を redact 済み)
- renderer に生キーを返す API は実装しない
- `SettingsDialog` は `type="password"` 必須

### 編集粒度の制約

- ASR キュー単位でのみ削除可能(1 キューの一部だけ残す細かい編集は不可)
- 細かい粒度が必要な場合は将来「キュー手動分割」(TODO 検討中)

### 話者分離の精度

- Gladia v2 自動検出は 3 人実況でも 2 人にまとめがち(実データで確認済み)
- 「マルチ」+ 話者数指定で `diarization_config.number_of_speakers` を hint として送ると改善する(ただし Gladia 公式は「hint であり保証されない」と明記)
- それでも誤判定する分は **話者ID 手動修正 UI**(SpeakerDropdown / カード DnD)で補正する設計

### 字幕焼き込み時のフォント

- `userData/fonts/*.ttf` に DL 済みフォントが必要。アクティブプリセットに「未インストールフォント」が含まれると **字幕なしフォールバック**(警告ログのみ、書き出しは成功)

### キュー間ギャップ

- `deriveKeptRegions` は隣接 kept キュー間の数百 ms ギャップを保持
- プレビュー再生は **1 秒未満のギャップは無視**(`PREVIEW_GAP_TOLERANCE_SEC`)
- 書き出し時のギャップは concat フィルタで自然に詰まる

---

## 11. 開発コマンド

```bash
npm run dev      # electron-vite dev -w
npm run build    # 本番ビルド
npm run start    # ビルド済みプレビュー
npx tsc --noEmit # 型チェック
```

dev 起動時の挙動:
- renderer 開発サーバ: `http://127.0.0.1:3001/`
- renderer は Vite HMR で自動反映
- main プロセスは `-w` で自動再ビルド + 自動再起動

orphan 掃除:
```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match 'jikkyou-cut' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }
```

---

## 12. 関連ドキュメント

- `DECISIONS.md` — 直近の意思決定ログ(時系列、新しいものが上)
- `TODO.md` — 残タスク + 完了済み履歴
- `IDEAS.md` — 将来構想(AI動画ディレクター方向)
- `docs/COMMENT_ANALYSIS_DESIGN.md` — 次フェーズ「コメント分析画面」MVP 設計
- `CLAUDE.md` — Claude 向けプロジェクト方針
- `LICENSE` — GPL-2.0-or-later

---

## 13. 重要な歴史 / 設計ターニングポイント

- `v0.1.0-mvp` (`abb589a`) — MVP 完成、テキストベース編集の核ループが動作
- `e5d37c3` — ローカル Whisper → Gemini API へ移行(Windows パス escape 問題回避)
- `7ca6116` — Gemini → Gladia へ全面移行(話者分離 + custom_vocabulary 対応)
- `9bb4012` — FFmpeg 字幕焼き込みを書き出しに統合(Phase A 完了)
- `5b408d1` — マルチトグル + diarization 動的化(Phase B-1)
- `b60f1f5` — 話者数指定 UI で Gladia 精度向上(Phase B-1 改善)
- `464a8e4` — 話者ID 手動修正 UI(Phase B-2)
- `c69fcfb` / `e4b6795` — 話者プリセット + キュー単位スタイル上書き(Phase B-3)
- `f0997b1` — 話者カラム表示モード
- `5b9682f` / `1001620` — カラム間 DnD で話者変更(操作性改善込み)
- `c995d3b` / `c2bc6df` — yt-dlp 統合 + DropZone への URL 入力統合

各コミットの詳細は `git log <hash>` または `DECISIONS.md` を参照。
