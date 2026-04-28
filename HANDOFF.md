# jikkyou-cut HANDOFF — UI 改修 引き継ぎドキュメント

> 想定読み手: このリポジトリの **UI / UX 改修を Antigravity IDE で進める担当**。
> ロジックや IPC を大きく変えずに、見た目・体験の質を引き上げる作業を念頭に置いています。

---

## 1. プロジェクト概要

### jikkyou-cut とは

ゲーム実況・配信切り抜きに特化した、**完全無料・オープンソース**の動画編集ツール。
Electron + React + TypeScript 製。

中核アイデアは「**テキストを消すと動画もカットされる**」というテキストベース編集パラダイム(Vrew 流)。長時間配信のアーカイブを Gemini API で文字起こしし、不要な発話キューを行単位で削除すると、対応する動画区間が削除セグメントとしてマークされる。最終的に FFmpeg で連結して書き出す。

### ターゲットユーザ

- ゲーム実況を YouTube に投稿する人
- 長時間配信(数時間級)アーカイブを切り抜きたい VTuber / ストリーマー

### 既存ツールとの差別化

| 既存 | 課題 | jikkyou-cut |
|---|---|---|
| Vrew | 汎用 + 従量課金 + 長尺動画でコスト爆発 | 実況特化 + BYOK で無制限 |
| LosslessCut | テキスト編集なし、AI 機能なし | テキスト編集 + Gemini 文字起こし |
| DaVinci / Premiere | プロ向け、習得コスト高 | 切り抜き作業に特化、低学習コスト |

### 現在の達成状況

- **MVP 完成済み**(タグ `v0.1.0-mvp` = commit `abb589a`)
- MVP 後の改善として **プレビュー再生機能**(削除区間自動スキップ)を実装済み(`5a6e3fb`)
- 現在は MVP の機能ループ「読み込み → 文字起こし → テキスト編集 → タイムライン視覚化 → プレビュー → 書き出し」が一通り動作

---

## 2. 技術スタック

| 項目 | 採用 |
|---|---|
| ランタイム | Electron 33 |
| ビルドツール | electron-vite 2(内部で Vite 5) |
| UI | React 18 + TypeScript 5(strict + noUncheckedIndexedAccess) |
| 状態管理 | **zustand 5**(Redux/Recoil 等は不採用) |
| スタイル | **CSS Modules 専用**(Tailwind/Radix/shadcn 不採用) |
| 動画処理 | システム導入済み **FFmpeg 8.1** を `execa` で呼び出す |
| 文字起こし | **Gemini 2.5 Flash API**(BYOK)、`@google/genai` 1.x |
| APIキー保存 | Electron `safeStorage`(Windows: DPAPI で暗号化) |
| プロジェクト保存 | `<basename>.jcut.json` を動画と同階層に自動書き出し(debounce 1 秒) |
| パッケージマネージャ | npm |

### 依存関係(`package.json` dependencies)

- `@google/genai` — Gemini API クライアント
- `execa` — FFmpeg 子プロセス起動
- `nanoid` — キュー ID
- `zustand` — store
- `react`, `react-dom`

### dev / build 周り(devDependencies)

- `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react`
- `typescript`
- 型定義 `@types/node`, `@types/react`, `@types/react-dom`

---

## 3. ディレクトリ構成と各ファイルの役割

```
jikkyou-cut/
├── electron.vite.config.ts    # ビルド設定 (externalizeDepsPlugin 必須)
├── tsconfig.json              # ルート(参照のみ)
├── tsconfig.common.json       # main/renderer/node 共通の strict 設定
├── tsconfig.main.json         # main + preload + common
├── tsconfig.web.json          # renderer + common
├── tsconfig.node.json         # vite config 用
├── package.json
├── README.md
├── CLAUDE.md                  # 開発方針 (Claude 向け)
├── HANDOFF.md                 # この文書
├── LICENSE                    # GPL-2.0-or-later
└── src/
    ├── common/                # main↔renderer 共有コード
    │   ├── config.ts          # AppConfig / TranscriptionContext / DEFAULT_CONFIG
    │   ├── segments.ts        # deriveKeptRegions, decidePreviewSkip 純関数
    │   ├── srt.ts             # parseSrt 純関数
    │   ├── transcriptionContext.ts  # buildPrompt 純関数
    │   └── types.ts           # TranscriptCue, IpcApi 等の中央型定義
    ├── main/                  # Electron メインプロセス
    │   ├── index.ts           # エントリ。BrowserWindow + IPC 登録
    │   ├── audioExtraction.ts # 動画→MP3 (16kHz mono 64kbps) 抽出
    │   ├── config.ts          # config.json の load/save (旧設定マイグレーション込み)
    │   ├── export.ts          # FFmpeg trim+concat による最終書き出し
    │   ├── fileDialog.ts      # 動画ファイル選択ダイアログ
    │   ├── gemini.ts          # Gemini API 呼び出し (validate / transcribe / cancel)
    │   ├── mediaProtocol.ts   # media:// プロトコルハンドラ (Range 対応)
    │   ├── menu.ts            # アプリケーションメニュー
    │   ├── progress.ts        # FFmpeg -progress パーサ (LosslessCut 由来)
    │   ├── project.ts         # <basename>.jcut.json の load/save/clear
    │   └── secureStorage.ts   # safeStorage で APIキー暗号化保存
    ├── preload/
    │   └── index.ts           # contextBridge で window.api を expose
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx       # React エントリ
            ├── App.tsx        # 全体レイアウト + 全機能の wire 集約
            ├── App.module.css
            ├── styles.css     # html/body リセット
            ├── css-modules.d.ts  # CSS Modules の型宣言
            ├── global.d.ts    # window.api 型宣言
            ├── store/
            │   └── editorStore.ts   # zustand store (全アプリ状態)
            ├── hooks/
            │   ├── useEditKeyboard.ts     # キーボードショートカット集中管理
            │   ├── useExport.ts           # 書き出し起動 + jcut.json 事前保存
            │   ├── useProjectAutoSave.ts  # 編集後 1秒で自動保存
            │   ├── useSettings.ts         # 設定 + APIキー操作
            │   └── useTranscription.ts    # 文字起こし起動 + 進捗購読
            └── components/
                ├── ApiKeySetupBanner.tsx       # APIキー未設定の警告バナー
                ├── DropZone.tsx                # 動画読込前の中央ドロップゾーン
                ├── EditableTranscriptList.tsx  # キュー一覧 + 編集UI
                ├── ExportButton.tsx            # 「📤 書き出し」ボタン
                ├── ExportPreview.tsx           # 元/出力時間サマリ + プレビューtoggle + ExportButton
                ├── ExportProgressDialog.tsx    # 書き出し中モーダル (running/success/error/cancelled)
                ├── RestoreBanner.tsx           # jcut.json 復元時の緑バナー (5秒で自動消去)
                ├── SettingsDialog.tsx          # APIキー入力モーダル
                ├── Timeline.tsx                # 動画下のタイムラインバー
                ├── TranscribeButton.tsx        # 「文字起こしを開始」ボタン + 進捗
                ├── TranscriptionContextForm.tsx # ゲーム名/キャラ等の入力フォーム
                └── VideoPlayer.tsx             # <video> ラッパ + rAF + プレビュースキップ判定
```

### `src/common/` 詳細

| ファイル | 役割 |
|---|---|
| `config.ts` | `AppConfig` 型 = `{ transcriptionContext: {gameTitle, characters, catchphrases, notes} }`。`DEFAULT_CONFIG` も export |
| `types.ts` | アプリ中央型定義。`TranscriptCue`(id/index/startSec/endSec/text/deleted)、進捗系 `TranscriptionProgress` / `ExportProgress`、各種 `*Result` 型、そして **`IpcApi`** 全体 |
| `segments.ts` | **`deriveKeptRegions(cues)` → `KeptRegion[]`** = S4(タイムライン)・S5(書き出し)・プレビューの真実源。**`decidePreviewSkip(t, regions)` → `SkipDecision`** = プレビュー判定 |
| `srt.ts` | `parseSrt(text)` で SRT 文字列を `TranscriptCue[]` に変換 |
| `transcriptionContext.ts` | `buildPrompt(ctx)` で文字起こしプロンプトを動的生成 |

### `src/main/` 詳細

| ファイル | 役割 |
|---|---|
| `index.ts` | BrowserWindow 作成、IPC ハンドラ全登録 (`dialog:openFile`, `settings:*`, `apiKey:*`, `transcription:*`, `project:*`, `export:*`, `shell:revealInFolder`) |
| `mediaProtocol.ts` | `media://localhost/<encoded-path>` を実ファイルにマップ。**Range リクエスト対応**(206 Partial Content 返却)。`<video>` のシークに必須 |
| `secureStorage.ts` | `userData/apiKey.bin` に DPAPI 暗号化で保存。renderer に **生キーを返す API は意図的に未実装** |
| `gemini.ts` | `validateApiKey(key)` で `models.list()` 検証、`transcribe()` で抽出→アップロード→`generateContent`→SRTパース。エラーは `mapError` で日本語ユーザ向け文言に分類 |
| `audioExtraction.ts` | FFmpeg `-vn -ac 1 -ar 16000 -b:a 64k mp3` で OS temp に MP3 抽出 |
| `export.ts` | FFmpeg `filter_complex` で `[0:v]trim+[0:a]atrim` を region 数だけ並べ `concat` フィルタで連結。`-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -movflags +faststart -f mp4`。**コマンドライン長 4096 超で `-filter_complex_script` ファイル渡しに自動切替** |
| `progress.ts` | `out_time_us=` / `speed=` / `progress=` を抽出する小さなパーサ |
| `project.ts` | `<basename>.jcut.json` を `{version, videoFileName, language, generatedAt, cues}` 形式で読み書き。古いスキーマも defensive にパース |
| `config.ts` | `userData/config.json` の load/save。旧 `whisperModelPath` フィールドは無視マイグレーション |
| `fileDialog.ts` | `dialog.showOpenDialog` で動画ファイル選択 |
| `menu.ts` | 「ファイル → 開く / 設定」「編集」「表示」「ウィンドウ」 |

### `src/renderer/src/components/` 詳細(UI 改修対象 — 重要)

| ファイル | 何を表示 | 受け取る state | 状態の出所 |
|---|---|---|---|
| `App.tsx` | 全体レイアウト、サブコンポーネントの組み立て、IPC イベント listener 登録 | filePath, fileName, view (settings), restoreInfo, settingsOpen | zustand + useSettings + local |
| `DropZone.tsx` | 動画未読込時の中央ドロップゾーン。クリックでダイアログ・ドラッグ&ドロップ対応 | onFileSelected(コールバック) | App から props |
| `VideoPlayer.tsx` | `<video controls>` ラッパ。`forwardRef` で `seekTo` / `togglePlayPause` を露出。**rAF ループで currentTime 通知 + プレビュースキップ判定** | filePath, onDuration, onCurrentTime / cues + previewMode | props + zustand 直購読 |
| `ApiKeySetupBanner.tsx` | APIキー未設定時の黄色バナー(警告 + 「設定を開く」CTA) | onOpenSettings | App から props |
| `RestoreBanner.tsx` | jcut.json から復元したときの緑バナー(5 秒自動フェード) | total, deleted, onDismiss | App の state 経由 |
| `SettingsDialog.tsx` | `<dialog showModal>` で APIキー入力モーダル。**type="password" 必須**。保存時に検証(models.list) | open, hasApiKey, 4 callback | useSettings |
| `TranscriptionContextForm.tsx` | 折りたたみパネル。ゲーム名/キャラ/口癖/補足 4 フィールド。`onBlur` + 500ms debounce で自動保存 | initial, onChange | useSettings |
| `TranscribeButton.tsx` | 「文字起こしを開始」ボタン + フェーズ別進捗バー(抽出/アップロード/文字起こし) + 中止 + エラー + 再試行 | apiKeyConfigured (props), 大半は zustand から | App + zustand |
| `EditableTranscriptList.tsx` | キュー一覧。選択(青枠/青背景)・削除済み(取り消し線+灰色)・**再生中(▶+左赤バー)** の 3 種マーカー。Undo/Redo/リセットボタン + ヒント帯 | onSeek (props), 大半は zustand | props + zustand |
| `Timeline.tsx` | 動画下の横帯。kept regions = 青、deleted = 灰、現在位置 = 赤縦線。クリック→シーク。3 つの時刻ラベル | onSeek, 内部は zustand | props + zustand |
| `ExportPreview.tsx` | 「☑ プレビュー再生」 \| 元: X → 書き出し: Y (-Z, N%) \| [📤 書き出し] の横 1 行 | なし、全部 zustand 直購読 | zustand |
| `ExportButton.tsx` | 書き出しトリガー。disabled 条件 4 種 + 各々のホバーツールチップ | なし、useExport + zustand | hook + zustand |
| `ExportProgressDialog.tsx` | 書き出し中モーダル。status による 4 状態切替(running/success/error/cancelled)。完了時 [エクスプローラで開く][OK] | なし、全部 zustand | zustand + useExport |

### CSS Modules の対応関係

各 `*.tsx` には **同名の `*.module.css`** が 1:1 で対応。`import styles from './X.module.css'` で `styles.className` として利用。グローバル CSS は `App.module.css`(レイアウト)と `styles.css`(html/body リセット)のみ。

色の現状(改修候補):

- メイン青: `#1976d2` / `#1e88e5`(Timeline / ExportButton / 選択 / focused)
- 補助青: `#42a5f5` / `#1565c0`
- 背景青(選択): `#e3f2fd` / `#cfe5fb`
- 警告黄: `#fff8e1`(APIキーバナー)
- 成功緑: `#e8f5e9` / `#1b5e20`(RestoreBanner)
- 削除赤: `#d32f2f` / `#b71c1c`(再生中マーカー / エラー)
- 中間灰: `#fafafa` / `#f0f0f0` / `#e0e0e0` / `#999` / `#757575` / `#555` / `#222`

---

## 4. 状態管理 (zustand `editorStore`)

`src/renderer/src/store/editorStore.ts` 1 ファイルに全アプリ状態を集約。

### State 一覧

```ts
type EditorState = {
  // ファイル
  filePath: string | null;     // 動画の絶対パス
  fileName: string | null;     // 表示用の basename
  durationSec: number | null;  // <video> の loadedmetadata で取得
  currentSec: number;          // 再生位置 (rAF で 60Hz 更新)

  // 文字起こし結果
  transcription: TranscriptionResult | null;
  cues: TranscriptCue[];       // 編集中の真実源 (deleted フラグ含む)

  // 選択 / フォーカス (anchor / head 二点モデル)
  selectedIds: Set<string>;
  focusedIndex: number | null; // anchor + 視覚カーソル
  headIndex: number | null;    // 範囲選択の active end

  // 履歴
  past: TranscriptCue[][];     // Undo スタック
  future: TranscriptCue[][];   // Redo スタック (上限 100)

  // 文字起こしフロー
  transcriptionStatus: 'idle'|'running'|'success'|'error'|'cancelled';
  transcriptionProgress: TranscriptionProgress | null;
  transcriptionError: string | null;

  // 書き出しフロー
  exportStatus: 'idle'|'running'|'success'|'error'|'cancelled';
  exportProgress: ExportProgress | null;
  exportResult: ExportResult | null;
  exportError: string | null;

  // プレビュー
  previewMode: boolean;        // 削除区間自動スキップの ON/OFF (default: true)
};
```

### アクション一覧

#### ファイル

- `setFile(absPath)` — 動画読み込み時に呼ぶ。**全 state を初期化**(編集中のものは破棄、jcut.json 自動復元は別 effect)
- `clearFile()` — 「閉じる」ボタン
- `setDuration(sec)` — `loadedmetadata` から
- `setCurrentSec(sec)` — VideoPlayer の rAF コールバックから

#### 文字起こし(useTranscription から呼ばれる)

- `startTranscription()` — running 状態へ
- `setTranscriptionProgress(p)` — IPC イベント受信
- `succeedTranscription(result)` — 成功時。**cues を初期化、focusedIndex=0 に設定**
- `failTranscription(msg)` / `cancelTranscription()` / `resetTranscription()`

#### 復元

- `restoreFromProject(cues)` — jcut.json から復元。**履歴は積まない**(undo 不可)、status='success' に擬似遷移

#### 選択

- `selectByIndex(index)` — 単一選択。anchor=head=index、selectedIds={cue.id}
- `moveFocus(delta)` — ↑↓ で anchor 移動。範囲リセット
- `extendSelectionTo(index)` — Shift+クリック。anchor 据え置き、head=index
- `extendSelectionBy(delta)` — Shift+↑↓
- `selectAll()` — Ctrl+A

#### 編集

- `toggleDeletedOnSelection()` — 選択範囲に対する「メジャートグル」(全削除済みなら全復活、それ以外は全削除)。**snapshot を past に push**
- `resetAllDeleted()` — 「リセット」ボタン。全削除を復活、これも履歴に積む

#### 履歴

- `undo()` / `redo()` — `past`/`future` スタックの操作

#### 書き出し(useExport から呼ばれる)

- `startExportState()` / `setExportProgress(p)` / `succeedExport(r)` / `failExport(msg)` / `cancelExportState()` / `resetExportState()`

#### プレビュー

- `setPreviewMode(on)` — トグル

### 編集履歴の仕組み

`toggleDeletedOnSelection` と `resetAllDeleted` だけが履歴を生成する。

```
[mutation] →
  past.push(cues snapshot) ← clone
  cues = next array
  future = [] ← branching kills future
```

```
[undo] →
  prev = past.pop()
  future.push(cues)
  cues = prev
```

```
[redo] →
  next = future.pop()
  past.push(cues)
  cues = next
```

選択操作(↑↓ / Shift / クリック)は履歴に積まない(過剰肥大化を避けるため)。

---

## 5. IPC 構造

`src/common/types.ts` の `IpcApi` 型が **renderer から呼べる API の唯一の真実源**。preload で `window.api` として expose、main で対応する `ipcMain.handle` がある。

### `IpcApi` 一覧

```ts
export type IpcApi = {
  // file dialogs
  openFileDialog: () => Promise<string | null>;
  getPathForFile: (file: File) => string;  // preload 内で webUtils.getPathForFile

  // menu events (push from main)
  onMenuOpenFile: (cb: () => void) => () => void;  // unsubscribe
  onMenuOpenSettings: (cb: () => void) => () => void;

  // settings (non-secret)
  getSettings: () => Promise<AppConfig>;
  saveSettings: (partial: Partial<AppConfig>) => Promise<AppConfig>;

  // API key (secret) — 生キーは renderer に決して返らない
  hasApiKey: () => Promise<boolean>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  validateApiKey: (key: string) => Promise<ApiKeyValidationResult>;
  // 注意: getApiKey は意図的に存在しない

  // transcription
  startTranscription: (args: TranscriptionStartArgs) => Promise<TranscriptionResult>;
  cancelTranscription: () => Promise<void>;
  onTranscriptionProgress: (cb: (p: TranscriptionProgress) => void) => () => void;

  // project file (<basename>.jcut.json)
  loadProject: (videoFilePath: string) => Promise<TranscriptCue[] | null>;
  saveProject: (videoFilePath: string, cues: TranscriptCue[]) => Promise<void>;
  clearProject: (videoFilePath: string) => Promise<void>;

  // export
  startExport: (args: ExportStartArgs) => Promise<ExportResult>;
  cancelExport: () => Promise<void>;
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void;
  revealInFolder: (path: string) => Promise<void>;
};
```

### 呼び出し元マップ

| API | 呼ばれる場所 |
|---|---|
| `openFileDialog` | `App.tsx`(menu イベント受信時)、`DropZone.tsx`(クリック時) |
| `getPathForFile` | `DropZone.tsx`(ドロップ時) |
| `onMenuOpenFile` | `App.tsx`(useEffect) |
| `onMenuOpenSettings` | `App.tsx`(useEffect) |
| `getSettings` / `saveSettings` | `useSettings.ts` |
| `hasApiKey` / `setApiKey` / `clearApiKey` / `validateApiKey` | `useSettings.ts` |
| `startTranscription` / `cancelTranscription` | `useTranscription.ts` |
| `onTranscriptionProgress` | `useTranscription.ts` |
| `loadProject` | `App.tsx`(useEffect) |
| `saveProject` | `useProjectAutoSave.ts` + `useExport.ts`(書き出し直前) |
| `clearProject` | 現状未使用(将来の「プロジェクトリセット」用) |
| `startExport` / `cancelExport` | `useExport.ts` |
| `onExportProgress` | `useExport.ts` |
| `revealInFolder` | `ExportProgressDialog.tsx`(完了時) |

### main 側の登録

`src/main/index.ts` の `registerIpcHandlers()` 内で以下チャンネルを `ipcMain.handle` で受ける:

```
dialog:openFile
settings:get / settings:save
apiKey:has / apiKey:set / apiKey:clear / apiKey:validate
transcription:start / transcription:cancel
project:load / project:save / project:clear
export:start / export:cancel
shell:revealInFolder
```

push 系(main → renderer):

```
menu:openFile / menu:openSettings
transcription:progress
export:progress
```

`webContents.send(channel, payload)` で送信、preload の `ipcRenderer.on` で listener 登録。

### preload の構造

```ts
contextBridge.exposeInMainWorld('api', {
  ...各メソッドが ipcRenderer.invoke / ipcRenderer.on でブリッジ...
});
```

`contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`。preload 経由のみ。

---

## 6. データフロー(主要)

### 動画読み込みフロー

```
[ユーザ] DropZone クリック / ドラッグ / メニュー
   ↓
window.api.openFileDialog() OR webUtils.getPathForFile(file)
   ↓
[App] setFile(absPath)
   ↓ store reset (cues=[], 全状態クリア)
[VideoPlayer] <video src="media://localhost/<encoded>">
   ↓ media:// プロトコルで実ファイル配信 (Range 対応)
[VideoPlayer] onLoadedMetadata → setDuration(sec)
   ↓
[App useEffect: filePath] window.api.loadProject(filePath)
   ↓
  cues != null && cues.length > 0
    → restoreFromProject(cues)
    → setRestoreInfo({total, deleted, nonce})
    → RestoreBanner 表示 (5秒)
  cues == null
    → 何もしない (空状態のまま、ユーザが「文字起こしを開始」を押す)
```

### 文字起こしフロー

```
[ユーザ] 「文字起こしを開始」ボタン (TranscribeButton)
   ↓
[useTranscription.start]
   ↓
[App.tsx → store] startTranscription() → status='running'
   ↓
window.api.startTranscription({ videoFilePath, durationSec })
   ↓ IPC
[main:gemini.transcribe]
   ↓ Phase 1: 音声抽出
audioExtraction.ts → ffmpeg → tmp MP3
   ↓ ffmpeg -progress → onProgress({phase: 'extracting', ratio})
   ↓ → IPC: transcription:progress → setTranscriptionProgress
   ↓ Phase 2: アップロード
GoogleGenAI.files.upload → state polling (ACTIVE 待ち)
   ↓ → onProgress({phase: 'uploading', ratio})
   ↓ Phase 3: generateContent
ai.models.generateContent({model, contents, config: {abortSignal, httpOptions}})
   ↓ → onProgress({phase: 'transcribing', elapsedSec})
   ↓
parseSrt(response.text)
   ↓
TranscriptionResult { cues, srtFilePath, ... }
   ↓ IPC return
[useTranscription] succeed(result)
   ↓
[store] succeedTranscription → cues=result.cues, focusedIndex=0
   ↓
[EditableTranscriptList] レンダリング
```

エラー時は `failTranscription(msg)`、キャンセル時は `cancelTranscription()`。

### 編集 → プレビュー → 書き出しの流れ

```
[編集]
キュー選択 (↑↓ / クリック)
 → store.selectByIndex / moveFocus
D キー
 → store.toggleDeletedOnSelection
   → cues[i].deleted を反転
   → past に snapshot push
[useProjectAutoSave]
 cues 変更 → 1秒 debounce
 → window.api.saveProject(filePath, cues)
 → main/project.ts → <basename>.jcut.json 上書き

[プレビュー再生]
<video> 再生中 (rAF tick @ 60Hz)
 → previewMode=true なら decidePreviewSkip(t, regions)
   regions = useMemo(deriveKeptRegions(cues))
   → 'skip' なら v.currentTime = nextKeptStart
   → 'end' なら v.pause() + 末尾シーク
   → 'none' なら何もしない (kept 内 or tolerance内ギャップ)

[書き出し]
[ExportButton] クリック
 → useExport.start
   ↓ jcut.json 強制保存 (debounce 待ちの編集を確実に保存)
   ↓ deriveKeptRegions(cues) → regions
[App → store] startExportState() → exportStatus='running'
 → ExportProgressDialog (running view) モーダル表示
   ↓
window.api.startExport({videoFilePath, regions: regions.map(r => ({startSec, endSec}))})
 → IPC → main/export.ts
   ↓
buildFilterComplex(regions) → '[0:v]trim=...; [0:a]atrim=...;...; concat=n=N:v=1:a=1[outv][outa]'
   ↓
グラフが 4096 文字超なら → tmp .txt に書き、-filter_complex_script 渡し
   ↓
ffmpeg -i input.mp4 ...filter... -c:v libx264 -preset medium -crf 23 -c:a aac ... -f mp4 <basename>.cut.mp4.tmp
   ↓ -progress pipe:1 → out_time_us
   ↓ → onProgress({ratio, elapsedSec, speed})
   ↓ → IPC → setExportProgress
   ↓ 成功
tmp → final rename
   ↓
[ExportProgressDialog success view]
 [エクスプローラで開く] ボタン → window.api.revealInFolder
 [OK] → resetExportState
```

### プロジェクトファイル(.jcut.json)の保存・復元

**保存(自動)**

```
[編集] cues 変更
   ↓
[useProjectAutoSave] useEffect([filePath, cues]) 発火
   ↓ 1秒 setTimeout (連打で再開)
window.api.saveProject(filePath, cues)
   ↓ IPC
[main/project.ts] saveProject
 → JSON.stringify({version: 1, videoFileName, language, generatedAt, cues})
 → fs.writeFile(<basename>.jcut.json)
```

**復元(手動)**

```
[App] setFile(absPath) → filePath 変化
   ↓
[App] useEffect([filePath]) 発火
   ↓
window.api.loadProject(filePath)
   ↓ IPC
[main/project.ts] loadProject
 → fs.readFile(<basename>.jcut.json) → JSON parse
 → 各 cue を normaliseCue で defensive 整形
 → TranscriptCue[] 返却
   ↓ IPC return
[App] cues != null && length > 0 なら
 → store.restoreFromProject(cues)
 → setRestoreInfo({total, deleted, nonce})
 → RestoreBanner 5秒表示
```

書き出し直前 forced flush:
```
[useExport.start]
   ↓
await window.api.saveProject(filePath, cues)  // debounce 無視で即書き
   ↓
window.api.startExport(...)
```

---

## 7. UI レイアウト(現状)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ jikkyou-cut                            <ファイル名> [閉じる]  [⚙ 設定]         │ ← header (App.module.css .header)
├────────────────────────────────────────────────────────────────────────────┤
│ ⚠ Gemini APIキーが設定されていません [設定を開く]                           │ ← ApiKeySetupBanner (条件付き)
├────────────────────────────────────────────────────────────────────────────┤
│ ✓ 編集状態を復元しました(N件、M件削除済み)                                │ ← RestoreBanner (5秒自動消去)
├──────────────────────────────────────────┬─────────────────────────────────┤
│                                          │ ▶ 📝 ゲーム情報を追加(精度向上)  │ ← TranscriptionContextForm (折りたたみ)
│                                          ├─────────────────────────────────┤
│                                          │ [文字起こしを開始]              │ ← TranscribeButton
│           <video controls>               │   または                        │
│                                          │   ▓▓▓▓▓░░░░ 47% (経過 02:34)    │
│                                          ├─────────────────────────────────┤
│                                          │ N 件 (M 件削除) ↩↪リセット      │ ← EditableTranscriptList summary
│                                          ├─────────────────────────────────┤
│                                          │ ▌▶ 0:00 こんにちはー            │
│                                          │  0:04 今日はこのゲームを…       │
│                                          │  0:09 ~~削除済み~~              │
│                                          │  ...                            │
├──────────────────────────────────────────┤                                 │
│ [☑ プレビュー再生] | 元: 5:00 → 書き出し: 3:42 (-1:18, 26%) | [📤 書き出し] │ ← ExportPreview
├──────────────────────────────────────────┤                                 │
│  0:00       2:30        5:00             │                                 │
│  ████████ ▒▒▒▒ █████ ▒▒ ████████ |       │                                 │ ← Timeline (高さ80px固定)
├──────────────────────────────────────────┴─────────────────────────────────┤
│ ↑/↓ 選択 | Shift+↑↓ 範囲 | Ctrl+A 全選択 | D 削除/復活 | Space 再生 ...    │ ← Hint bar (List下部)
└────────────────────────────────────────────────────────────────────────────┘
```

### サイズ・分割比率(現状)

- **アプリ全体**: フルスクリーン、`flex-direction: column`
- **header**: 固定高(padding 8px 16px、約 40px)
- **banner 類**: 必要時のみ表示、固定高(各 30〜40px)
- **body**: 残り全部、`flex: 1`、`flex-direction: row`(横分割)
  - **左ペイン (`.left`)**: `flex: 1.6`、`flex-direction: column`(縦分割)
    - `.videoArea`: `flex: 1`(残り全部 = 動画プレイヤー)
    - `ExportPreview`: 固定高(コンテンツに依存)
    - `Timeline`: 固定高 80px
  - **右ペイン (`.right`)**: `flex: 1`、`min-width: 320px`、`max-width: 480px`、`flex-direction: column`
    - `TranscriptionContextForm`: 固定高(折りたたみ次第で変動)
    - `TranscribeButton`: 固定高
    - `EditableTranscriptList`: `flex: 1`(残り全部、内部スクロール)

### モーダル類(`<dialog showModal>`)

- `SettingsDialog`: APIキー入力
- `ExportProgressDialog`: 書き出し進捗 / 完了 / エラー / 中止表示

これらは絶対配置で全画面被覆、背景はブラー / 暗転(::backdrop)。

---

## 8. キーボードショートカット一覧

`src/renderer/src/hooks/useEditKeyboard.ts` に集約。

| キー | 動作 | 条件 |
|---|---|---|
| `↑` / `↓` | キュー選択を上下に移動(範囲リセット) | 単独 |
| `Shift + ↑` / `Shift + ↓` | 範囲選択を伸縮 | Shift+ |
| `Ctrl + A` / `Cmd + A` | 全キュー選択 | Ctrl/Cmd |
| `D` / `d` | 選択キューの削除/復活トグル(メジャー) | 単独 |
| `Ctrl + Z` / `Cmd + Z` | Undo | Ctrl/Cmd |
| `Ctrl + Shift + Z` / `Cmd + Shift + Z` | Redo | Ctrl/Cmd + Shift |
| `Ctrl + Y` / `Cmd + Y` | Redo(代替) | Ctrl/Cmd |
| `Space` / `Spacebar` | 動画の再生/停止トグル | 単独 |
| `Ctrl + O` / `Cmd + O` | ファイルを開く(menu accelerator 経由) | OS メニュー |
| `Ctrl + ,` / `Cmd + ,` | 設定を開く(menu accelerator 経由) | OS メニュー |

### 無効化ロジック

`useEditKeyboard.ts` は `document.addEventListener('keydown', ...)` でグローバル listener を 1 個だけ登録。各ハンドラの先頭で:

```ts
if (isEditableTarget(e.target) || isInsideOpenDialog(e.target)) return;
```

- `isEditableTarget`: `<input>`, `<textarea>`, `contenteditable` のとき true
- `isInsideOpenDialog`: 祖先に `dialog[open]` がある場合 true(SettingsDialog / ExportProgressDialog 開放時)

これにより、入力欄でのタイピングや IME 確定のための Space、ダイアログ内の Tab ナビゲーション等とショートカットが衝突しない。

`ratchet`: store の `cues.length === 0` のとき、Space 以外のショートカットは早期 return(キューがないと意味がないため)。

---

## 9. 触ってよいファイル / 触らないほうがよいファイル

### ✅ 自由に触ってよい(UI 改修対象)

| ファイル | 理由 |
|---|---|
| `src/renderer/src/components/*.tsx` | UI コンポーネントそのもの。レイアウト・要素追加削除・props 整理は自由 |
| `src/renderer/src/components/*.module.css` | CSS Modules。色・サイズ・配置・アニメーション全て自由 |
| `src/renderer/src/App.tsx` | 全体レイアウトの組み立て箇所。サブコンポーネントの並べ替え・追加 OK |
| `src/renderer/src/App.module.css` | レイアウトグリッド・分割比率・全体カラー |
| `src/renderer/src/styles.css` | html/body のリセット。グローバルなフォント設定追加に使える |

理由: **データロジックと UI が綺麗に分離されている**ので、これらだけ触れば見た目を全面改修できる。store と IPC は触らない前提でデザイン磨きが完結する。

### ⚠ 慎重に触る(理解した上で必要なら)

| ファイル | 注意点 |
|---|---|
| `src/renderer/src/store/editorStore.ts` | UI に必要な追加 state(例: テーマ設定、レイアウトモード)を**追加するのは OK**。**既存 state の型変更や削除は NG**(他コンポーネントが依存) |
| `src/renderer/src/hooks/*.ts` | 新規 hook 追加は OK。既存 hook の挙動変更は依存先を全部追う必要あり |
| `src/renderer/src/main.tsx` | React のエントリ。テーマプロバイダ等を巻く時のみ触る |
| `src/renderer/src/global.d.ts` / `css-modules.d.ts` | 型宣言。`window.api` の型追加が必要なときだけ触る |

### 🚫 基本触らない(ロジック側)

| ファイル | 理由 |
|---|---|
| `src/main/*` 全部 | Electron メイン側。FFmpeg 呼び出し・Gemini 通信・ファイル I/O はテスト済み、UI 改修と無関係 |
| `src/preload/index.ts` | IPC ブリッジ。新 API を追加する場合のみ、`common/types.ts` と main/index.ts と一緒に触る |
| `src/common/types.ts` | `IpcApi` 型は IPC の契約。**変えると main 側全 IPC ハンドラの整合性チェックが必要** |
| `src/common/segments.ts` | `deriveKeptRegions` は S4・S5・プレビューが共有する真実源。`decidePreviewSkip` のしきい値も慎重に |
| `src/common/srt.ts` | SRT パーサ。Gemini 出力との適合がデリケート |

### 🛑 絶対触らない(構成ファイル)

| ファイル | 理由 |
|---|---|
| `electron.vite.config.ts` | ビルド構成。`externalizeDepsPlugin()` を外すと `@google/genai` 依存の `ws` 連鎖で起動失敗 |
| `package.json` | 依存追加が必要なら **必ず相談**。バージョン pin が破れると不整合 |
| `package-lock.json` | npm が管理 |
| `tsconfig.*.json` | TypeScript の strict 設定一式。`noUncheckedIndexedAccess` 等のオプションを変えると各所で型エラーが噴出 |

---

## 10. 既知の制約・運用上の注意

### 動画ファイルとプロジェクトファイルは同じディレクトリ前提

- `<basename>.jcut.json` / `<basename>.cut.mp4` / `<basename>.ja.srt` は動画と同じディレクトリに作る
- 動画ファイルが書き込み権限のないディレクトリにある場合、保存に失敗(警告 console.warn のみ)

### OneDrive 配下の動画は要注意

OneDrive のオンライン専用ファイル(仮想プレースホルダ)は HTML5 `<video>` 経由で読めない場合あり。
**ローカルディスクへコピーしてから扱うのを推奨**。同様に書き出し先が OneDrive でも問題は出にくいが、メタデータ同期に時間差が出る可能性。

### APIキー漏洩防止のルール

- **`console.log(apiKey)` / `console.error(error)` を絶対書かない**(エラーは `maskMessage` でフィルタ済み)
- renderer に生キーを送る API は実装しない(`getApiKey` は意図的に存在しない)
- 設定ダイアログでは必ず `type="password"`、保存後は入力欄を空に戻す
- safeStorage 復号エラーは「APIキーの読み込みに失敗しました。再度設定してください」のみ表示

### 編集粒度の制約(MVP)

- ASR(Gemini)が出力したキュー単位でのみ削除可能
- 1 キューの一部だけを残す細かい編集はできない
- 細かい粒度が必要な場合は ASR のセグメント長設定を調整するか、出力後 LosslessCut 等で再編集

### キュー間ギャップ

- `deriveKeptRegions` は隣接 kept キュー間の数百 ms ギャップを保持
- プレビュー再生は **1 秒未満のギャップは無視**(`PREVIEW_GAP_TOLERANCE_SEC`)
- 書き出し時のギャップは concat フィルタで自然に詰まる

### 文字起こし時のドライブ制約

過去の Whisper 実装ではあった「動画とモデルが同一ドライブ」制約は **Gemini 移行で解消**。現在の制約はなし。

---

## 11. 未実装 / 将来候補(MVP ロードマップ)

| 項目 | 概要 | 優先度感 |
|---|---|---|
| **503 自動リトライ** | Gemini 高負荷時の指数バックオフ再試行 | High(再現頻度高) |
| **波形表示** | Timeline 内に音声波形オーバーレイ、編集判断補助 | High |
| **ズーム機能** | 長時間動画の特定区間を細かく編集 | High |
| **スクラブ(ドラッグでシーク)** | Timeline つまみドラッグでリアルタイムプレビュー | Med |
| **単語単位編集** | キュー内の特定単語だけ削除 | Med(Whisper word-timestamps 必要) |
| **話者分離** | 複数人実況のラベル分け | Low(コラボ実況時のみ) |
| **キャラ名自動補完** | コンテキストフォームでゲーム名から候補表示 | Low |
| **設定永続化拡張** | `previewMode` / 出力品質 / FFmpeg パス等 | Low |
| **配布バイナリ作成** | electron-builder で `.exe` パック | High(リリース準備) |
| **ダーク/ライトテーマ** | 全体のテーマ切替 | Med(本ドキュメントの主な改修候補) |
| **空状態(empty state)のデザイン** | DropZone・キュー一覧未生成時の絵作り | Med |
| **コメントヒートマップ** | YouTube ライブのコメント密度を Timeline 上に表示 | Low(MVP でやらないと明示済み) |

---

## 12. 開発コマンド

`package.json` の `scripts`:

```bash
npm run dev      # electron-vite dev -w (ウォッチモード)
npm run build    # 本番ビルド
npm run start    # ビルド済みのプレビュー
npm run tsc      # 型チェックのみ (tsc --build)
```

### dev 起動時の挙動

- renderer 開発サーバ: `http://127.0.0.1:3001/` (electron.vite.config.ts で固定)
- main プロセス: electron-vite が main + preload をバンドル、自動で `electron .` 起動
- **renderer は Vite HMR で自動反映**(編集即反映)
- **main プロセスは `-w` で自動再ビルド + 自動再起動**(数秒待つ)
- ウィンドウを閉じると Electron アプリ全体が終了 → `electron-vite dev` も exit code 0 で終了する仕様(再起動には `npm run dev` を再実行)

### orphan プロセスの掃除

dev 中の Electron 子プロセスが残ることがあり、再起動で port 3001 が掴まれていることがある。掃除:

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match 'jikkyou-cut' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }
```

または PID を `netstat -ano | findstr :3001` で特定して `taskkill /F /PID <pid>`。

### 配布パッケージ

未作成。実装する場合は package.json に `pack-win` スクリプト + electron-builder 設定が必要。

---

## 13. コミット履歴の節目

`git log --oneline` 一覧:

```
5a6e3fb feat: プレビュー再生(削除区間の自動スキップ)        ← MVP後初の改善
abb589a S5: FFmpeg concat による最終動画書き出し (MVP 完成) ← v0.1.0-mvp タグ
f41995b S4: タイムライン可視化と書き出しプレビュー
9547779 S3: テキストベース編集UI + プロジェクトファイル自動保存
e5d37c3 S2g: 文字起こしエンジンをローカルWhisperからGemini 2.5 Flash APIに全面移行
190b0f8 S2: FFmpeg内蔵Whisperで日本語音声を自動文字起こし
19ebcd8 S1: 動画ファイル読み込み + プレビュー再生
44e4866 S0: Electron + React + TypeScript の最小構成で空ウィンドウが起動
```

### タグ

- `v0.1.0-mvp` (commit `abb589a`) — MVP 完成地点。リリース可能な最小構成

各コミットの **詳細メッセージ**(背景・設計判断含む)は `git log <hash>` で参照可能。

---

## 14. デザイン改修の余地(Antigravity へのバトン)

### 現状の所感

CSS は **機能優先で書かれており、デザイン的にはかなりミニマル**。動作確認を済ませることが優先された結果、以下のような「整理されてない部分」がある:

- カラーパレットが各コンポーネントで個別定義
- タイポグラフィ階層がほぼフラット(font-size 11px / 12px / 13px / 14px / 16px が混在)
- スペーシング(margin/padding)が 4px / 6px / 8px / 12px / 16px / 20px と分散
- アイコンはテキスト+絵文字混在(▶ / 📝 / 📤 / ⚙ / ↩ / ↪ / ✓ / ⚠)
- アニメーションは RestoreBanner のフェードのみ
- ダークモード未実装

### 改修候補(優先度順、提案)

#### 🎨 デザイントークンの整理(高)

色・スペーシング・フォントを CSS カスタムプロパティで統一。

```css
:root {
  --color-primary: #1976d2;
  --color-primary-dark: #1565c0;
  --color-success: #2e7d32;
  --color-warning: #f57c00;
  --color-danger: #b71c1c;
  --color-text: #222;
  --color-text-secondary: #555;
  --color-text-muted: #999;
  --color-border: #e0e0e0;
  --color-bg: #fff;
  --color-bg-subtle: #fafafa;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --font-xs: 11px;
  --font-sm: 12px;
  --font-md: 13px;
  --font-lg: 14px;
  --font-xl: 16px;
  --radius: 4px;
  --shadow-1: 0 2px 8px rgba(0,0,0,0.08);
}
```

各コンポーネントの CSS Module をこれに置き換えると、後のテーマ切替も楽。

#### 🌗 ダーク / ライトテーマ切替(中)

`prefers-color-scheme` + 設定ダイアログでのトグル。`<html data-theme="dark">` に切り替えるだけで全体反映できる構造にしたい(上記トークン化が前提)。

#### 🪧 空状態(empty state)の絵作り(中)

- DropZone: 大きなアイコン + コピーをもう少し丁寧に
- 動画読み込み済み・文字起こし前のキュー一覧: 「動画を読み込んで『文字起こしを開始』」のみで殺風景。誘導イラストやヒントを足したい

#### ✨ ローディング / トランジションの洗練(中)

- フェーズ切替時のアニメーション
- ボタン押下時のフィードバック(リップル等)
- ダイアログ open/close の滑らか化

#### 🖋 タイポグラフィ階層(中)

ヘッダ・サブヘッダ・本文・キャプションの 4 レベルを明確に。等幅フォントは時刻・ファイル名・コードのみに限定。

#### 🎭 アイコン体系(低)

絵文字をやめて [Phosphor](https://phosphoricons.com) や [Lucide](https://lucide.dev) などの SVG アイコンセットに統一すると、統一感とサイズ調整自由度が上がる。新規依存追加になるので相談前提。

#### 🎬 タイムラインの磨き(低)

- 波形オーバーレイ(MVP 後の機能だが視覚的にもプロらしさが上がる)
- 削除/kept ブロックのホバー時にツールチップ(該当キューのテキスト先頭表示)
- 現在再生位置インジケータをもっと目立たせる(光るマーカー等)

### 改修時に意識してほしいこと

1. **データロジックには触らない** — store / IPC / hooks の挙動は変えずに、見た目だけ磨く
2. **CSS Modules の責務分担を保つ** — グローバル CSS は `App.module.css` と `styles.css` に限定、各コンポーネントは自前 .module.css に閉じる
3. **既存のキーボード / アクセシビリティを壊さない** — `<input>` / `<dialog>` / `<button>` のセマンティクスは維持。クリックハンドラを div に移すと キーボード操作が壊れる
4. **動作確認はキュー編集と書き出しまで通す** — 表示だけ綺麗でも、ボタンの disabled が効かない・ダイアログが閉じないと困る

---

## 付録: 動作確認用コマンド集

```bash
# 開発起動
npm run dev

# 型チェックのみ
npm run tsc

# git 状態
git status
git log --oneline -10

# 直近のコミットの差分
git show HEAD

# main プロセスのログを見る
# (dev サーバ実行中の標準出力に [export] [whisper] [audio-extract] 等のプレフィックスで出る)
```

## 付録: 困った時のチートシート

| 症状 | 対処 |
|---|---|
| port 3001 が使えないと言われる | dev 起動 orphan を taskkill |
| 動画再生で赤バナー出る | DECODE は無視されるはずだが、SRC_NOT_SUPPORTED が 500ms 超続く場合は本物のコーデック非対応 |
| 文字起こし結果が 0 件 | API キー期限切れ / Gemini 503 / 入力動画が無音、それぞれエラーバナーで切り分け |
| 書き出しが「Unable to choose an output format」 | 既に `-f mp4` を明示しているので発生しないはず。tmp ファイル名変更したら再発する |
| jcut.json が反映されない | 1 秒 debounce を待つ。書き出しを起動すれば強制 flush される |
| プレビューでキュー間が雑にスキップする | 1 秒 tolerance 内のはずなのにスキップ → `PREVIEW_GAP_TOLERANCE_SEC` 調整 |

---

**バトン受け取り、よろしくお願いします。**
何か不明点があれば `git log` のコミットメッセージや `CLAUDE.md` の方針記述も併せて参照を。
