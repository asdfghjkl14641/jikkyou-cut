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
            ├── store/
            │   └── editorStore.ts   # zustand 全アプリ状態
            ├── hooks/
            │   ├── useEditKeyboard.ts     # キーボードショートカット
            │   ├── useExport.ts
            │   ├── useProjectAutoSave.ts
            │   ├── useSettings.ts
            │   └── useTranscription.ts
            └── components/
                ├── ClipSelectView.tsx          # フェーズ2: 切り抜き範囲選択画面
                ├── CommentAnalysisGraph.tsx    # ヒートマップ風盛り上がりグラフ
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
  // フェーズ
  phase: 'load' | 'clip-select' | 'edit';
  clipRange: { startSec: number; endSec: number } | null;

  // ファイル
  filePath: string | null;
  fileName: string | null;
  durationSec: number | null;
  currentSec: number;

  // 文字起こし結果
  cues: TranscriptCue[];
  // ...
};
```

---

## 5. IPC 通信

**メインプロセスが唯一の真実源**。preload で `window.api` として expose される。
主要な名前空間: `fonts`, `subtitleSettings`, `urlDownload`, `loadProject`, `saveProject`, `startTranscription`, `startExport` 等。

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
┌────────────────────────────────────────────────┐
│ [戻る]                             [この区間を編集] │
├────────────────────────────────────────────────┤
│                                                │
│                Video Preview                   │
│                                                │
├────────────────────────────────────────────────┤
│   [|||||||||||||||| Heatmap Graph |||||||||||||]  │
│   (ドラッグして範囲選択 / Esc でクリア)           │
└────────────────────────────────────────────────┘
```

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
- **URL DL の選択フォーマット**: `<video>` 互換のため **H.264+AAC(MP4 コンテナ)を強制取得** する(`buildFormatSelector`)。三段フォールバック `bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best` で常に MP4 コンテナに落とし、`--merge-output-format mp4` で結合時のコンテナも固定。これにより 4K AV1 や 1440p VP9-mkv 等の最高画質は犠牲(最大 1080p AVC1 にキャップ)になっているが、**Chromium `<video>` のネイティブ再生互換性を優先** している。新しい URL DL に効くのみ — 旧形式で DL 済みのファイルが再生できない場合は再 DL が必要。
- **URL DL の進捗パース**: yt-dlp デフォルト出力は `Unknown%` / merge 中ドロップで不安定なので、`--progress-template "download:JCUT_PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s"` で固定フォーマット化。renderer 側の進捗ダイアログに 250ms throttle で送る。
- **Google Fonts**: Google Fonts API から TTF を動的に取得し `userData/fonts` に保存。
- **プロジェクト保存**: 動画と同じ階層に `<basename>.jcut.json` として自動保存。
- **Gladia API**: 文字起こしに使用。APIキーは `safeStorage` で保存。
