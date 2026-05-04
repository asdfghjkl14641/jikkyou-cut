# TODO

進行中タスク・残タスク・完了済みタスクの一覧。長期的な構想は `IDEAS.md` 参照。

---

## 🎯 次セッション最優先(2026-05-04 朝)

詳細は `NEXT_SESSION_HANDOFF.md` の「明日のタスク優先順位」を参照。

| 優先 | 内容 |
|---|---|
| 1 | **回線回復確認** — YouTube DL 速度測定。50 MB/s 以上で 2 へ、1 MB/s 以下なら待機 |
| 2 | **Bug 1: YouTube audio-first 経路で commentAnalysisStatus が loading 永続化** — URL=T6pxHw4gUzs で再現済、ログ取得済、真因未特定。debug ログを参照しながら真因特定 → 修正 |
| 3 | ~~**Bug 2: Twitch チャット取得 yt-dlp `--sub-langs rechat` が HTTP 404**~~ ✅ **2026-05-03 段階 7 で解決**(GraphQL 直接実装に変更) |
| 4 | **debug ログ一括撤去** — Bug 1 解決後。`[comment-debug:app/store/clip]` + main 側 `[comment-debug] / [comment-debug:main]` を全削除(Twitch GraphQL 側の `[comment-debug] twitch graphql ...` も同タイミングで撤去) |

### ⚠️ debug ログを削除しないこと(明日まで残置)

renderer 側 + main 側に `[comment-debug:*]` が残置中。Bug 1 の再現 + 真因特定に必要なため、優先 4(明日のタスク後半)まで削除しない。該当ファイル一覧は `NEXT_SESSION_HANDOFF.md` 参照。

---

## 🆕 進行中の新機能シリーズ:配信者自動録画

Twitch 配信者を登録 → 配信開始を検知 → yt-dlp で自動録画する機能。詳細は DECISIONS.md(2026-05-03 段階 X1 エントリ)+ IDEAS.md「配信アーカイブ → 自動動画化」参照。

| 段階 | 内容 | 状態 |
|---|---|---|
| X1 | Twitch + YouTube 配信者登録 UI(Gemini 検索 / メイン画面 / 確認ダイアログ) | ✅ 2026-05-03 |
| X2 | 配信検知ポーリング(Twitch streams.list batch + YouTube RSS + videos.list?liveStreamingDetails、1 分毎、配信開始/終了イベント) | ✅ 2026-05-03 |
| X3.5 | タスクトレイ常駐(✕ で hide、シングルインスタンス、Windows 自動起動 + `--minimized`、tray live indicator) | ✅ 2026-05-04 |
| X3+X4 | 配信録画(yt-dlp `--live-from-start`、Streamlink オプション)+ VOD 取り直し(Twitch helix archive / YouTube actualEndTime ポーリング)+ メタデータ駆動 + 録画済み動画 UI + 編集画面連携 + 規約警告 | ✅ 2026-05-04 — **自動録画機能シリーズ完成** |
| 補完 | streamMonitor → streamRecorder の subscriber race 修正 + 詳細 debug logs(`[stream-recorder:debug]`) | ✅ 2026-05-04 |
| 補完 | `[twitch-poll]` debug logs(querying / response / missing)+ Twitch user_id 再取得ボタン | ✅ 2026-05-04 |
| 補完 | OS スリープ防止(`powerSaveBlocker prevent-app-suspension`、reference-counted、UI トグル) | ✅ 2026-05-04 |
| 補完 | 録画 subprocess の `before-quit` shutdown フック(ゾンビ yt-dlp プロセス漏れ対策、`writeMetadataSync` で確実なメタ commit) | ✅ 2026-05-04 |
| 補完 | 配信者カードにフォロワー / 登録者数 + 開設日表示(impostor 判別)+ 手動入力フォールバック UI(Twitch login / YouTube `@handle` or `UCxxx` 直接) | ✅ 2026-05-04 |
| 補完 | 開設日表示削除 + フォロワー数による品質警告(`< 1K` 🚨 critical / `< 10K` ⚠ low、確認ダイアログで強警告) | ✅ 2026-05-04 |
| 🚨 緊急修正 | Twitch 録画 0 B バグ(`--live-from-start` を YouTube 専用に分岐)+ cookies 統合(`getCookiesArgs` を recordSession にも threaded) | ✅ 2026-05-04 |
| 🔒 事故再発防止 | API キー ハイブリッド保存(暗号化 .bin + Documents 平文 JSON バックアップ + read-back verify + 自動復元)+ JSON エクスポート/インポート + UI(API 管理画面トップに backup banner / import-export ボタン / import preview ダイアログ) | ✅ 2026-05-04 |
| 🔍 検索品質向上 | 配信者検索のハイブリッド化(Gemini 主導 → 失敗時 Twitch `/helix/search/channels` + YouTube `search.list` フォールバック)+ 5 分キャッシュ + データソース badge(✓ Gemini / ⚠ API / 👤 手動)+ follower 降順ソート | ✅ 2026-05-04 |
| 🔍 検索品質向上 | API fallback 結果のフォロワー / 登録者数足切りフィルタ(default 20 万、`AppConfig.searchMinFollowers`)+ 閾値プリセット UI + 0-hit 時の閾値緩和ボタン(Gemini / 手動入力は閾値無視) | ✅ 2026-05-04 |
| 🛡️ 録画継続堅牢化 | yt-dlp 早期終了の自動再起動(probeIsStillLive 経由 + ファイル名ローテーション + max 5 回)+ process tree kill(`taskkill /F /T` で orphan ffmpeg 防止)+ streamMonitor の 3 連続 missing 判定で API blip 誤停止防止 + UI に「N ファイル分割」表示 | ✅ 2026-05-04 |
| 🎬 メイン画面 UX | 「新着動画」セクション(load phase の DropZone 下、24 時間以内の auto-record + URL DL 統合フィード、クリックで編集画面へ遷移、録画継続中は警告 + 録画中バッジ) | ✅ 2026-05-04 |
| 🎞️ 編集互換性 | 録画ファイルを編集可能な MP4 で出力(yt-dlp `--merge-output-format mp4` + Twitch のみ avc1+m4a 強制 + 完了後 ffprobe 検証 → ffmpeg `-c copy` で remux + VP9/AV1 は incompatible 警告) | ✅ 2026-05-04 |
| 🎞️ 編集互換性 | 録画ファイル名から `.live` / `.vod` 二重拡張子を削除(`<id>.mp4` / `<id>.001.mp4` / `<id>_vod.mp4`)+ boot 時の自動マイグレーション(ファイル rename + メタ JSON sync、idempotent)。Windows Media Player 0x80070323 エラー対策 | ✅ 2026-05-04 |
| 🖼️ 新着動画 UX | サムネ表示バグ修正(`media://` URL を VideoPlayer と同フォーマット `localhost/<encoded>` に統一、drive letter ロスト解消)+ ffmpeg 生成の堅牢化(0 byte 検知 / 5 MB 未満 skip / 失敗 5 分 TTL キャッシュ / `-update 1` for FFmpeg 8) | ✅ 2026-05-04 |
| 🐛 URL DL Twitch | audio DL が Twitch VOD で「Requested format is not available」exit 1 で死ぬ問題を修正(Twitch は `Audio_Only` literal id、YouTube は既存 codec id chain で分岐) | ✅ 2026-05-04 |
| 🐛 URL DL Twitch 401 | cookies の platform mismatch で 401 になる問題修正(汎用 cookies のパスに `youtube` / `twitch` 名が入ってると要求 platform で剥がす + browser fallback)。`getCookiesArgs` に path heuristic ガード | ✅ 2026-05-04 |
| ⚡ URL DL 並列化 | audio + video の真並列起動(`downloadVideoOnly` の sessionId を optional 化 → renderer が audio await 前に fire)。Twitch 11h VOD で 17+17=34 分 → max(17,17)=17 分の 2x 改善 + 401 エラー文面に cookies 再エクスポート誘導追加 | ✅ 2026-05-04 |
| ⚡ URL DL 並列化 | comment 取得も audio から独立(`fetchUrlMetadata` で `durationSec` 先行取得 → metadata.then で commentAnalysis fire)+ 4 段進捗 UI(audio / video / comment / scoring の waiting/active/done 状態表示)+ ClipSelectView に scoring 進捗ストリップ | ✅ 2026-05-04 |
| 🐛 Twitch chat 1 ページバグ | comment 取得が page 1 で integrity check fail → 53 件で完了する真因 D 確定。`Authorization: OAuth <auth-token>` ヘッダ追加 + integrity の soft retry + cache poisoning guard(`complete=true` の時だけ cache 書く)| ✅ 2026-05-04 |
| X5 | YouTube ライブ検知精度向上(scheduledStartTime 活用、ライブ予定リマインド) | 将来 |
| Streamlink 同梱 | `resources/streamlink/streamlink.exe` を手動配置(現状 yt-dlp フォールバックで動作) | ユーザ手動 |
| 録画 自動削除 | N 日経過後の自動クリーンアップ | 将来 |
| WebSub / EventSub | ポーリングから push 型に移行(秒オーダーの検知遅延短縮) | 将来 |

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
  - [x] **データ収集パイプライン Phase 1(蓄積基盤)**(better-sqlite3 + YouTube Data API + yt-dlp で切り抜き動画メタ + heatmap 上位 3 ピーク + chapters + サムネを蓄積。Settings UI に API キー(複数)+ 配信者リスト + ステータス表示。1 時間ごとのバックグラウンド収集、起動 5 秒後にスタート)
  - [x] **配信者 40 人 seed + 検索クエリ多角化**(VTuber 25 + ストリーマー 15、3 クエリ/人、channelId 自動解決、creator_group カラム)
  - [x] **uploaders テーブル分離 + creators 純化(migration 001)**(切り抜き投稿者を別テーブル化、Phase 2 のジャンル別集計に備える)
  - [ ] **次**: ユーザがデータ収集を有効化 → 1 週間放置 → 1 万件規模 → Phase 2 着手判断
  - [ ] データ収集 Phase 2(蓄積データの分析、サムネ + タイトルパターン抽出、creators × uploaders のクロス分析)
  - [ ] データ収集 Phase 3(分析結果を ClipSelectView の自動抽出にフィードバック)
  - [ ] アイキャッチの実体動画化(FFmpeg で黒画面 + テキスト合成)
  - [ ] 編集画面での clipSegments 適用
  - [ ] アイキャッチの実体動画化(FFmpeg で黒画面 + テキスト合成)
  - [ ] 自動候補抽出ボタン(上位 N 区間を一括追加)
  - [ ] スコア重み調整 UI(現状ハードコード)
  - [ ] edit フェーズで clipSegments を使った動画範囲絞り込み(Timeline/VideoPlayer 連携)
  - [ ] ProjectFile への clipSegments / eyecatches 永続化


---

## 🔵 次にやる(MVP 直近候補)

- **✅ 動画 DL 高速化 5 段階再設計(全段階完了)+ 段階 6a 並列化追加**
  - 段階 1 ✅ 完了: yt-dlp `--concurrent-fragments 8` + ベンチログ(2026-05-03)
  - 段階 2 ✅ 完了: 音声優先 DL + AI 抽出早期実行(2026-05-03)
  - 段階 3 ✅ 完了: YouTube/Twitch 埋め込みプレイヤー導入(2026-05-03)
  - 段階 4 ✅ 完了: 編集中のプレイヤー切替ロジック(2026-05-03)
  - 段階 5 ✅ 完了: Twitch 動作確認 + 微調整(2026-05-03)
  - 段階 6a ✅ 完了: URL 入力時の並列化(コメント分析 + グローバルパターン)(2026-05-03)
  - 段階 6b ✅ 完了: yt-dlp `--cookies-from-browser` 統合(YouTube bot 検出回避 + 認証必要動画対応)(2026-05-03)
  - 段階 6c ✅ 完了: cookies.txt ファイル直接指定(ブラウザクッキー全滅環境向け、優先度: ファイル > ブラウザ)(2026-05-03)
  - 段階 6d ✅ 完了: format selector 緩和 + `--js-runtimes node` 全経路適用(2026-05-03)
  - 段階 7 ✅ 完了: Twitch チャット GraphQL 直接実装 + cookies プラットフォーム別分離(2026-05-03)
  - 段階 8 ✅ 完了: Twitch クッキー認証 + 波形低密度プレースホルダ + 自動スクロール race 修正(2026-05-03)
  - **残課題**(発覚時に別タスク化):
    - prod build (`file://`) での Twitch 埋め込み拒否対策(custom protocol / localhost bridge)
    - Twitch ライブ配信中の取得対応(段階 7 は VOD のみ対応)
    - Twitch サブスク限定 VOD の認証対応 — 段階 7 で `ytdlpCookiesFileTwitch` フィールドは追加済、あとは `fetchTwitchVodChat` に `Cookie:` ヘッダ送る経路を作る + Settings UI で「Twitch サブスク認証用」ヒントを足す
    - **Twitch GraphQL persisted query hash の rotation 対応** — `PersistedQueryNotFound` エラーが出たら `twitchGraphQL.ts` の `VIDEO_COMMENTS_QUERY_HASH` を yt-dlp 最新値とすり合わせる(現状は手動)
    - **Twitch GraphQL Client-Integrity トークン実装** — クッキー認証で integrity check が突破できなくなった場合の備え。yt-dlp の Twitch 抽出器で Client-Integrity 取得フローを参照、`gql.twitch.tv/integrity` から短命トークンを取得 → Client-Integrity ヘッダで送る。**現状はクッキーで通るので未実装、退化したら着手**
    - cookies.txt の有効期限切れ検出 + 「The provided YouTube account cookies are no longer valid」警告のハンドリング
    - クッキーローテーション対応(複数 cookies.txt 切替)— YouTube 側仕様の影響を受ける、根本解決困難なため当面静観
    - WebM 出力増による export.ts 互換性チェック(VP9-in-MP4 → 編集 → 再 export)
    - 動画 DL 完了通知の永続表示(現状 toast 3 秒のみ)
    - DL 完了前から動画再生可能に(`<iframe>` で YouTube / Twitch 埋め込み)
    - 「DL 中でも切り抜き範囲を選び始められる」体験
    - 設計判断: 埋め込みプレイヤーから `currentTime` を取得する postMessage / Player API、コメント分析グラフとの時刻同期、Twitch の VOD ID 抽出
  - **段階 4: 編集中のプレイヤー切替ロジック**(埋め込み ↔ ローカル動画)
    - DL 完了 → 自動で埋め込みからローカル MP4 に切替
    - 切替時の現在再生位置維持
    - 編集モードはローカル動画必須(範囲指定の精度)
  - **段階 5: Twitch 動作確認 + 微調整**
    - YouTube 中心の改修だった既存パスを Twitch でも検証
    - HLS の挙動差(fragment の細かさ・rate limit)、chat replay の取得方法差
    - 必要なら quality 選択 UI / format selector を Twitch 専用化

- **Phase 2b: パターン分析の自動再実行トリガー**
  - 蓄積数が前回分析時から +500 件超えたら自動で `runPatternAnalysis` を呼ぶ
  - 起動時 + batch done 時に判定
  - 現状は手動ボタンのみ(API 管理画面の「パターン分析を実行」)

- **Phase 2 残りパターン**
  - `viewVelocity`(再生数 / 経過日数)
  - `thumbnailPatterns`(顔検出 / 色分布 / OCR テキスト数)— 画像処理依存で重い、別タスク化
  - `chapterPatterns`(useChapters 比率 / 頻出 chapter title)
  - `topVideos`(上位 N 動画のスナップショット、AI プロンプトでサンプル提示用)

---

## 🟡 検討中(優先度未確定)

- **AI 抽出キャッシュのクリア手段** — 設定画面に「キャッシュをクリア」ボタン追加。現状 `userData/comment-analysis/<videoKey>-extractions.json` および `-summaries.json` は永続(TTL なし)で、強制再抽出する手段が UI に存在しない。M3 以降の設定 UI 整備時に統合実装
- **AI 抽出のフィードバック保存** — ユーザが「採用 / 却下」した結果を蓄積し、将来のプロンプト精緻化や個人パターン学習(IDEAS 12)に流用。型は `aiConfidence` のスロットだけ既に確保済み。M3 以降
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

- **Gemini キーの正確な quota 取得手段(Cloud Billing API 等)** — 現状の `gemini_request_log` は自前カウントの概算で、AI Studio dashboard の実値とズレ得る(別アプリ / 同じキーの別経路の呼び出しは検知不能)。Cloud Billing API / Cloud Monitoring API で正確値を引ける可能性があり、運用 1 ヶ月後にズレ幅を観察してから着手判断
- **Gemini キーごとの命名機能** — 現状はインデックス順「キー 1 / キー 2」表示のみ。「メイン用」「サブ用」「テスト用」のような名前を付けられると 50 キー運用時に管理しやすい。YouTube も未対応、両側で同時に検討
- **動画読み込み時の自動 Gemini 先読み** — 現状はボタン押下時に extract → upload → analyze を全部走らせるので 1-3 分待たされる。動画読み込み完了タイミングで裏でこれらを走らせておけば、ユーザがボタンを押した瞬間に refine だけ走って即返る UX に。リスク: ユーザが分析を実行しないかもしれない動画でも quota を消費する → 動画長 N 分以上のみ先読み等のヒューリスティックが必要
- **Gemini timeline summary の UI 可視化** — 現状は AI プロンプトに渡すだけでユーザに見せていない。動画上部の細い帯で "0:00-3:00 配信開始挨拶 / 3:00-20:00 ゲームプレイ" のような構造を表示すれば、ユーザが「どこから見るか」判断しやすくなる。`GeminiAnalysisDialog` を再活用するか、CommentAnalysisGraph に重ねる帯の形か検討
- **Gemini モデル選定の運用後再評価** — 現状 `gemini-2.5-flash` を選択(2026-05-03 時点)。無料枠が 500 RPD と窮屈、運用 1 ヶ月後に消費ペースを観察して以下を判断: (1) 2.5-flash-lite への退避(reasoning 質トレードオフ)/ (2) 3-flash 系が出たら移行 / (3) thinkingBudget で latency と品質のバランス調整 / (4) 無料枠縮小傾向への対応(API キー追加運用)
- **コンテンツ語抽出の拡張(tf-idf / 配信者別併用)** — 現在の global.json は単純頻度 + viewBoost フィルタなので、コンテンツ語(神回 / 発狂 / APEX 等)が hashtag / SEO 語に埋もれて出てこない。tf-idf 化して各配信者の特徴語を抽出するか、配信者別パターンと併用するかで意味的キーワードを浮上させる。Phase 2 残りタスクの一環として位置付け
- **quota 80% 超え時の UI 通知ポップアップ** — 現状はログのみ(`batch summary` 後に `⚠ quota at X% — consider adding new API keys` を出す)。Settings UI のトースト or バッジで気付きやすくする。本格運用 1 週間目以降の課題
- **SLEEP_TIERS 閾値の調整(運用 1 週間後にデータドリブンで再評価)** — 初期値は 3/10/20/30 min × 20%/10%/5%/0%。実際の新規率分布を `batch summary` ログから集計して、「20% 以上が滅多に出ない」or「3 分間隔が頻発しすぎ」等の偏りが見えたら閾値調整。運用 1 週間 ~ 1 カ月後を目安
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

- データ収集の最終検証 + 運用 Runbook 整備(`cd30fda` + 後続 docs)— 直前 migration 後に発覚した NULL group 2 件(ぶゅりる / 剣持刀也)を `reseedGroupsForExistingCreators()` で恒久解決(SEED_CREATORS を source-of-truth として毎起動 sync、冪等)。`seedOrUpdateCreators` の早期 return を撤去して reseed が必ず走るように。`diagnose.ts` に Q3b(NULL group 名一覧)+ Q15-Q17(直近 1h の videos / uploaders / creators 増加検出 — Q17 が >0 なら `⚠ AUTO-ADD REGRESSION SUSPECTED` 警告)。本格運用前のチェックリスト + 監視ポイント + トラブル対処を `docs/DATA_COLLECTION_OPS.md` に Runbook 化。実機検証で全 75 件 group 設定済み(nijisanji=20 / hololive=15 / vspo=15 / neoporte=5 / streamer=20、NULL=0)を確認
- データモデル根本修正:uploaders テーブル分離 + creators 純化(`280ad6c`)— 直前診断で確定した「creators 325 = seed 75 + auto-add 切り抜き投稿者 250」を 2 テーブル分離。新 `uploaders` テーブル(channel_id / channel_name UNIQUE / video_count キャッシュ)、`videos.uploader_id` 追加、`migrations.ts` で `PRAGMA user_version` 管理 + WAL checkpoint + .bak 自動生成 + 単一トランザクションで安全に移送。`_collectBatch` の broad-search 由来 `upsertCreator` 経路を撤廃し、`upsertUploader` で uploader 登録 + `getCreatorIdByName` で per-creator hint のみ creator_id 解決。UI は「配信者(seed): 75」「切り抜きチャンネル: 252」を併記。実機検証で creators 325→75 / uploaders 0→252 / videos 347 全件 uploader_id 紐付け / バックアップ 2 個確保 を確認
- 緊急修正: better-sqlite3 ネイティブモジュール読み込み失敗の再発防止(`5160da8`)— ユーザ実機 `collection.log` で 09:29Z〜10:11Z に 7 件発生していた `Could not dynamically require "<root>/build/better_sqlite3.node" / @rollup/plugin-commonjs` エラーを調査。**10:11Z 以降は INFO のみで自然回復済み**(transient なビルドキャッシュ破損が真因と確定)。`out/` クリーン rebuild + `npx @electron/rebuild -f -w better-sqlite3` で現状の bundle / `.node` を確認し、念のため `electron.vite.config.ts` の `main.build.rollupOptions.external` に `better-sqlite3` と `bindings` を明示ピン(belt-and-braces)。`externalizeDepsPlugin` は direct deps のみ externalize するため transitive の `bindings` が bundled される一瞬があり得るので、それを物理的に防ぐ。なお「動画 347 件 / 配信者 325 件」表示はエラー停止後の正常 batch で蓄積されたデータ
- データ収集の制御ボタン整理 + npm run dev 必須を CLAUDE.md に明文化(`c54ba71` + `b95240b`)— ボタン名「今すぐ実行」→「1 回だけ取得」リネーム、「取得を停止」ボタン新設(進行中バッチを永続状態を変えずにキャンセル)。Manager に `cancelCurrentBatch()` + `nextBatchAt`(待機時間表示用)+ `isBatchActive`(IPC 公開)。UI ステータス表示も優先度刷新(取得中 → 待機中(次まで N 分)→ 停止中 等の 4 way)。並行で **`npm run start` で古いビルドを掴む事故対策** に CLAUDE.md 冒頭(概要より上)へ「⚠️ アプリ起動時の絶対ルール」セクション追加(✅ `npm run dev` / ✅ `npm run dev:fresh` / ❌ `npm run start` / 古い electron プロセス掃除コマンド)+ package.json に `dev:fresh` script 追加(node -e で out/ を消してから dev、外部依存なし)
- 配信者リスト 40 → 75 拡張(`cde28b0`)— ユーザ精査最終リストを反映:にじ 20 / ホロ 15 / ぶいすぽ 15(新グループ)/ ネオポルテ 5(新グループ、★ 柊ツルギ含む)/ ストリーマー 20。`CreatorGroup` 型に `'vspo'` / `'neoporte'` 追加。`seedCreatorsIfEmpty` → `seedOrUpdateCreators`(差分マージ)に進化:既存名は触らず channelId / 順序を保持、既存 group が null なら seed の group を backfill(`setCreatorGroupIfNull`)、新規名のみ append。サイクル間隔 1h → 2h(75 × 3 = 22.5K/サイクル相当のクォータ消費を 12 サイクル/日 = 285K/日 で予算余裕)。creator の全 3 クエリで 0 件ならログ警告(neoporte 等の流動箱の表記揺れ検出用)
- 配信者 40 人 seed 投入 + 検索クエリ多角化 + channelId 自動解決(`16535eb`)— ユーザ精査リストを `seedCreators.ts` に定数化(にじさんじ 15 + ホロライブ 10 + ストリーマー 15)、初回起動時に creators.json + DB へ冪等投入。creators テーブルに `creator_group` カラム追加(`PRAGMA table_info` で既存 DB にも安全 migration)、per-creator クエリを切り抜き / 神回 / 名場面の 3 クエリへ多角化、初回バッチで `searchChannelByName`(search.list type=channel、100u/人)を使って channelId を一括解決し永続化。クォータ見積 ~13.25K/サイクル(初回のみ +4K)で 50 キー × 10K/日 = 500K に対し余裕。`upsertCreator` には optional `group` を追加し、INSERT 時のみ反映で既存値を保持(random uploader による上書き防止)
- データ収集の自動開始を永続フラグで制御(デフォルト無効)— `AppConfig.dataCollectionEnabled` 追加、起動時自動開始を flag でガード、`DataCollectionSettings` に「有効化する / 無効化する」永続トグル(有効化時は確認ダイアログ)+ ステータス行に「自動収集: 🔴 / 🟢」表示。IPC `dataCollection.isEnabled` / `setEnabled` 新設。レイヤ整理:`dataCollectionEnabled` = 永続マスタースイッチ(再起動跨ぐ)、`isPaused` / `isRunning` = セッション内モード。検索クエリ戦略が確定するまでクォータ消費を防ぐのが目的(`2dca5bd`)
- YouTube API キー保存バグ 3 周目で完治(`b04f64d` + `e43f275`) — 2 度の修正(`5298725` 上限 50 化、`240dc50` getKeys + useEffect seed)後もユーザ実機で「1 個しか登録できない」が続いていた問題を、**ログ駆動デバッグ**で真因確定 → UX モデル全面刷新で完治。`e1811d5` で `[YT-DEBUG]` / `[SS-DEBUG]` / `[IPC-DEBUG]` 接頭辞のログを全動線に仕込み(挙動は変えず)→ ユーザ実機ログで「`add-row button clicked` が 1 度も出てない」「既存キーが masked input に seed → ユーザは空欄と認識して上書き」と確定 → `b04f64d` で UI モデル変更:既存キーは read-only chip(`AIza••••••••XYZ12` 表示 + × で削除マーク)、新規キーは別セクションの input 行、保存時 `(残った既存) + (新規)` を Set で dedupe。input ではないので物理的に既存を誤って消せない構造。`e43f275` で診断ログ撤去、`saveYoutubeApiKeys` の read-back integrity check のみ防御層として残置(成功時無音、ズレた時のみ警告)
- YouTube API キー複数追加 UI バグ修正 — 真因は **仮説 B(編集モード展開時に既存キーを draft にコピーしない)**。`5298725` で `MAX_YT_KEYS=50` に上げたが、編集 UI で `draft = ['']` 初期化のままで既存キーが見えず、save の "replace" セマンティクスで常に 1 個に上書きされていた。`youtubeApiKeys.getKeys()` IPC を新設(renderer に plaintext 配列を返却、Gladia/Anthropic とは異なる方針 — multi-key editor の UX 上必要)+ `useEffect([editing])` で edit-mode 入りごとに既存キーを draft に seed。diagnostic log も全動線(toggle / add row / save / count)に。**(後で判明:この修正は password input に seed したため別の UX バグを引き起こし、3 周目で UI モデル刷新)**
- API 管理画面 3 修正 — (1) YouTube API キー上限 10→50(`MAX_YT_KEYS`)、(2) 「30 個保存しても全部出ない」の真因特定:UI の「+ キーを追加」 disabled 条件が `draft.length >= 10` で入力欄を 10 行までしか追加できなかった、secureStorage / DPAPI / IPC 側に容量問題なし、`MAX_YT_KEYS=50` 化で完治。secureStorage に diagnostic log(件数 / JSON 長 / 書き込みバイト)+ Set dedupe + 100KB cap を defense-in-depth で追加、(3) データ収集に開始/停止/再開の 3-way ボタン(running / paused / idle 状態を UI 表示)
- API 管理画面をモーダルから全画面フェーズに変更 — `phase` に `'api-management'` 追加、`ApiManagementDialog`(モーダル)を `ApiManagementView`(全画面)に置換、`previousPhase` で戻り先保持、Esc + 戻るボタン両対応。load / clip-select / edit のいずれからでも遷移可能、データ保持
- 「API 管理」専用画面の新設(全 API キー統合 + 収集ログビューア) — トップメニュー「API 管理」+ Ctrl+Shift+A、`ApiManagementDialog` でタブ式(API キー / 収集ログ)管理。Gladia / Anthropic / YouTube(複数)を統合、YouTube は per-key クォータバー表示。`CollectionLogViewer` は虚スクロール + レベル別フィルタ + エラー赤色強調 + 5 秒自動更新 + 「ファイルを開く」ボタン。`logger.ts` で ISO 8601 `[LEVEL] message` 形式統一、既存 console.log を全部 logger 経由に。`SettingsDialog` から API キー部分を完全削除、ハンドオフリンクのみ
- 切り抜き動画データ収集パイプライン Phase 1(蓄積基盤) — `better-sqlite3` ベース SQLite DB(WAL モード、5 テーブル)+ YouTube Data API クライアント(キー最大 10 個ローテーション、daily 10K unit クォータ管理)+ yt-dlp で heatmap 上位 3 ピーク / chapters / サムネ抽出。アプリ起動 5 秒後にバックグラウンドで 1 時間ごと自動収集、`Settings → 切り抜きデータ収集` で API キー登録 + 配信者リスト編集 + ステータス確認 + 手動トリガー。MAX 200 動画 / バッチ、200 ms 間隔で yt-dlp に優しく。実機検証は API キー登録後にユーザ側で。Phase 2 / Phase 3 への入力データ生成役
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
