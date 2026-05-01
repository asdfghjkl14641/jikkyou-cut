# DECISIONS

直近の意思決定を時系列(新しいものが上)で記録。最新10件程度を保持し、古いものは適宜アーカイブ。

各エントリのフォーマット:

```
## YYYY-MM-DD HH:MM - <タイトル>
- 誰が: <担当>
- 何を: <変更の本質>
- 理由: <なぜそう決めたか>
- 影響: <触ったファイル / 影響範囲>
- コミット: <ハッシュ>
```

---

## 2026-05-01 18:20 - FFmpeg 字幕焼き込みを書き出しに統合(Phase A 完了)

- 誰が: Claude Code
- 何を: 字幕機能 Phase A の最終ピース。書き出し時にアクティブ字幕スタイル + 各キューの `showSubtitle` フラグを反映した ASS を生成し、FFmpeg `subtitles` フィルタで焼き込む
  - `src/common/subtitle.ts` (新規): `buildAss()` / `convertTimecode()` / `hexToAss()` / `formatAssTime()` 純関数。BGR バイトオーダー(`&H00BBGGRR&`)、`H:MM:SS.cc` 時刻、`{` / `}` / 改行のテキストエスケープを正しく処理
  - `convertTimecode`: 削除区間を取り除いた書き出し動画上での時刻に元動画上の時刻をマップ。`deriveKeptRegions` を共有することで concat とタイムコード両方が同じ「どこを残すか」観念で動く。削除域に落ちた cue end は直前の kept region 末尾にスナップさせる派生関数 `convertTimecodeClamped` も用意
  - `src/main/export.ts`: `prepareSubtitles()` で設定 load → アクティブスタイル解決 → opt-in cue が 0 でない & フォントがインストール済みかチェック → `userData/temp` ではなく `temp/jcut-subs-*.ass` に UTF-8 BOM 付き ASS を書き出し → `subtitles=path:fontsdir=path` フィルタ断片を返す。filter_complex に `[concatv]subtitles=...[outv]` チェーンを差し込む形に変更
  - Windows パスのフィルタエスケープは `\` を `/` に変換し `:` を `\\:` に escape(過去の whisper フィルタで学んだ escape 規則と同じ)
  - フォント未インストール時・スタイル不在・OFF 時は静かに字幕なしで書き出すフォールバック。MVP ポリシーとして「字幕が出ないだけでカットは成立する」を選択
  - キャンセル/失敗時は ASS 一時ファイルを cleanup
  - `src/common/types.ts`: `ExportStartArgs` に `cues` / `videoWidth` / `videoHeight` を追加
  - `src/renderer/src/store/editorStore.ts`: `videoWidth` / `videoHeight` ステートと `setVideoDimensions` を追加(`PlayResX/PlayResY` のため)
  - `src/renderer/src/components/VideoPlayer.tsx`: `loadedmetadata` で `videoWidth/Height` を store に書き込む
  - `src/renderer/src/hooks/useExport.ts`: 新フィールドを `startExport` に渡す。寸法未取得時は 1920x1080 にフォールバック
- 理由: 基盤(型 + フォント DL + 設定永続化)と UI(設定ダイアログ + キュー ON/OFF トグル)が揃ったので、字幕機能を実用域に到達させる最後のレイヤとして焼き込みを統合。BGR の罠・タイムコード再マッピング・Windows パス escape の 3 大難所を 1 コミットでまとめて解決
- 影響: `src/common/subtitle.ts` (新規)、`src/common/types.ts`、`src/main/export.ts`、`src/main/index.ts`、`src/renderer/src/store/editorStore.ts`、`src/renderer/src/components/VideoPlayer.tsx`、`src/renderer/src/hooks/useExport.ts`
- コミット: `9bb4012`

## 2026-05-01 15:30 - 字幕設定ダイアログ UI・フォント管理 UI 実装

- 誰が: Antigravity
- 何を: 字幕機能 Phase A の UI レイヤを実装
  - ヘッダに `SubtitleSettingsDialog` を開くボタンを追加。
  - スタイルプリセット(作成/切替/削除)の管理機能、動的プレビュー(`@font-face` 動的注入)を備えた字幕設定モーダルを実装。
  - `FontManagerDialog` を実装。`availableFonts` からダウンロード状態を監視・更新。
  - キュー一覧 (`EditableTranscriptList`) の各行に字幕 ON/OFF トグルボタン (`Subtitles` アイコン) を追加。
  - Zustand (`editorStore.ts`) に `subtitleSettings` とその操作・永続化保存アクションを追加。
- 理由: Claude Code が実装した型・フォント管理バックエンドに被さる形で、ユーザーが実際に字幕設定やフォントの取得を行えるようにするため。
- 影響: `editorStore.ts`, `App.tsx`, `EditableTranscriptList.tsx/css`, `SubtitleSettingsDialog.tsx/css` (新規), `FontManagerDialog.tsx/css` (新規)
- コミット: (未定)

## 2026-05-01 14:53 - 字幕機能 Phase A 基盤(型定義 + フォント管理 + 設定永続化)

- 誰が: Claude Code
- 何を: 字幕機能の 3 分担作業のうち基盤レイヤを実装
  - `src/common/types.ts`: `SubtitleStyle` / `SubtitleSettings` / `InstalledFont` / `AvailableFont` / `DownloadResult` / `FontDownloadProgress` 型を追加。`TranscriptCue` に `showSubtitle: boolean` を必須フィールドとして追加。`IpcApi` にネスト名前空間 `fonts.*` / `subtitleSettings.*` と `onFontDownloadProgress` を追加
  - `src/main/fonts.ts` (新規): 実況・切り抜き向け厳選 12 フォントのカタログ、Google Fonts CSS API 経由で `.ttf` を `userData/fonts/` に DL、インストール済み一覧 + 削除。User-Agent ヘッダで TTF レスポンスを誘導
  - `src/main/subtitleSettings.ts` (新規): `userData/subtitle-settings.json` の load/save。組み込みプリセット 5 種(標準/強調/ポップ/レトロ/手書き風)を毎回 reconcile して再注入し、ユーザ作成スタイルだけが永続化される設計
  - `src/main/project.ts`: `normaliseCue` で `showSubtitle` のマイグレーション(旧プロジェクトでは `true` をデフォルト) + `speaker` の round-trip も同時に修正(従来は load 時に脱落していた)
  - `src/main/index.ts` / `src/preload/index.ts`: `fonts:*` / `subtitleSettings:*` の IPC ハンドラ + 進捗ストリーム `fonts:downloadProgress`
- 理由: 字幕機能は型・フォント管理 → 設定 UI(Antigravity)→ 焼き込み(Claude Code 後続)の 3 分担で進める。本タスクは後続 2 つの基盤になるため、API 形と型を慎重に固める必要がある
- 影響: 型 + main 層 + preload のみ。renderer の表示ロジックには触れていないので既存 UI の振る舞いは無変更
- コミット: `63a07ab`

## 2026-04-30 16:10 - 再生中ハイライト判定もギャップ対応に統一(scroll と highlight を 1 関数に)

- 誰が: Claude Code
- 何を: `findCueIndexForScroll` を `findCueIndexForCurrent` にリネームした上で、`EditableTranscriptList` の `currentCueIndex` セレクタからも同じ関数を呼ぶように変更。これによりキュー間ギャップ位置・冒頭/末尾の無音位置でも ▶+赤バーが「直前(あるいは最初/最後)のキュー」に表示される。スクロールとハイライトが同一インデックスを参照するため両者が乖離することがない
- 理由: 直前修正でスクロールはギャップ対応したが、ハイライトは厳密な範囲判定のままでギャップ中は消える挙動が残っており「再生中なのに ▶ がどこにも付いてない」という違和感を生んでいた
- 影響: `src/common/segments.ts`(関数名変更 + ドキュメンテーション更新)、`src/renderer/src/components/EditableTranscriptList.tsx`(currentCueIndex セレクタを差し替え、import も追従)
- コミット: `cd62c8d`

## 2026-04-30 14:36 - シーク時のスクロール対象判定をギャップ対応に修正

- 誰が: Claude Code
- 何を: シーク位置がキュー間ギャップ(無音区間)の場合、直前の最も近いキューにスクロールする `findCueIndexForScroll` 純関数を新設して `EditableTranscriptList` のシーク時 useEffect に組み込み。冒頭・末尾の無音位置でもそれぞれ最初・最後のキューへフォールバック
- 理由: ユーザがシークバー / タイムラインのギャップ位置をクリックしてもキュー一覧が動かず「シーク追従が間欠的に効かない」と見える問題を解消。再生中ハイライト(▶+赤バー)のロジックには手を入れず、スクロール対象判定だけを差し替えることで「ギャップ中はハイライトなし」という正しい挙動を維持
- 影響: `src/common/segments.ts`(`findCueIndexForScroll` 追加)、`src/renderer/src/components/EditableTranscriptList.tsx`(`seekNonce` useEffect 内で利用)
- コミット: `7ca6116`

## 2026-04-30 - シーク追従の枠組みを seekNonce 起点の片方向プッシュに刷新

- 誰が: Claude Code
- 何を: `currentCueIndex` を依存配列に置く再生中追従 useEffect を撤廃し、`<video>` の `seeked` イベントを唯一の契機とする `seekNonce` ステートを導入。`Map<cueId, HTMLDivElement>` で行 ref を管理して inline ref callback の脆さも解消
- 理由: rAF tick による頻発スクロールが scrollIntoView smooth アニメ同士で競合し、再現性が安定しなかった
- 影響: `editorStore.ts`、`VideoPlayer.tsx`、`EditableTranscriptList.tsx`
- コミット: `7ca6116` (※当該リファクタも本コミットに同梱)

## 2026-04-29 - 文字起こしエンジンを Gemini → Gladia に全面置換

- 誰が: Claude Code
- 何を: `@google/genai` 依存を削除し、`src/main/gladia.ts` に Gladia v2 API クライアント(upload + pre-recorded + ポーリング + 結果整形)を新設。`buildPrompt` を廃止して `buildCustomVocabulary` に置き換え、`TranscriptCue.speaker?: string` を追加。renderer 側の文言・リンクのみ Gladia 表記に追従
- 理由: Gemini の高負荷 503 / ゲーム固有名詞認識の限界を改善するため、話者分離(diarization) + custom_vocabulary を持つ Gladia へ移行
- 影響: `src/main/gladia.ts`(新規)、`src/main/gemini.ts`(削除)、`src/main/index.ts`、`src/preload/index.ts`(IpcApi は据え置き)、`src/common/types.ts`、`src/common/transcriptionContext.ts`、関連 renderer 文言
- コミット: `7ca6116`

## 2026-04-29 - UI 全面リデザイン(ダークテーマ + lucide-react + レイアウト再構成)

- 誰が: Antigravity
- 何を: `styles.css` に CSS 変数体系(色・スペーシング・タイポグラフィ・影・遷移)を集約。lucide-react を導入してアイコン統一。レイアウトを上下分割(動画+キュー一覧 / ExportPreview + Timeline)へ再構成。OperationsDialog(`Ctrl+Shift+O`)を新規追加
- 理由: MVP 後のデザインリッチ化と、編集体験の磨き込み
- 影響: ほぼ全 renderer コンポーネント + `App.tsx` レイアウト + `menu.ts`(操作メニュー追加)
- コミット: `c0fe77a`

## 2026-04-28 - プレビュー再生機能を追加(削除区間の自動スキップ)

- 誰が: Claude Code
- 何を: VideoPlayer の rAF tick 内で `decidePreviewSkip` 純関数を呼び、削除区間に入ったら次の kept region 先頭へ自動シーク。トグル UI を ExportPreview に追加(default ON)。1 秒の gap tolerance で ASR 自然ギャップは飛ばさない
- 理由: 編集確認のたびに書き出しを走らせるのは重い。書き出しと同じ `deriveKeptRegions` を真実源として共有することで、プレビューと最終出力の食い違い事故を構造的に予防
- 影響: `src/common/segments.ts`、`src/renderer/src/components/VideoPlayer.tsx`、`ExportPreview.tsx`、`editorStore.ts`(`previewMode`)
- コミット: `5a6e3fb`

## 2026-04-27 - MVP 完成 + `v0.1.0-mvp` タグ

- 誰が: Claude Code
- 何を: S5 で FFmpeg `filter_complex` の trim+concat による最終 mp4 書き出しを実装。tmp → final の atomic rename、`-filter_complex_script` 自動切替、`-f mp4` 明示など堅牢化。コミット `abb589a` に `v0.1.0-mvp` タグ付与
- 理由: 動画読み込み → 文字起こし → 編集 → タイムライン視覚化 → 書き出しのコアフローを完了させ、MVP として動く成果物を確定
- 影響: `src/main/export.ts`(新規)、`useExport`、`ExportButton`、`ExportProgressDialog`、関連 IPC
- コミット: `abb589a`(タグ `v0.1.0-mvp`)

## 2026-04-27 - HANDOFF.md を作成して UI 改修の引き継ぎを明文化

- 誰が: Claude Code
- 何を: プロジェクト概要・技術スタック・ディレクトリ構成・状態管理・IPC・データフロー・キーバインド・触る/触らないファイルの方針・改修候補までを 1 ファイルに集約
- 理由: UI 改修を Antigravity 側で並行進行させるため、ロジック層と UI 層の境界を明示
- 影響: `HANDOFF.md`(新規)
- コミット: `c0fe77a` に同梱

## 2026-04-26 - 文字起こしエンジンをローカル Whisper → Gemini 2.5 Flash に移行 (S2g)

- 誰が: Claude Code
- 何を: FFmpeg 内蔵 Whisper フィルタの構造的問題(Windows パスのコロンエスケープ、ドライブ制約)と日本語固有名詞の精度限界を踏まえ、Gemini Files API + generateContent ベースの BYOK 方式に置換。`safeStorage` で APIキーを DPAPI 暗号化保存、生キーを renderer に到達させない IPC 設計
- 理由: 配布前提なら長期的に堅牢な API ベース方式が必要。Gemini はコンテキストプロンプトでゲーム固有名詞認識精度が向上
- 影響: `src/main/gemini.ts`(新規/後に削除)、`src/main/secureStorage.ts`(新規)、`src/common/types.ts` の IpcApi 拡張
- コミット: `e5d37c3`
