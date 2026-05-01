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

## 2026-05-01 23:00 - ドキュメント整理(IDEAS.md + COMMENT_ANALYSIS_DESIGN.md 作成)

- 誰が: Claude Code
- 何を: 既存 3 ドキュメント(`HANDOFF.md` / `DECISIONS.md` / `TODO.md`)を最新化し、長期構想と次フェーズ設計を独立ドキュメントに切り出す
  - `HANDOFF.md`: Gemini → Gladia 移行・字幕 Phase A〜B-3・URL DL・DropZone 統合・話者カラム表示・DnD 話者変更まで全て反映する全面書き直し。新ディレクトリ構成、最新 `IpcApi`、最新 `editorStore` ステート、最新キーボードショートカット、`SpeakerStyle` / `SpeakerPreset` / `StylePreset` / `SubtitleSettings` / `ProjectFile` 等の主要型を反映
  - `TODO.md`: セクション再編。「🚧 進行中」「🔵 次にやる(MVP 直近 = コメント分析画面)」「🟡 検討中」「📋 未着手 (High/Med/Low)」「🟢 将来 = IDEAS.md」「✅ 完了済み」の階層に整理。完了済みは時系列でフラットに並べた
  - `IDEAS.md` (新規、リポジトリルート): 17 項目の長期構想を優先度付きでカタログ化(配信アーカイブ→自動動画化、盛り上がり検出 AI、感情波形、神回検出、視聴維持率シミュレーター、伏線検出、空気転換点、会話密度、理解不能区間、感情カーブ、編集者プロファイル学習、動画役割分析、コメント予測 AI、配信者疲労、神タイミング SE、切り抜きタイトル生成)。"AI 動画編集ソフト" ではなく "動画の中身を理解する編集ソフト" という方向性を明文化
  - `docs/COMMENT_ANALYSIS_DESIGN.md` (新規): 次フェーズ「コメント分析画面」の MVP 設計。yt-dlp チャットリプレイ取得 → コメント密度 + キーワード出現 + (将来)視聴者数増加の合成スコア → グラフ表示 + 自動候補抽出 + 手動ドラッグ区間選択 → 編集画面へ区間情報を渡す。技術設計(`src/main/commentAnalysis/`、`CommentAnalysisView.tsx`、ProjectFile.clipRange 拡張)、実装段階(MVP / Phase 2 / Phase 3)、開放されている設計判断まで網羅
- 暗黙だった意思決定を明示化:
  - **Gladia 継続決定**: 自動分離精度の限界は明らかだが、別 ASR への乗り換えは検討しない。手動修正 UI(Phase B-2)+ プリセット階層(Phase B-3)で補う方針
  - **プリセット階層**: `SpeakerPreset`(セットプリセット = 動画ごとの「コラボメンバー一覧」)と `StylePreset`(スタイルプリセット = テンション別 = 強調/ささやき/叫び/ナレーション 等)の二階層で分離。`subtitleResolution` が cue.styleOverride > preset.speakerStyles[cue.speaker] > preset.default の順で解決
  - **"自分用ツール" 段階**: 配布バイナリ化・配布サイズ・自動更新 等の懸念は脇に置き、まず作者のワークフロー最適化を優先する段階。長期的に「動画の中身を理解する編集ソフト」(IDEAS.md)へ進む
- 理由: 長セッションが連続して未確定事項・将来構想が増えてきた。次セッションをスムーズに始められるよう、全体像を最新化 + 長期構想と次フェーズ設計を独立ドキュメントに切り出して、TODO.md は直近タスクに集中させる
- 影響: `HANDOFF.md`, `TODO.md`, `DECISIONS.md`(本エントリ追記)、`IDEAS.md`(新規)、`docs/COMMENT_ANALYSIS_DESIGN.md`(新規)
- コミット: (未定)

## 2026-05-01 22:30 - DropZone に URL DL 機能を統合(動線一本化)

- 誰が: Antigravity
- 何を: DropZone内にURL入力エリア追加、ヘッダのURL DLアイコン削除
- 理由: 動画読み込み入口を1箇所に集約してUX向上
- 影響: DropZone, App.tsx, DropZone.module.css
- コミット: c2bc6df

## 2026-05-01 22:20 - URL動画ダウンロード機能(yt-dlp統合)

- 誰が: Antigravity
- 何を: yt-dlp 同梱、URL DLダイアログ、進捗表示、設定永続化、利用規約同意フロー
- 理由: 量産ワークフローでブラウザ→外部ツール→アプリ起動 の3ステップを1ステップに短縮
- 影響: main/urlDownload.ts(新規), preload/index.ts, config.ts, types.ts, App周辺UI、resources/yt-dlp/
- コミット: c995d3b

## 2026-05-01 21:50 - DnD 操作性改善(カード全体を drag source 化)

- 誰が: Claude Code
- 何を: 直前の DnD 実装で報告された「掴めない・反応が悪い」を解消するため、Plan B + C を適用(Plan A は B の効果で実質不要に)
  - **Plan B**: `draggable=true` を `GripVertical` ハンドル → `cueCard` div 全体へ移動。textarea 以外の場所(タイムコード周辺・話者バッジ余白・カード端など)どこを掴んでもドラッグ開始する
  - `cueCard.onDragStart` 内で `(e.target as HTMLElement).tagName === 'TEXTAREA'` なら `preventDefault()` → textarea のテキスト選択ドラッグはネイティブに任せる
  - textarea 側にも belt-and-braces で `onDragStart={preventDefault}` + `onMouseDown={stopPropagation}` を追加。一部ブラウザが textarea 自身に dragstart を流すケースと、mousedown bubble で card 側挙動が混入するケースの両方に保険
  - **Plan C**: `.cueCard` に `user-select: none` で text-selection drag を抑制 → mousedown→drag 開始がスムーズに。`.textInput` 側で `user-select: text` + `cursor: text` を再宣言してテキスト選択は維持
  - **Plan A は不要化**: 旧実装はアイコン中心の小さい hit area が問題だったが、カード全体を drag source にしたので hit area 拡大の必要がなくなった。`GripVertical` は `pointer-events: none` の純視覚ヒントに格下げ(カード hover で color 強調)
  - cursor は `cueCard` で `grab`、`:active` で `grabbing`、textarea で `text` 上書き
- 理由: HTML5 ネイティブ DnD 自体は変更せず、UX のボトルネック(掴む対象が小さい・テキスト選択と競合)だけ解消する最小コストの修正。ハンドルを一度実装したものをカード化に再構成しただけで実質追加コードは少ない
- 影響: `SpeakerColumnView.tsx`, `SpeakerColumnView.module.css`
- コミット: (未定)

## 2026-05-01 21:30 - 話者カラム表示でドラッグ&ドロップ話者変更

- 誰が: Claude Code
- 何を: HTML5 Drag and Drop API でキューカードをカラム間移動可。speaker フィールドが即時更新され、Undo/Redo にも自動で乗る
  - `SpeakerColumnView.tsx`: タイムコードヘッダ左端に `GripVertical` アイコンのドラッグハンドルを追加(`draggable` はハンドルのみ — textarea とは独立)。drag 中は `draggedCueId` で source カードを半透明化、`dragOverSpeaker` で対象カラムをハイライト
  - グリッドカラムは独立 DOM ではなく CSS Grid 配置なので、ドロップターゲットは `.speakerColumns` コンテナ全体に対する `dragover`/`drop` で受け取り、**マウスの clientX をコンテナの bounding rect に対して hit-test して target 列を決定**
  - ドロップオーバーレイは `gridRow: 1 / span ${cues.length}`(`-1` は `grid-auto-rows` の場合 implicit row を含まないため使えない)で各カラムに `pointer-events: none` のハイライト要素を敷く。drag 中だけレンダリング
  - 既存 `updateCueSpeaker` action を再利用 — 同じカラムへのドロップは早期 return で no-op。Undo/Redo は store の history 機構に乗る
  - `dragend` を source の安全網にして、Esc キャンセル / 範囲外ドロップでも highlight が残らないようにした
- 理由: Gladia の自動分離精度の限界が明らかになっており、コラボ実況編集では話者ID 修正が頻発する作業。バッジクリック→ドロップダウン→選択の 3 ステップを **ハンドルドラッグ→対象カラムにドロップの 1 動作** に短縮することで、編集効率が体感で大きく改善する
- 影響: `SpeakerColumnView.tsx`, `SpeakerColumnView.module.css`
- コミット: (未定)

## 2026-05-01 21:15 - UI整理(ヘッダ・操作一覧の不要要素削除)

- 誰が: Antigravity
- 何を: ロゴ削除、マルチラベル削除、ヘッダファイル名削除(ウィンドウタイトルに移動)、下部操作一覧削除
- 理由: 視覚ノイズ削減、編集に集中できるシンプルなUI
- 影響: App.tsx/Header系、main/index.ts、EditableTranscriptList、SpeakerColumnView
- コミット: (未定)

## 2026-05-01 21:00 - 字幕機能 Phase 2 後の細部修正(バッジ簡略化、字幕スタイル適用、ヘッダ編集可能化)

- 誰が: Antigravity
- 何を: リニア話者バッジを `[1]` 形式に簡略化、SpeakerColumnView キューテキストに字幕スタイル適用、カラムヘッダのインライン名前編集
- 理由: 編集効率向上、字幕の視覚確認向上、コラボ動画でのキャラ付け簡素化
- 影響: EditableTranscriptList, SpeakerColumnView, SpeakerDropdown
- コミット: (未定)

## 2026-05-01 20:30 - 字幕機能 Phase 2: キュー単位の字幕スタイル上書き

- 誰が: Antigravity
- 何を: StylePreset 型導入、字幕設定画面に「スタイルプリセット」タブ、キュー右クリックで上書きメニュー、リニア+話者カラム両モード対応、resolveSubtitleStyle で優先順位統一
- 理由: 実況のテンション・場面に応じた字幕の表情変化を実現
- 影響: types, subtitleSettings, export, editorStore, SubtitleSettingsDialog, SubtitleOverlay, EditableTranscriptList, SpeakerColumnView
- コミット: (未定)

## 2026-05-01 20:25 - 字幕設定・話者プリセット機能の詳細修正(Phase 1完了)

- 誰が: Antigravity
- 何を: `SubtitleSettingsDialog` にて追加された話者の削除機能(使用中のガード付き)の実装。また、`src/common/speakers.ts` にて `defaultSpeakerName` 関数を追加し、「スピーカー1」のようなデフォルト表示名への変換ロジックを実装。さらに `SpeakerDropdown.tsx` と連携して、カスタマイズされた話者名がバッジにも反映されるように修正。
- 理由: 不要になった話者スタイルを消せるようにするとともに、初見で「speaker_0」のような無機質な内部IDが表示されるのを防ぎ、ユーザー体験を向上させるため。
- 影響: `src/renderer/src/components/SubtitleSettingsDialog.tsx`, `src/common/speakers.ts`, `src/renderer/src/components/SpeakerDropdown.tsx`
- コミット: (未定)

## 2026-05-01 20:10 - 字幕設定の大規模リファクタ・話者ごとのプリセット機能(Phase B-3)

- 誰が: Antigravity
- 何を: `SpeakerPreset` データモデルへ移行し、`SubtitleSettingsDialog` を「左にスピーカーリスト・右に詳細設定」の2カラム構成へ完全リニューアル。`cues` に含まれる話者を自動でリストに追加する Reconciliation の実装や、FFmpegの `.ass` 出力時に話者ごとのスタイル(`Speaker_speaker_N`)を出し分ける仕組みを実装。
- 理由: マルチスピーカーの実況・コラボ動画において、話者ごとに個別の字幕色・フォントをスムーズに適用し、プリセットとして永続化できるようにするため。
- 影響: `types.ts`, `subtitleSettings.ts`, `project.ts`, `index.ts`, `SubtitleSettingsDialog.tsx/css`, `EditableTranscriptList.tsx`, `SubtitleOverlay.tsx`, `export.ts`, `subtitle.ts`, `editorStore.ts`, `App.tsx`
- コミット: (未定)

## 2026-05-01 19:53 - 話者ID手動修正UI(Phase B-2)実装

- 誰が: Antigravity
- 何を: キューバッジクリックで話者IDをドロップダウンから変更可能にし、新規話者追加・話者なし対応、Undo/Redo対応を実装。
- 理由: Gladia自動分離の限界をユーザの手動補正で補うため。
- 影響: `editorStore.ts`, `EditableTranscriptList.tsx`, `SpeakerColumnView.tsx`, `SpeakerDropdown.tsx`(新規)
- コミット: (未定)

## 2026-05-01 20:50 - 話者数指定 UI で Gladia 話者分離精度を向上

- 誰が: Claude Code
- 何を: 話者数を明示する UI を追加し、Gladia リクエストに `diarization_config` を載せる
  - `src/common/config.ts`: `AppConfig.expectedSpeakerCount: number | null` 追加(`null` = 自動、2..5 = 明示、`6` = "6人以上"のセンチネル)
  - `src/main/config.ts`: `normaliseSpeakerCount` で 2..6 の範囲だけ通す。それ以外は null へクランプ。`saveConfig` は `=== undefined` で discriminate して null 値の意図的セットも通す
  - `src/common/types.ts`: `TranscriptionStartArgs.expectedSpeakerCount` 追加
  - `src/main/gladia.ts`: `submitJob` 引数に追加。`collaborationMode` が ON かつ count があるときだけ `diarization_config` を添える。2..5 → `number_of_speakers`、6 → `min_speakers: 6`(上限を切らない)。ログにも反映
  - `src/main/index.ts`: IPC ハンドラで legacy fallback(`undefined` のとき config から読む、`null` は通す)
  - `editorStore.ts`: `expectedSpeakerCount` ステート + `setExpectedSpeakerCount` setter(`saveSettings` を fire-and-forget で叩いて永続化)
  - `App.tsx`: 既存の collaborationMode ハイドレーションに `expectedSpeakerCount` も同梱
  - `useTranscription.ts`: store 値を IPC に渡す
  - `TranscribeButton.tsx/module.css`: 「マルチ」トグルの右隣に `<select>` を追加(自動/2人/3人/4人/5人/6人以上)。`!collaborationMode || isRunning` で disabled。CSS は CSS-only な三角矢印 + ホバー/フォーカス時のアクセントカラー強調で既存トグルに馴染ませた
- 理由: 直前の調査(`.jcut.json` の speaker distinct 値が 2)で **3 人実況動画でも Gladia 自動推定が 2 人にまとめてしまう** ことを実データで確認。`diarization_config` を送って hint で精度向上を狙う。Gladia 公式は「hint であり保証されない」と明記しているが、auto より明確に良い結果になることは期待できる。100% 解決しないケースは将来 Phase B-2(話者ID 手動修正 UI)で対応
- 影響: `src/common/config.ts`, `src/common/types.ts`, `src/main/config.ts`, `src/main/gladia.ts`, `src/main/index.ts`, `src/renderer/src/store/editorStore.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/hooks/useTranscription.ts`, `src/renderer/src/components/TranscribeButton.tsx`, `src/renderer/src/components/TranscribeButton.module.css`
- コミット: (未定)

## 2026-05-01 20:10 - 話者分離有効化トグル(コラボモード)実装(Phase B-1)

- 誰が: Claude Code
- 何を: 文字起こし時の Gladia diarization パラメータをハードコード `true` から動的化し、`コラボ` トグル UI を追加
  - `src/common/config.ts`: `AppConfig.collaborationMode: boolean` 追加(デフォルト `false` = ソロ)
  - `src/main/config.ts`: load/save の双方向で field を読み書き。旧 config(field 無し)は `false` にフォールバック
  - `src/common/types.ts`: `TranscriptionStartArgs` に `collaborationMode` 必須フィールドを追加
  - `src/main/gladia.ts`: `submitJob` / `transcribe` 引数に `collaborationMode` を追加し、`/v2/pre-recorded` リクエストの `diarization` に流す。ログにも反映
  - `src/main/index.ts`: IPC ハンドラで renderer 引数を優先しつつ、欠落時は永続化 config にフォールバック(古い renderer 構築物を吸収)
  - `src/renderer/src/store/editorStore.ts`: `collaborationMode` ステート + `setCollaborationMode` 追加。setter は in-memory 更新と同時に `window.api.saveSettings` で永続化(fire-and-forget、失敗時は warn のみ)
  - `src/renderer/src/App.tsx`: `useSettings` の view が arrival した時に `useEditorStore.setState({ collaborationMode })` で初期化(setter 経由だと round-trip save が走るので setState を直接使用)
  - `src/renderer/src/hooks/useTranscription.ts`: store 値を `startTranscription` IPC に渡す
  - `src/renderer/src/components/TranscribeButton.tsx/module.css`: 文字起こしボタンの左隣に `<input type="checkbox">` ベースの「コラボ」トグル追加。ON 時はアクセントカラーの淡い背景 + 枠、`title` でツールチップ「複数人/単独」を切替表示。`isRunning` 中は disabled
- 理由: ソロ実況・コラボ実況のユースケースを切り替え可能にする。ソロ時は API 側の diarization 処理を省略でき、結果の話者バッジ・SRT プレフィックスも自動的に消える(`utterancesToCues` の `speaker` undefined → `buildSrt` の `includeSpeakers` ゲートが false)。**Phase B-1**(話者分離フローの土台)としてのリリース
- 影響: `src/common/config.ts`, `src/common/types.ts`, `src/main/config.ts`, `src/main/gladia.ts`, `src/main/index.ts`, `src/renderer/src/store/editorStore.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/hooks/useTranscription.ts`, `src/renderer/src/components/TranscribeButton.tsx/module.css`
- コミット: `5b408d1`

## 2026-05-01 18:46 - 話者カラム表示モード(コラボ動画のテキスト整理用ビュー)

- 誰が: Antigravity
- 何を: `viewMode` state、`ViewModeTab` + `SpeakerColumnView` コンポーネント、リニア/話者カラム切替、カスタム2Dキーボード操作(useEditKeyboard)の実装。
- 理由: コラボ動画で話者IDが混在する場合のテキスト修正・コピペ作業を最適化するため。
- 影響: `editorStore.ts`, `EditableTranscriptList.tsx`, `useEditKeyboard.ts`, `ViewModeTab.tsx`(新規), `SpeakerColumnView.tsx`(新規)
- コミット: (未定)

## 2026-05-01 18:08 - コラボトグルのデザイン刷新(iOS風スイッチ + 「マルチ」リネーム)

- 誰が: Antigravity
- 何を: `TranscribeButton` コンポーネント内のチェックボックスを iOS 風トグルスイッチへと変更し、ラベル「コラボ」を「マルチ」に変更。
- 理由: 既存のダークテーマ・洗練された UI デザインと統一させるため。
- 影響: `TranscribeButton.tsx` + `TranscribeButton.module.css` のみ
- コミット: (未定)

## 2026-05-01 19:30 - 動画プレビュー上の字幕オーバーレイ表示を追加

- 誰が: Antigravity
- 何を: `SubtitleOverlay` コンポーネントを新設し、`VideoPlayer` の上に配置。設定中のフォント・色・縁・影・位置をリアルタイムに反映。また `App.tsx` と `FontManagerDialog.tsx` にて、ダウンロード済みローカルフォントを `FontFace` API 経由で動的に `document.fonts` へ登録する仕組みを追加。
- 理由: 書き出しを行わずとも、編集・プレビュー中に字幕の見た目（フォント・色・タイミング等）をリアルタイムで確認できるようにするため。
- 影響: `SubtitleOverlay.tsx`/`.css` (新規), `VideoPlayer.tsx`, `App.tsx`, `FontManagerDialog.tsx`
- コミット: (未定)

## 2026-05-01 19:24 - 字幕プレビュー列を中央列と同じ 13px に最終調整

- 誰が: Claude Code
- 何を: `.subtitlePreview` を `font-size: 13px !important`、`previewStyle` の ratio 分母も 13 に再変更
- 理由: 10px は逆に小さすぎて読みにくいとのフィードバック。中央列の継承サイズ(`--font-size-md` = 13px)とぴったり揃えることで両列の視覚的密度が完全一致し、行ごとの比較が直感的になる
- 影響: `EditableTranscriptList.module.css` / `EditableTranscriptList.tsx`
- コミット: (未定)

## 2026-05-01 19:18 - 字幕プレビュー列のサイズをさらに 10px に縮小

- 誰が: Claude Code
- 何を: `.subtitlePreview` を `font-size: 10px !important`、`previewStyle` の ratio 分母も 10 に再変更
- 理由: ユーザフィードバックで 15px でもまだ大きいとのこと。中央列 13px に対して右列を **明確に小さい 10px** にすることで、字幕プレビューが視覚的にサブ要素として落ち着き、メイン編集視線(中央列)を邪魔しない
- 影響: `EditableTranscriptList.module.css` / `EditableTranscriptList.tsx`
- コミット: `1199979`

## 2026-05-01 19:05 - 字幕プレビュー列のサイズを 15px に再調整(原因究明込み)

- 誰が: Claude Code
- 何を: `EditableTranscriptList.module.css` の `.subtitlePreview` を `font-size: 15px !important` + `line-height: 1.4` に変更。`EditableTranscriptList.tsx` の `previewStyle` 内の ratio 計算分母を 20 → 15 に更新し、outline/shadow も 15px 基準でスケール
- 理由(原因究明): 前回の「20px 固定」は **正しく適用されていた** が、中央列(`.cue` → `.text`)が継承する `--font-size-md` が **13px** だったため、20px の右列は ~1.54× 大きく見えていた。ユーザの「効いてない」感覚はサイズの絶対値ではなく **比率** の問題だった。inline style 側に `fontSize` は元々入っていない(`previewStyle` は fontFamily/color/paintOrder/WebkitTextStroke/textShadow のみ)ので JSX 撤去は不要。CSS 単体で 15px に下げる + `!important` で将来のうっかり inline 上書きをブロック
- 影響: `EditableTranscriptList.module.css`(.subtitlePreview のフォントサイズと line-height + コメントで原因記録)、`EditableTranscriptList.tsx`(ratio 計算の分母を 15 に)
- コミット: `a7027bf`

## 2026-05-01 17:15 - 緊急修正: キュー一覧のプレビュー列が巨大化する不具合の修正

- 誰が: Antigravity
- 何を: `EditableTranscriptList.tsx` のインラインスタイルから `fontSize` や CSS 変数による複雑な拡大縮小ロジックを全削除し、`.subtitlePreview` クラス内で `font-size: 20px; line-height: 1.5;` を静的に指定するよう修正。ホバー拡大仕様も廃止。
- 理由: インラインスタイルの CSS 変数がうまく適用されなかったか、あるいは React の CSS 変換によって型破綻を起こし、結果的に親の巨大なフォントサイズ指定（または意図せぬスケール）が全行に及んでしまったと推測されるため。シンプルな 20px 固定にすることで行の高さと密度を安定させた。
- 影響: `EditableTranscriptList.tsx`, `EditableTranscriptList.module.css`
- コミット: (未定)

## 2026-05-01 16:25 - キュー一覧2カラムのサイズ調整(右列を中央列と同サイズ + ホバー拡大、動画ペイン縮小)

- 誰が: Antigravity
- 何を: 右列プレビューのフォントサイズを20pxに固定し、ホバー/選択時のみ拡大（最大48px）するよう CSS Variables で実装。動画エリアの flex 比率を縮小し、キュー一覧を拡張（4:6 に変更）。
- 理由: 行密度を揃えて一覧性を上げるため。また、プレビュー表示により動画自体の重要度が相対的に下がったため、レイアウトバランスをキュー一覧側に最適化。
- 影響: `EditableTranscriptList.tsx`, `EditableTranscriptList.module.css`, `App.module.css`
- コミット: (未定)

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

## 2026-05-01 16:15 - 緊急修正: キュー一覧のコンテナクエリバグを Media Query に置換

- 誰が: Antigravity
- 何を: `EditableTranscriptList.module.css` の `@container` を `@media (max-width: 800px)` に変更
- 理由: `container-type` を指定していても一部環境でコンテナ幅が正しく評価されず、デフォルトの `display: none` または grid の崩れにより右列が常時消える不具合が報告されたため。シンプルな Window 幅基準のメディアクエリにフォールバックして安定化を図った。
- 影響: `EditableTranscriptList.module.css` のみ
- コミット: (未定)

## 2026-05-01 16:07 - キュー一覧を2カラム構成(編集列+字幕プレビュー列)に拡張

- 誰が: Antigravity
- 何を: EditableTranscriptList を Grid で2カラムに分割し、右列に字幕スタイルの動的プレビューを追加
- 理由: 編集中に最終的な字幕の見た目を常時確認できるようにするため（動画を毎回再生する手間を排除）。
- 影響: `EditableTranscriptList.tsx`, `EditableTranscriptList.module.css` のみ
- コミット: (未定)

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
