# TODO

進行中タスク・残タスク・完了済みタスクの一覧。`HANDOFF.md` の「未実装/将来候補」セクションをタスク化し、本ファイルで進捗を追う。

---

## 🚧 進行中

(進行中タスクなし。字幕機能 Phase A 完了 + Phase B-1 完了)

---

## 🔵 次にやる

- URL動画ダウンロード(yt-dlp)
- 無音区間自動マーク
- 字幕パディング(前100ms/後300ms)

---

## 📋 未着手(優先度順)

### High

- **503 自動リトライ(Gladia 含む)** — API 側の高負荷時の指数バックオフ。Gemini 期に問題化、Gladia でも同型のリスクあり。`gladia.ts` の `submitJob` / `pollResult` でラップ
- **Gladia API 実機検証** — フィールド名(`audio_url` / `result_url` / `utterances`)等が想定通りかを実物で確認、必要に応じて defensive parsing を強化
- **配布バイナリ作成** — electron-builder で `.exe` パッケージング。署名・自動更新は別途検討
- **未対応コーデック動画への対応** — H.265 / mkv 等を MediaSource 経由で再生可能に(LosslessCut の compatPlayer.ts 参考)

### Medium

- **波形表示** — Timeline に音声波形をオーバーレイ。編集ポイントの判断補助
- **ズーム機能** — 長時間動画の特定区間を細かく編集できるよう、Timeline の横スクロール + 倍率変更
- **スクラブ(ドラッグでシーク)** — Timeline つまみドラッグでリアルタイム動画シーク
- **空状態(empty state)のデザイン磨き** — DropZone・キュー一覧未生成時のヒント / イラスト
- **ローディング・トランジションの洗練** — フェーズ切替アニメーション、ボタン押下フィードバック

### Low

- **単語単位編集** — 1 キュー内の特定単語だけ削除(Gladia の word-level timestamps があれば実装可能)
- **学習する話者プロファイル** — 声紋から自動推定し、過去の動画の話者を自動アサイン（将来のユーザ要望）
- **キャラ名自動補完** — TranscriptionContextForm でゲーム名から候補表示
- **設定永続化拡張** — `previewMode` / FFmpeg パス / 出力品質などをユーザ設定に
- **ダーク/ライトテーマ切替** — 現状ダーク固定、`prefers-color-scheme` 連動 + 設定切替
- **音声フェードイン/アウト** — プレビュー再生時のスキップでの瞬断対策
- **コメントヒートマップ** — YouTube ライブのコメント密度を Timeline 上に重畳(MVP スコープ外と明示済み)
- 🟡 **検討中: キュー個別のスタイル変更** — 行ごとに異なるプリセット選択やカスタムスタイルを適用できるようにする
- 🟡 **検討中: キューの手動分割** — 1キュー内で話者が変わる場合の分割対応
- 🟡 **検討中: 範囲選択での一括ドラッグ&ドロップ話者変更** — 複数キューを選択してまとめてカラム移動。現状はカード単位の DnD のみ

---

## ✅ 完了済み(直近)

- **2026-05-01** DropZone に URL DL 機能を統合(動線一本化) — 初期画面のドロップエリアにURL入力欄を追加し、ヘッダのDLアイコンを削除。動画読み込みの入口を一本化しました。
- **2026-05-01** URL動画ダウンロード機能(yt-dlp統合) — yt-dlpを同梱し、URLを貼るだけで動画をDLしてそのまま編集可能にする機能を実装。利用規約同意フロー、画質選択、進捗表示に対応。
- **2026-05-01** DnD 操作性改善(掴みやすさ) — 直前の実装で「掴めない・反応が悪い」を解消。`draggable=true` をハンドルからカード全体に移動 → textarea 以外どこ掴んでもドラッグ開始。textarea 側は `onDragStart` で preventDefault してテキスト選択を保持。`.cueCard` に `user-select: none`、`.textInput` で `text` を再宣言。cursor: grab/grabbing をカード全体に。`GripVertical` は `pointer-events: none` の純視覚ヒントに変更
- **2026-05-01** 話者カラム表示でドラッグ&ドロップ話者変更 — 各キューカードのタイムコードヘッダに `GripVertical` ハンドルを追加。ドラッグ→対象カラムにドロップで `speaker` フィールドを即時更新。CSS Grid のカラムは独立 DOM ではないため、`.speakerColumns` コンテナへの `dragover`/`drop` で受けてマウス clientX から hit-test して target 列を決定。ドラッグ中は source カードを半透明化、対象カラムをアクセントカラーの破線ハイライトでマーク。同カラムへのドロップは no-op、Undo/Redo にも乗る
- **2026-05-01** UI整理(ヘッダ・操作一覧の不要要素削除) — ロゴ、マルチラベル、ヘッダファイル名表示、下部操作一覧を削除。ファイル名はウィンドウタイトルに表示するように変更。
- **2026-05-01** 字幕機能 UI/UX 細部修正 — リニア表示時のバッジを `[1]` に簡略化。SpeakerColumnViewで字幕スタイルがテキストエリアに即時反映(非フォーカス時)されるようにし、カラムヘッダでのインライン名前編集・自動保存(設定画面との双方向同期)を実現。
- **2026-05-01** 字幕機能 Phase 2(キュー単位上書き) — StylePreset の導入、SubtitleSettingsDialog への「スタイルプリセット」タブの追加、EditableTranscriptList および SpeakerColumnView での右クリック/アイコンによるスタイル上書きメニューの実装。これで字幕機能は完全完成。
- **2026-05-01** 字幕設定・話者プリセット機能の細部修正 — ユーザが追加した話者の削除機能(使用中の話者は削除不可)、話者名のデフォルト生成ロジック(`スピーカー1/2/3`)の導入、`EditableTranscriptList` と `SpeakerDropdown` のバッジ表示をカスタマイズされた名前に同期する機能を実装。(Phase 1 完全完了)
- **2026-05-01** 話者ごとの字幕スタイル・プリセット機能実装(Phase B-3) — `SpeakerPreset` データモデルへの移行。`SubtitleSettingsDialog` の2カラム化と各話者に対するスタイル設定、動画内の話者の動的リストアップ、プレビュー及びFFmpeg用のASS生成ロジック(`Speaker_speaker_N`)の適用を実装。

- **2026-05-01** 話者ID手動修正UI(Phase B-2)実装 — キューバッジクリックで話者IDをドロップダウンから変更可能に。新規話者追加・話者なし対応、Undo/Redo対応。
- **2026-05-01** 話者数指定 UI で Gladia 話者分離精度を向上 — 実データで「3 人実況動画でも Gladia 自動推定が 2 人にまとめる」ことを確認した上で、「マルチ」トグルの右隣に話者数 `<select>`(自動/2..5/6人以上)を追加。`diarization_config` を送ることで Gladia に hint を与える(2..5 → `number_of_speakers`、6 → `min_speakers: 6`)。永続化込み、マルチ OFF / 文字起こし実行中は disabled
- **2026-05-01** 話者カラム表示モードの実装 — 話者ごとのキューをカラム単位で分離表示する表示モード（コピペ用・プレビュー省略）。`editorStore` に `viewMode` を追加し、キーボードナビゲーション（↑↓ ← → による1D/2Dシームレス移動）にも対応。
- **2026-05-01** コラボトグルのデザイン刷新 — 「コラボ」チェックボックスを iOS風のトグルスイッチに変更し、ラベルを「マルチ」にリネーム。UIデザインの一貫性を向上。
- **2026-05-01** 話者分離有効化トグル(コラボモード)実装 — **Phase B-1**。`AppConfig.collaborationMode` を追加し、文字起こしボタンの左隣に「コラボ」チェックボックスを配置。ON で Gladia diarization=true、OFF で diarization=false に切り替え。デフォルトは false(ソロ)。永続化込み、文字起こし実行中は disabled。ソロモードでは話者バッジ・SRT の `[話者N]` プレフィックスが自動的に出ない
- **2026-05-01** 動画プレビュー上の字幕オーバーレイ — `SubtitleOverlay.tsx` を新設し、`VideoPlayer.tsx` 上に配置。プレビュー再生中もリアルタイムに字幕の見た目を確認できるようになった。ローカルフォントの `FontFace` 登録処理も `App.tsx` と `FontManagerDialog.tsx` に追加。

- **2026-05-01** 字幕プレビュー列を中央列と同じ 13px に最終調整 — 10px は読みにくいとのフィードバックで、中央列継承サイズ(`--font-size-md` = 13px)とぴったり揃える形に。両列の視覚密度が完全一致
- **2026-05-01** 字幕プレビュー列をさらに 10px に縮小 — 15px でもまだ大きいとのフィードバックで `.subtitlePreview` を `font-size: 10px !important` に。中央列 13px に対して明確に小さく、編集の視線を邪魔しないサイズに固定
- **2026-05-01** 字幕プレビュー列のサイズ調整(15px) — 中央列が `--font-size-md` = 13px なのに対し右列が 20px だったため ~1.5× 大きく見えていた。`.subtitlePreview` を `font-size: 15px !important` + `line-height: 1.4` に変更し、JSX 側の outline/shadow ratio も 15 基準にスケール。前回の「20px 指示が効かない」感覚は絶対値ではなくサイズ比の問題で、CSS 自体は正しく適用されていた
- **2026-05-01** FFmpeg 字幕焼き込みを書き出しに統合 — `src/common/subtitle.ts`(`buildAss` / `convertTimecode` / `hexToAss` / `formatAssTime` 純関数)、`src/main/export.ts` の `prepareSubtitles()` でアクティブスタイル解決 + opt-in cue チェック + `temp/jcut-subs-*.ass` 生成 + `subtitles=path:fontsdir=path` フィルタを `[concatv]subtitles=...[outv]` でチェーン。Windows パスは `\` → `/`、`:` → `\\:` で escape。フォント未インストール時等は静かに字幕なしフォールバック。`videoWidth/Height` を `loadedmetadata` で store にキャプチャして ASS の `PlayResX/Y` に渡す。**Phase A はこれで完成**
- **2026-05-01** 字幕設定 UI 実装 — `SubtitleSettingsDialog` と `FontManagerDialog` を作成。プリセット選択、カスタムスタイル作成、動的プレビュー、フォント DL 機能、キュー一覧の字幕 ON/OFF トグルを実装(Antigravity 担当)
- **2026-05-01** 字幕機能 Phase A 基盤 — `SubtitleStyle` / `SubtitleSettings` / `InstalledFont` / `AvailableFont` 等の型、`src/main/fonts.ts`(Google Fonts 厳選 12 個カタログ + DL + 一覧 + 削除)、`src/main/subtitleSettings.ts`(`userData/subtitle-settings.json` の load/save + 組み込みプリセット 5 種)、IPC ハンドラ + preload exposure を実装。`TranscriptCue.showSubtitle: boolean` 追加 + 旧 jcut.json 後方互換マイグレーション
- **2026-04-30** 再生中ハイライト(▶+赤バー)もギャップ対応に統一 — `findCueIndexForScroll` を `findCueIndexForCurrent` にリネームし、ハイライト判定セレクタからも同じ関数を呼ぶように変更。スクロールとハイライトが同一の「現在キュー」観念で動作 → ギャップ中・冒頭・末尾でも常にどこかに ▶ が出る
- **2026-04-30** シーク時のキュー一覧自動スクロール(現状不安定 → 解決) — `findCueIndexForCurrent` で **キュー間ギャップ位置** にシークしても直前のキューにスクロール、冒頭・末尾の無音位置でも先頭/末尾キューへフォールバック。再生中追従は撤廃して seek 起点の片方向プッシュ(`seekNonce`)に再設計
- **2026-04-29** 文字起こしエンジンを Gemini → Gladia に全面置換 — `@google/genai` 削除、`gladia.ts` 新設、話者分離 + custom_vocabulary 対応、`TranscriptCue.speaker` 追加
- **2026-04-29** UI 全面リデザイン — ダークテーマ + lucide-react + レイアウト再構成 + OperationsDialog 追加(Antigravity 担当)
- **2026-04-28** プレビュー再生機能(削除区間の自動スキップ) — `decidePreviewSkip` 純関数 + ExportPreview のトグル
- **2026-04-27** MVP 完成 + `v0.1.0-mvp` タグ — S5 で FFmpeg trim+concat の動画書き出し実装
- **2026-04-27** HANDOFF.md 作成 — Antigravity 引き継ぎ用の総合ドキュメント
- **2026-04-26** Gladia の前段としてのローカル Whisper → Gemini 2.5 Flash 移行(S2g)
