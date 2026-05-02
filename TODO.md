# TODO

進行中タスク・残タスク・完了済みタスクの一覧。長期的な構想は `IDEAS.md` 参照。

---

## 🚧 進行中

- **プログレッシブ DL + 並行文字起こし** — 詳細は `docs/PROGRESSIVE_DL_SPIKE_REPORT.md` 参照
  - [x] 技術検証(spike)— 4 論点完了
  - [ ] **ユーザ判断待ち**: Phase A(360p preview / 1 週間)/ Phase B(MediaSource フル / 2 週間)/ どちらで着手するか
  - [ ] **ユーザ判断待ち**: Gladia は `/v2/live` WebSocket / `/v2/pre-recorded` チャンク化 / どちらか
  - [ ] プログレッシブ DL 本実装(spike 結果 + 判断確定後)
  - [ ] 並行文字起こし本実装

- **コメント分析画面(MVP)** — 詳細は `docs/COMMENT_ANALYSIS_DESIGN.md` 参照
  - [x] yt-dlp でのチャットリプレイ取得(YouTube + Twitch)
  - [x] playboard.co での視聴者数取得(ヒューリスティックパース)
  - [x] スコア計算ロジック(瞬間スコア・初期実装)
  - [x] ClipSelectView 結線(loading/ready/error/no-source の 4 状態)
  - [x] YouTube Most replayed 風 UI (波線 + グラデ塗り) に再構成
  - [x] 波線色を背景レイヤー化(hover/drag 時のみ強調)
  - [x] **rolling window スコア + W スライダー UI**(5 要素:平均コメ密度・平均キーワード・持続率・ピーク強度・視聴者維持率、Stage 1=main bucketize / Stage 2=renderer rolling)
  - [x] **複数区間選択 + 感情 9 カテゴリ + 区間色塗り + アイキャッチ枠**(clipSegments[] 最大 20 / dominantCategory 別 path 描画 / Eyecatch 自動同期 / 区間バー drag resize+move / ClipSegmentsList で順序入替 + タイトル編集)
  - [x] **操作系整理 + 常駐ライブコメントビュー**(波形は左=シーク・右ドラッグ=区間追加、PeakDetailPanel 廃止、LiveCommentFeed 新設で chat 全件を再生位置追従・自動スクロール表示、仮想スクロール独自実装)
  - [x] **操作感改善 + 区間バー右クリックメニュー**(左クリック即時シーク / ホバー圧縮 / コメント行コンパクト化 / SegmentContextMenu)
  - [x] **AI タイトル要約(Claude Haiku 4.5)**(Anthropic BYOK、aiSummary.ts オーケストレータ、3 並列 + リトライ + キャッシュ、Settings UI 拡張、ClipSegmentsList の AI 生成ボタン)
  - [x] **切り抜き候補の自動抽出(ハイブリッド + 1 ボタン全自動)**(Stage 1 algorithm peak detection → Stage 2 AI refine → Stage 4 title generation、ClipSelectView ヘッダの ✨ ボタン + 件数 select 3/4/5 + 3-step 進捗 modal、Stage 2 キャッシュ、フォールバック付き)
  - [ ] **次**: アイキャッチの実体動画化(FFmpeg で黒画面 + テキスト合成)
  - [ ] 編集画面での clipSegments 適用
  - [ ] アイキャッチの実体動画化(FFmpeg で黒画面 + テキスト合成)
  - [ ] 自動候補抽出ボタン(上位 N 区間を一括追加)
  - [ ] スコア重み調整 UI(現状ハードコード)
  - [ ] edit フェーズで clipSegments を使った動画範囲絞り込み(Timeline/VideoPlayer 連携)
  - [ ] ProjectFile への clipSegments / eyecatches 永続化


---

## 🔵 次にやる(MVP 直近候補)

(現在進行中へ移動)

---

## 🟡 検討中(優先度未確定)

- **字幕パディング**(前 100ms / 後 300ms) — キュー境界が読み終わる前に消える対策
- **無音区間自動マーク** — VAD で無音区間を検出して自動的に削除候補化
- **キューの手動分割** — 1 キュー内で話者が変わる場合の分割対応(現状は 1 キュー = 1 話者前提)
- **範囲選択での一括ドラッグ&ドロップ話者変更** — 複数キュー選択 → まとめてカラム移動。現状はカード単位の DnD のみ
- **キュー個別のスタイル変更** — 行ごとに異なるプリセット選択やカスタムスタイル(Phase B-3 で部分対応済み、UI 磨きの余地あり)

---

## 📋 未着手(優先度順)

### High

- **503 自動リトライ(Gladia 含む)** — API 側の高負荷時の指数バックオフ。`gladia.ts` の `submitJob` / `pollResult` でラップ
- **Gladia API 実機検証** — フィールド名(`audio_url` / `result_url` / `utterances`)等が想定通りかを実物で確認、必要に応じて defensive parsing を強化
- **未対応コーデック動画への対応** — H.265 / mkv 等を MediaSource 経由で再生可能に(LosslessCut の compatPlayer.ts 参考)

### Medium

- **波形表示** — Timeline に音声波形をオーバーレイ。編集ポイントの判断補助
- **ズーム機能** — 長時間動画の特定区間を細かく編集できるよう、Timeline の横スクロール + 倍率変更
- **スクラブ(ドラッグでシーク)** — Timeline つまみドラッグでリアルタイム動画シーク
- **空状態(empty state)のデザイン磨き** — DropZone・キュー一覧未生成時のヒント / イラスト
- **ローディング・トランジションの洗練** — フェーズ切替アニメーション、ボタン押下フィードバック

### Low

- **単語単位編集** — 1 キュー内の特定単語だけ削除(Gladia の word-level timestamps があれば実装可能)
- **キャラ名自動補完** — TranscriptionContextForm でゲーム名から候補表示
- **設定永続化拡張** — `previewMode` / FFmpeg パス / 出力品質などをユーザ設定に
- **ダーク/ライトテーマ切替** — 現状ダーク固定、`prefers-color-scheme` 連動 + 設定切替
- **音声フェードイン/アウト** — プレビュー再生時のスキップでの瞬断対策

---

## 🟢 将来(`IDEAS.md` 参照)

長期構想 — 「動画の中身を理解する編集ソフト」方向。順次実装していく:

- 配信アーカイブ → 自動動画化(URL → 動画完成までの完全自動)
- 盛り上がり検出 AI(コメント分析画面の発展形)
- 感情波形タイムライン
- 神回検出 AI / 視聴維持率シミュレーター
- 伏線検出 AI / 空気転換点検出 / 会話密度解析
- 編集者プロファイル学習 / 動画役割分析
- コメント予測 AI / 配信者疲労検出 / 神タイミング SE 提案 / 切り抜きタイトル生成
- 学習する話者プロファイル(声紋から自動推定、過去動画の話者を自動アサイン)
- コメントヒートマップ(IDEAS.md 内では「盛り上がり検出 AI」に統合)

詳細・優先順は `IDEAS.md` を参照。

---

## ✅ 完了済み(直近)

### 2026-05-02

- 切り抜き候補の自動抽出(ハイブリッド方式 + 1 ボタン全自動) — `peakDetection.ts` で Stage 1(rolling score 全位置 → ローカル極大値 → ±30s バッファ + score≥0.30 + W 間隔 dedup → top 10)、Claude Haiku で Stage 2(候補 10 → ベスト N、起承転結 / ネタバレ性 / 反応質を基準に JSON 出力)、Stage 4 で既存 `generateSegmentTitles` 流用してタイトル生成。ClipSelectView ヘッダに ✨ ボタン + 件数 select + 3-step 進捗 modal。Stage 2 キャッシュ + フォールバック(API 失敗時はスコア順)。サンドボックス合成データの smoke test で peak detection の正確性 + edge buffer フィルタリング動作を確認
- 動画音声不再生バグの **真の** 根本原因特定・修正 — `6.mp4` を `ffprobe` で実調査した結果、4cca71f の仮説(Opus codec)は誤りで、**真因は yt-dlp の `--skip-unavailable-fragments` デフォルト挙動** で audio fragment 部分 DL 失敗時に partial audio を merger に渡して silent truncation していた(動画 158.6 分 vs 音声 16.1 分)。`--abort-on-unavailable-fragment` + `--retries 30 --fragment-retries 30` + post-DL ffprobe validation(±5 秒の duration mismatch を hard error 化)を追加。4cca71f の format selector + AAC postprocessor + audioTracks enable は defense in depth で温存
- 動画音声不再生バグの **当初** 根本修正(format selector + AAC postprocessor) — 後の調査で目当ての仮説が外れていたと判明、ただし副次的な防御策として温存(Opus-in-MP4 等の codec ケース対応)
- LiveCommentFeed 行密度再調整(40 → 32 px) — ROW_HEIGHT 32、padding 3/10、font 12px、line-height 1.3、時刻列 44px。Part A 後の実機確認でまだスカスカ感
- AI タイトル要約(Anthropic Claude Haiku 4.5 統合) — `secureStorage` を Gladia/Anthropic 2 スロット化、`aiSummary.ts` を新設(3 並列 + 429/5xx リトライ + per-request 30 秒タイムアウト + AbortController キャンセル)、`userData/comment-analysis/<key>-summaries.json` キャッシュ(2 桁丸めキーで sub-frame ドリフト吸収)、Settings UI を Gladia/Anthropic 2 セクション化、ClipSegmentsList に「AI でタイトル生成」ボタン + 進捗表示。1-token validation ping で キー検証。プロンプトは「15 文字以内のキャッチータイトル、ネタバレ歓迎」。区間→bucket-message slicing は ClipSelectView 側
- 操作感改善(左クリック即時シーク + ホバー圧縮 + コメント行コンパクト化 + 区間バー右クリックメニュー)— mousedown 時点で即発火 + RAF coalesce、ツールチップを 4 行 → 1 行(`時刻 · スコア · 件数`)、ROW_HEIGHT 60→40 + author 列削除、`SegmentContextMenu` 新規(削除 / タイトル編集 → 編集はリストの inline 編集を発火 + scrollIntoView)
- 操作系整理(左右クリック分離)+ ピーク詳細廃止 → 常駐ライブコメントビュー — 波形の左クリック = シーク、左ドラッグ = ライブシーク、右ドラッグ = 区間追加(リリース時に自動 add)、右クリック単発 = no-op(`onContextMenu` 抑制)。`PeakDetailPanel` 削除、ClipSelectView 右側に `LiveCommentFeed`(常駐、独自仮想スクロール、現在位置追従、コメントクリックでシーク、キーワードを薄い色付き下線でハイライト)。`CommentAnalysis.allMessages` 追加で全 chat を再生位置基準に binary search できるように。「この区間を編集範囲に設定」ボタン廃止 → ヘッダの「この区間を編集」一本に統一
- 複数区間選択 + 感情 9 カテゴリ + 区間色塗り + アイキャッチ枠 — 旧 `clipRange` 単区間を撤廃して `clipSegments[]`(最大 20)+ 自動同期する `eyecatches[]` に作り直し。感情カテゴリを 5→9 へ拡張(death/victory/scream/flag 追加、ゲーム実況の死亡フラグ・GG・察し等を語彙化)。波形には dominantCategory 別の薄い色塗り(両端フェード gradient で seam 隠し、白線は固定)+ 区間オーバーレイバー(端ドラッグ resize / 中央 move / 隣接 clamp)。区間カードのドラッグ順序入替・タイトル inline 編集・アイキャッチ skip toggle を持つ `ClipSegmentsList` を新設。`PeakDetailPanel` は「設定」から「追加」へ動線変更、連続追加 OK
- コメント分析: rolling window スコアに作り直し + W スライダー UI 追加 — 旧「5 秒バケット瞬間スコア」を「W 分続いた盛り上がり」へ。5 要素(平均コメ密度・平均キーワード・持続率・ピーク強度・視聴者維持率)、W=30 秒〜5 分(30 秒ステップ、初期値 2 分)。Stage 1(`bucketize`、main 1 回)と Stage 2(`computeRollingScores`、renderer 都度)に分解、スライダー操作時の体感ラグを排除。`RawBucket` 型新設、`ScoreSample` 構造刷新、`CommentAnalysis.samples` 廃止 → `buckets[]` 保持。視聴者は維持率(min/max)1 軸へ統一(growth rate 廃止)。`src/common/types.ts` / `src/main/commentAnalysis/scoring.ts` / `src/renderer/src/lib/rollingScore.ts`(新規)/ `src/renderer/src/components/{WindowSizeSlider,CommentAnalysisGraph,ClipSelectView,PeakDetailPanel}` / `src/renderer/src/store/editorStore.ts`
- 緊急修正: ClipSelectView の `onDuration`/`onCurrentTime` 未配線 — 3 症状(`<video>` コントロール消失 + 再生ボタンで末尾に飛ぶ + 分析グラフ真っ黒)の共通根本。`durationSec` が clip-select 中ずっと null のままで、preview-skip ロジックが `decidePreviewSkip='end'` を返したり、mock fallback が samples=0 を生成していた。`1678746`(ClipSelectView 新設)時点からの抜け漏れ、`1533d31`(実分析)で表面化。副次的に mediaProtocol と commentAnalysis にログ追加
- コメント分析: 実データ取得 + スコア計算ロジック実装 — yt-dlp チャットリプレイ(YT live_chat / Twitch rechat)+ playboard.co スクレイピング + ハードコード辞書 + 5 秒バケット 3 要素統合スコア。`src/main/commentAnalysis/*` を新設、IPC 統合済み、ClipSelectView がモック→実分析に切替(失敗時はモック fallback)。`editorStore.sourceUrl` 追加、URL DL 完了時に capture
- プログレッシブ DL + 並行文字起こしの技術検証(spike) — 4 論点(yt-dlp シーク追従 / `<video>` buffered / Gladia 並行 / プロセス管理)を実機 + 公式ドキュメントで検証、`docs/PROGRESSIVE_DL_SPIKE_REPORT.md` にまとめた。本実装は未着手、設計選択肢をユーザ判断待ちにエスカレート
- URL DL 進捗 0.0% 固着の真因を実機ログで特定 → `--progress` 追加 — yt-dlp は `--print` 指定時に暗黙 quiet モードに入り、`--progress-template` 単独ではテンプレートを使うだけで出力自体は抑制されたまま。`--progress`(quiet モードでも進捗を強制表示するフラグ)を明示追加で解決。生 stdout に `JCUT_PROGRESS` 行が流れることを実 DL で確認
- URL DL バグ修正(進捗 0.0% 固着 + DL 後動画再生不可) — yt-dlp 引数に `-f bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best` + `--progress-template` を追加。Chromium 互換 mp4-avc1-aac 強制 + 進捗パースの安定化(※ 後続コミットで `--progress` 追加も必要だったことが判明)

### 2026-05-01(連続セッション、新しいものが下)

- 字幕機能 Phase A 基盤(型定義 + フォント管理 + 設定永続化)
- 字幕設定 UI 実装(SubtitleSettingsDialog + FontManagerDialog)
- FFmpeg 字幕焼き込みを書き出しに統合 — **Phase A 完了**
- 字幕プレビュー列のサイズ調整(20px → 15px → 10px → 13px に最終確定、中央列 13px と一致)
- 動画プレビュー上の字幕オーバーレイ(SubtitleOverlay)
- 話者分離有効化トグル(コラボモード)実装 — **Phase B-1**
- コラボトグルのデザイン刷新(iOS 風スイッチ + 「マルチ」リネーム)
- 話者カラム表示モードの実装(リニア / 話者カラム切替、2D キーボードナビ)
- 話者数指定 UI で Gladia 話者分離精度を向上(`diarization_config` 送信)
- 話者ID 手動修正 UI(SpeakerDropdown)— **Phase B-2**
- 話者ごとの字幕スタイル・プリセット機能(SpeakerPreset)— **Phase B-3**
- 字幕設定・話者プリセット機能の細部修正(Phase 1 完全完了)
- 字幕機能 Phase 2(StylePreset + キュー単位上書き)
- 字幕機能 UI/UX 細部修正(バッジ簡略化、字幕スタイル即時反映、ヘッダ編集可能化)
- UI 整理(ヘッダ・操作一覧の不要要素削除、ファイル名はウィンドウタイトルへ)
- 話者カラム表示でドラッグ&ドロップ話者変更
- DnD 操作性改善(カード全体を drag source 化)
- URL 動画ダウンロード機能(yt-dlp 統合、YouTube + Twitch 対応、利用規約同意フロー、画質選択)
- DropZone に URL DL 機能を統合(動線一本化、ヘッダの DL アイコン削除)
- 3 フェーズ構造への再編 (Load -> Clip Selection -> Edit)
- コメント分析グラフ UI (モックデータ、ドラッグ選択、簡素化版)

### 2026-04-30 以前

- 再生中ハイライト(▶+赤バー)もギャップ対応に統一(`findCueIndexForCurrent`)
- シーク時のキュー一覧自動スクロール解決(`seekNonce` 起点片方向プッシュ)
- 文字起こしエンジンを Gemini → Gladia に全面置換
- UI 全面リデザイン(ダークテーマ + lucide-react)
- プレビュー再生機能(削除区間の自動スキップ)
- MVP 完成 + `v0.1.0-mvp` タグ
- HANDOFF.md 作成
- ローカル Whisper → Gemini 2.5 Flash 移行

詳細な背景・設計判断は `DECISIONS.md` を時系列で、各コミットの差分は `git log <hash>` を参照。
