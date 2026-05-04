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

## 2026-05-04 - メイン画面に「新着動画」セクション追加(URL DL + 自動録画 統合 24h フィード)

- 誰が: Claude Code(Opus 4.7)
- 何を: load phase の DropZone 下に「新着動画」セクション。直近 24 時間以内の auto-record + URL DL 動画を時系列降順で表示、クリックで編集画面へ遷移
- 動機: ダウンロード / 録画した動画にアクセスするのに「URL DL → エクスプローラ」「自動録画 → 登録チャンネル画面 → 録画済み動画」と分断されていた。「最近触った動画一覧」がメイン画面で見えないと作業フローが止まる
- 設計:
  - **URL DL は履歴永続化なし、ディレクトリスキャン**:`AppConfig.defaultDownloadDir` を `fs.readdir` + `fs.stat` で mtime で判定。yt-dlp の出力 ext(.mp4 / .mkv / .webm / .m4v / .mov)のみ
  - **録画は streamRecorder.list() を再利用**:既存メタデータ駆動。`startedAt` を時刻軸として採用(録画継続中もフィードに出る = 監視ビュー兼用)
  - **VOD 優先 / 録画 fallback**:VOD ファイル(クリーン MP4)があればそちら、なければ live capture のファイル名を採用
  - **dedup**:両ソースの絶対パスでセット dedup(録画フォルダと DL フォルダが偶発的に重なるケース対策)
  - **24 時間カットオフ**:`MAX_AGE_HOURS = 24`(component 定数、将来 AppConfig 化の余地)
  - **自動更新**:`REFRESH_INTERVAL_MS = 60_000`(録画ファイルサイズ反映 + 24h 期限切れの自動消去)
  - **クリック動作**:`useEditorStore.setFile(filePath)` 経由 = 既存編集フローに合流。ただし `recordingStatus === 'recording'` の場合は「録画継続中ファイルは再生不可の場合があります」警告ダイアログ
  - **0 件は非表示**(空状態のセクションヘッダだけ残ると不格好)
- UI 詳細:
  - サムネは現状アイコンプレースホルダ(`Film` icon)。ffmpeg サムネ生成は別タスク
  - 録画継続中は赤丸パルスの「録画中」オーバーレイ
  - SourceBadge(緑系の Recording / 紫系の DL)
  - 16:9 アスペクト固定、grid-template-columns auto-fill 220px+
- 影響:
  - `src/main/recentVideos.ts`(新規 90 行):listRecentVideos 単体実装
  - `src/main/index.ts`: `recentVideos:list` IPC 追加
  - `src/preload/index.ts` + `src/common/types.ts`: `recentVideos.list(maxAgeHours)` API + `RecentVideo` 型 + `IpcApi.recentVideos`
  - `src/renderer/src/components/RecentVideosSection.tsx`(新規 130 行)+ CSS module
  - `src/renderer/src/App.tsx`: load phase に `<RecentVideosSection />` マウント
  - `src/renderer/src/App.module.css`: `.bodyEmpty` を `flex-direction: column` + `justify-content: flex-start` + `padding-top` で縦積み許可。DropZone の center 配置は若干上にずれるが視覚的バランスは維持
- やらないこと: サムネ生成 / 履歴永続化 / 削除機能 / 7日 / 30日切替 / ソート切替 / 検索 / ページング / メタデータ表示(コーデック等)
- 残課題:
  - 既存「録画済み動画」(`MonitoredCreatorsView`)は専門画面として維持。新着動画は「全部一覧」で役割分担
  - サムネ生成(別タスク)
- コミット: 未コミット

---

## 2026-05-04 - 録画継続の堅牢化(自動再起動 + 連続 missing 判定 + プロセスツリー kill)

- 誰が: Claude Code(Opus 4.7)
- 何を: yt-dlp が途中で死んでも配信が続いていれば自動再起動。streamMonitor の ended 判定を 3 連続 missing に変更。process tree kill で orphan ffmpeg を防ぐ
- 動機:
  - 実機テストで録画ファイルが配信時間より短い症状(柊ツルギ 3:06 / 加藤純一 554MB)
  - 同時に **orphan ffmpeg 12 個**観察。原因:yt-dlp が HLS フラグメント取得を ffmpeg に委譲後に親自身は早期終了 → app は yt-dlp PID しか持ってない → kill 対象がすでに死んでて ffmpeg だけ orphan として残存
  - streamMonitor が Twitch API の一時的不調(1 ポール missing)で ended 誤判定し録画停止 → 別 streamId として再録画 = ファイル分割
- 設計:
  - **process tree kill**(`taskkill /F /T /PID <yt-dlp-pid>`):`stop()` / `killSync()` で yt-dlp とその子 ffmpeg を一括 kill。これがないと orphan が増殖
  - **probeIsStillLive(SessionDeps)**:orchestrator が platform 別 probe 関数を inject。Twitch は `helix/streams?user_id=<>`(1 unit)、YouTube は `videos.list?id=<>&part=liveStreamingDetails`(1 quota)で `actualEndTime` をチェック
  - **auto-restart**:yt-dlp の `proc.on('exit')` で stop 要求でなければ probeIsStillLive → 還元時:
    - still live + restartCount < 5 → 5 秒クールダウン → ファイル名ローテーション(`recordingId.live.001.mp4` ...) → respawn
    - offline → 通常完了処理
    - restartCount ≥ 5 → 失敗マーク(`yt-dlp restarted 5 times — giving up`)
  - **probe 失敗時は true(defensive)**:transient API blip で誤って finalise しないため。MAX_RESTARTS が backstop
  - **`liveSegments[]` メタデータ**(additive):単一セグメント録画は省略(JSON tidy + 旧データ後方互換)。複数セグメントの場合のみ配列で記録、`files.live` は最新 active のみ(既存コード後方互換)
  - **`ENDED_MISS_THRESHOLD = 3`**:streamMonitor が 3 連続 missing で初めて ended 発火。grace 中は `liveStreams` Map に prior info を carry forward(UI / recorder が "missing 1/3" 段階で停止しないため)
  - **連続 missing 判定**:`missingCounts: Map<key, number>`、復帰で reset、ENDED_MISS_THRESHOLD で発火後 delete
- ログ追加:
  - `[stream-recorder] yt-dlp exit: ... elapsed=Xh, segment=N`
  - `[stream-recorder] checking if stream is still live (restartCount=N/5)`
  - `[stream-recorder] probe result: stillLive=true/false`
  - `[stream-recorder] cooldown 5000ms before respawn`
  - `[stream-recorder] respawning ${kind} (restart N/5) → <new path>`
  - `[stream-monitor] <key>: missing N/3, holding`
  - `[stream-monitor] <key>: missing 3/3 → ended`
  - `[stream-monitor] <key>: live again (miss counter reset)`
- 影響:
  - `src/main/streamRecorder/recordSession.ts`: 大規模改修(279 → 460 行)。`info` / `quality` / `restartCount` 保持 + `respawn()` / `maybeRestartOrFinalise()` / `buildLiveFilePath()` / `killProcessTreeWindows()` 追加
  - `src/main/streamRecorder/index.ts`: `probeIsStillLive` クロージャ inject(Twitch helix + YouTube videos.list)
  - `src/main/streamRecorder/storage.ts`: `refreshFileSizes` が `liveSegmentSizes` も更新
  - `src/main/streamMonitor/index.ts`: `ENDED_MISS_THRESHOLD=3` + `missingCounts` Map + diff ロジック書き換え(grace 中は `effective` Map に carry-forward)
  - `src/common/types.ts`: `RecordingMetadata` に `liveSegments?` / `liveSegmentSizes?` / `restartCount?` 追加
  - `src/renderer/src/components/MonitoredCreatorsView.tsx`: `RecordingRow` で複数セグメントの合計サイズ + 「N ファイル分割(再起動 M 回)」表示
- やらないこと: ffmpeg concat による複数ファイル結合(別タスク)/ 録画再開時の音声ノイズ補正 / yt-dlp が最初から起動失敗するケース / 配信者の意図的中断検知 / ENDED_MISS_THRESHOLD の AppConfig 化(将来)
- 残課題:
  - **既存の orphan ffmpeg 12 個は手動で kill 必要**(`taskkill /F /IM ffmpeg.exe` または該当 PID 個別)。これからの起動で同じ問題は発生しないはず
  - 「N ファイル分割」UI で全結合 / セグメント選択ダイアログは未実装(現状は最新セグメントを開く、別タスク)
  - 既存の不完全録画ファイル(柊ツルギ 6.4 GB / 加藤純一 554 MB)はそのまま残置、手動再生 / 編集可能
- コミット: 未コミット

---

## 2026-05-04 - 配信者検索結果のフォロワー / 登録者数足切りフィルタ

- 誰が: Claude Code(Opus 4.7)
- 何を: API fallback の検索結果に最小フォロワー / 登録者数フィルタを適用。デフォルト 20 万人(`AppConfig.searchMinFollowers`)、UI から変更可能、0-hit 時に閾値緩和ボタン
- 動機: ハイブリッド検索が動作したものの、API fallback が小規模 / ゴミアカウントを大量に返す。例:「橘ひなの」検索 → YouTube 5 件(本物 1M + 切り抜き 174K + 11K + 6.7K + 974)。ユーザの登録対象は基本 大手 / 事務所所属(にじさんじ / ホロライブ / ぶいすぽ等)= 全員 20 万超なので、20 万足切りで候補が大幅に絞れる
- 設計:
  - **フィルタ対象は API fallback のみ**:Gemini 結果は Gemini が「本物」と特定済み = pass-through。手動入力も pass-through(ユーザの明示的意思)
  - **null counts は pass-through**:Twitch app-token で `/channels/followers` が読めないケース → 「不明」を罰しない
  - **閾値プリセット**:5 万 / 10 万 / 20 万 / 50 万 / 100 万 + 自由入力(0 = 閾値なし)
  - **0-hit relaxation**:`filteredOut > 0` の時のみ「閾値を下げて再検索」ボタン群を表示。**現在の閾値より厳しい候補のみ**ボタン化(20 万 → 10 万・5 万・なし、5 万 → なし のみ)
  - **override は in-flight のみ**:再検索ボタンは `searchAll({minFollowersOverride})` を渡す。AppConfig は変更しない
- 影響:
  - `src/common/config.ts`: `AppConfig.searchMinFollowers` 追加 + `DEFAULT_CONFIG = 200_000`
  - `src/main/config.ts`: load / save の round-trip
  - `src/main/creatorSearch.ts`: `searchCreators` に `minFollowers` 引数追加 + filter step 5 + `SearchCandidatesResult.{filteredOut, thresholdApplied}` 追加
  - `src/main/index.ts`: IPC `creatorSearch:searchAll` のシグネチャ拡張(後方互換のため bare string も受ける)
  - `src/preload/index.ts` + `src/common/types.ts`: `searchAll(args)` シグネチャ + `HybridSearchResult.{filteredOut, thresholdApplied}` 追加
  - `src/renderer/src/components/MonitoredCreatorsView.tsx`: `ThresholdWidget` + `RelaxationHint` 追加、`SearchState.done` に `filteredOut` / `thresholdApplied` 追加、`runSearch(query, override?)` ヘルパで relaxation 再検索 + 既存 `handleSearch` ラッパ
  - `formatThreshold(n)` ヘルパ追加(20 万 / 100 万 / 閾値なし)
- 動作確認:
  - `npm run build` 通る、main / web / node typecheck 通る
  - Gemini 結果 → 閾値無視で表示
  - 手動入力 → 閾値無視で表示
  - API fallback 結果が閾値で除外 → 「N 件除外」warning
- やらないこと: 同名グループ表示の自動グルーピング / カテゴリ別分類 / 国別フィルタ / ジャンル別フィルタ / トレンド表示
- 残課題: 閾値変更後の再検索は Cache TTL(5 分)に当たると古い結果が返る → 緩和ボタンに force-refresh option 必要かも(別タスク)
- コミット: 未コミット

---

## 2026-05-04 - 配信者検索のハイブリッド化(Gemini 主導 → API フォールバック)

- 誰が: Claude Code(Opus 4.7)
- 何を: `creatorSearch.searchCreators()` を新設、Gemini 検索失敗時に Twitch `/helix/search/channels` + YouTube `search.list` で自動フォールバック。複数候補表示 + データソース badge UI
- 動機:
  - Gemini が片方しか答えない / 同名別人を返す / SAFETY null / 確率的にゆらぐ
  - 例: 「加藤純一」を 09:51 は `kato_junichi0817` と返したのに、別タイミングで `jun_kato_0817`(impostor)を返した
  - Gemini に 100% 依存する設計だと「キーは効いているのに結果は不正確」状態が見抜けない
- 設計:
  - **Step 1 Gemini**: 既存 `askGemini` のまま(0 quota / 速い)
  - **Step 2 Gemini 結果解決**: `fetchTwitchProfile` / `fetchYouTubeProfile`(handle 1 quota)
  - **Step 3 Twitch fallback**: Gemini がプロフィールに着地しなかった時のみ `/helix/search/channels?query=&first=10` → 各候補 follower 取得(5 並列、各 1 unit)→ follower 降順で上位 5 件
  - **Step 4 YouTube fallback**: `search.list` (100 quota) → 各候補 `channels.list` で subscriber 取得(1 quota × 5)→ subscriber 降順で上位 5 件
  - **キャッシュ**: query 毎、5 分 TTL の in-memory `Map`(Twitch / YouTube 別個)。double-click / 連続検索の quota 浪費を防ぐ
  - **同時実行抑制**: Twitch enrichment は 5 並列(800/min レート制限に余裕)、YouTube は 5 件のみで十分速いので逐次
- quota 消費(平均 / 最悪):
  - **Gemini ヒット**: 0(従来通り)
  - **Twitch fallback のみ**: search 1 + follower × 5 = 6 unit(800/min の 0.75% / 検索)
  - **YouTube fallback のみ**: search.list 100 + channels.list × 5 = 105 quota(46 キー × 10K = 460K/日 → 4380 検索/日まで OK)
  - **両方 fallback**: 111 quota(YouTube 主因)
- データソース UI:
  - ✓ Gemini 推測(緑、`#4ade80`)
  - ⚠ API 検索結果(黄、`#f59e0b`)— 確認ダイアログでも警告強調
  - 👤 手動入力(青、`accent-primary`)
  - 旧 `confidence: 'low'` 不確実 chip は撤廃(`source` で完全代替)
- 影響:
  - `src/main/twitchHelix.ts`: `searchTwitchChannels` + `TwitchChannelHit` 型 追加
  - `src/main/dataCollection/youtubeApi.ts`: `searchChannelsByName` + `ChannelSearchHit` 型 追加(既存 `searchChannelByName` は seedCreators で使われてるので残置)
  - `src/main/creatorSearch.ts`: `searchCreators` orchestrator + キャッシュ + concurrency helper + `SearchCandidatesResult` / `CandidateSource` 型 追加
  - `src/main/index.ts`: IPC `creatorSearch:searchAll` 追加
  - `src/preload/index.ts` + `src/common/types.ts`: API + 型(`HybridSearchResult` / `CreatorCandidateSource`)追加
  - `src/renderer/src/components/MonitoredCreatorsView.tsx`: `SearchCard.confidence` → `source` リネーム + `SourceBadge` コンポーネント追加。`handleSearch` を `searchAll` 一発呼び出しに簡素化(115 → 60 行)
- やらないこと: ページング(上位 5 件のみ)/ 検索履歴永続化 / サジェスト / 国別フィルタ / 同一人物の Twitch+YouTube 自動関連付け / Gemini プロンプト改造
- 残課題: 「もっと見る」ボタン(現状 5 件で打ち切り)、`api-fallback` の応答時間が 1-3 秒で見えるので「検索中...」スピナーをカード単位で出すべき
- コミット: 未コミット

---

## 2026-05-04 - API キー ハイブリッド保存 + JSON エクスポート/インポート(事故再発防止)

- 誰が: Claude Code(Opus 4.7)
- 何を: 全 API キーを「暗号化 .bin(現状)+ 平文 JSON バックアップ」の二重化に変更。エクスポート / インポート機能を追加
- 動機(事故): 2026-05-04 朝に **Gemini API キー 50 個が永久消失**。userData/geminiApiKeys.bin が現在の DPAPI master key で復号不能(GCM auth fail / CTR モードでもランダム出力 → 別 master key で暗号化されたとしか説明つかない)。同じく失われたと思われていた YouTube も実は **過去の保存バグで 1 個しか保存されていなかった** ことが調査で判明。Gladia / Anthropic / Twitch Secret は救出成功
- 設計:
  - **平文バックアップ**: `~/Documents/jikkyou-cut-backup/api-keys.json`(userData の外、エクスプローラからアクセス可、アンインストールで消えない、admin 不要)
  - **JSON 構造**: `$schema = 'jikkyou-cut-api-keys-v1'`、`lastBackupAt`、`warning`、`keys.{gemini[], youtube[], gladia, anthropic, twitchClientId, twitchClientSecret}`
  - **保存ロジック**(`saveAt`): encrypt → write .bin → 読み戻し検証 → 平文バックアップ更新(atomic write via .tmp + rename)。検証失敗は warn ログのみ(.bin は残す)、バックアップ書き込みが安全網
  - **読み込みロジック**(`loadAt`): .bin → 失敗時に平文バックアップへ自動フォールバック → 再暗号化して .bin に書き戻し
  - **ensureBackupInitialized**(boot 時): 既存の全 .bin を試し、復号できたものだけバックアップに転記。idempotent(既に値があるスロットは触らない、復元したキーで上書きしないため)
  - **検証(read-back verify)**: encrypt → write の直後に read → decrypt → 値一致を確認。今回の Gemini 消失のような「保存したつもりが復号不能」を即座に warn ログで surface
- エクスポート / インポート:
  - エクスポート: `dialog.showSaveDialog` → 全キーを JSON で書き出し(平文バックアップと同形式)
  - インポート: ファイル選択 → 差分プラン表示(`Gemini: 50 個 (現在 0)` 形式) → マージ / 完全置き換え選択 → 適用
  - バリデーション: `gemini` / `youtube` は `AIza... [A-Za-z0-9_-]{30,}`、`anthropic` は `sk-ant-...` で 50 文字超。形式 NG はスキップ + UI に件数表示
  - main 側に短命の `pendingImports` Map を持ち、preview → apply で plaintext を renderer 経由させない
- 移行: 既存ユーザは初回起動時に `ensureBackupInitialized` が走り、復号できる .bin から自動で平文バックアップ生成。失敗 .bin はバックアップに何も入らないので「データロス」は発生しない
- やらないこと: マスタパスワード方式(UX 悪化) / クラウド同期 / バックアップ世代管理(将来) / Linux・macOS 対応(Windows 優先、ただし `os.homedir()` ベースなので動くはず)
- 影響:
  - `src/main/secureStorage.ts` 全面書き換え(168 → 480 行)。public API はソース互換(`saveSecret` / `loadGeminiApiKeys` 等のシグネチャ維持)
  - `src/main/index.ts`: boot 時 `ensureBackupInitialized` 呼び出し / `apiKeysBackup:*` 5 ハンドラ追加 / `twitch:setClientCredentials` で `updateTwitchClientIdInBackup` 呼ぶ
  - `src/preload/index.ts`: `apiKeysBackup` API 追加
  - `src/common/types.ts`: `IpcApi.apiKeysBackup` + 周辺型(`ApiKeysBackupStatus`, `ApiKeysImportPlan` 等)
  - `src/renderer/src/components/ApiManagementView.tsx`: `BackupSection` / `ImportExportSection` / `ImportPreviewDialog` 追加。既存 `*KeysSection` に `onChanged` プロパティ追加(保存時にバックアップ status banner を再取得)
  - `src/renderer/src/components/ApiManagementView.module.css`: backup banner / import/export / import dialog の CSS 追加
- 緊急救出スクリプト(参考): `scripts/recover-keys.cjs`(Local State の os_crypt.encrypted_key を DPAPI で復号 → master key で .bin を AES-256-GCM 復号)。安全網が機能しなかった過去事案用、新規ユーザは不要
- コミット: 未コミット

---

## 2026-05-04 - 緊急修正:Twitch 録画 0 B バグ(`--live-from-start`)+ cookies 統合

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 X3 完成以降 **Twitch 録画が一度も成功してなかった** 真因を特定し修正。同時に副次バグの cookies 未統合も修正
- 真因確定:
  - `recordSession.spawnYtDlp` が **無条件で `--live-from-start`** を渡していた
  - yt-dlp の公式仕様: **`--live-from-start` は YouTube 専用機能**(Twitch HLS は過去フラグメント取得不可)
  - Twitch URL に `--live-from-start` を渡すと yt-dlp は「配信開始時点」を永遠に探し続ける → フラグメント 1 つも書かない → **0 byte 無限ループ**
  - `--retries infinite` のおかげで永遠に retry し続けるので「動いてるように見える」のが質悪い
  - 影響: 5/3 22:08 柊ツルギ 0 B / 5/4 09:08 加藤純一 0 B、両方この症状
- 副次バグ:
  - recordSession で **cookies が yt-dlp 録画コマンドに渡されてなかった**(直前のタスクで `creatorSearch` / `urlDownload` には統合済だったが、recording 経路だけ漏れ)
  - 公開配信なら不要だが、年齢制限 / サブスク限定で 401 になる潜在的問題
- 修正:
  - **`spawnYtDlp` 内**:
    ```ts
    const liveFromStartArgs = info.platform === 'youtube' ? ['--live-from-start'] : [];
    // ... args に ...liveFromStartArgs スプレッド
    ```
  - **`RecordingSession` constructor に `cookiesArgs: string[]` を追加**:呼び出し側(orchestrator)が `getCookiesArgs(...)` で事前構築した cookies args を渡す
  - **orchestrator(`streamRecorder/index.ts`)**: `onStreamStarted` で session 構築前に `getCookiesArgs({ cookiesBrowser, cookiesFile, cookiesFileYoutube, cookiesFileTwitch, platform: info.platform })` を呼んで渡す。`urlDownload` と同じ優先順位(プラットフォーム別 > 汎用 > ブラウザ > なし)
  - **診断ログ追加**:
    ```
    [stream-recorder] platform=twitch, liveFromStart=false, cookies=<none>
    [stream-recorder] platform=youtube, liveFromStart=true, cookies=--cookies C:\...
    ```
    spawn 直前に出すので、再発した時に「Twitch なのに liveFromStart=true」みたいな状態が即座に分かる
- 検証 spawn コマンドの実例:
  - **修正前**(全プラットフォーム共通):
    ```
    yt-dlp <url> --js-runtimes node -f bestvideo+bestaudio/best/best
      -o <path> --live-from-start --no-part --concurrent-fragments 4
      --retries infinite --fragment-retries infinite --print after_move:filepath
      --no-warnings --no-playlist
    ```
  - **修正後 Twitch**(`--live-from-start` 削除、cookies 追加):
    ```
    yt-dlp https://www.twitch.tv/kato_junichi0817 --js-runtimes node
      -f bestvideo+bestaudio/best/best -o <path> --no-part
      --concurrent-fragments 4 --retries infinite --fragment-retries infinite
      --print after_move:filepath --no-warnings --no-playlist
      [--cookies C:\path\to\twitch-cookies.txt]
    ```
  - **修正後 YouTube**(`--live-from-start` 維持、cookies 追加):
    ```
    yt-dlp https://www.youtube.com/watch?v=xxx --js-runtimes node
      -f bestvideo+bestaudio/best/best -o <path> --live-from-start
      --no-part --concurrent-fragments 4 --retries infinite
      --fragment-retries infinite --print after_move:filepath
      --no-warnings --no-playlist
      [--cookies C:\path\to\youtube-cookies.txt]
    ```
- ゾンビプロセス対応:
  - 5/4 朝の 0 B 録画放置で yt-dlp pid=32968 (61.6 MB アイドル、~1.5h 経過)が孤児として残ってた
  - `Stop-Process -Id 32968 -Force` で即 kill 済
  - shutdown フック(直前タスクで実装)が正しく動いていれば本来この孤児は出ないはずだが、アプリがクラッシュ / 強制 kill された経路ではフックは発火せず → `previous app session ended unexpectedly` で boot recovery にフォールバック、ただし subprocess 自体は orphan のまま生き残る
  - これは Windows の child process detach デフォルト挙動。完全防止には Job Object 経由の spawn が必要(将来 TODO)
- 不採用案:
  - **`--live-from-start` を全プラットフォームで使う(回避策なし)** → Twitch で永続 0 B、致命的
  - **Streamlink 切替** → spec の方針通り yt-dlp で動くなら不要、Streamlink 配置はオプショナルのまま
  - **cookies なし時の error にする** → 公開配信は cookies 不要、勝手に必須化したら UX 悪化
- 影響ファイル:
  - `src/main/streamRecorder/recordSession.ts`(`cookiesArgs` フィールド追加 + constructor opts、`spawnYtDlp` で platform 分岐 + cookies + 診断ログ)
  - `src/main/streamRecorder/index.ts`(orchestrator が `getCookiesArgs` で事前構築 + RecordingSession に渡す)
- 観察すべき点:
  - **完走テストで .mp4 サイズが増えるか**: 1-2 分後 / 5 分後 / 30 分後 / 1 時間後 で順次増加していくのが期待挙動。停滞してたら別問題
  - **YouTube 録画は未テスト**: spec 範囲外、YouTube live は 加藤純一の Twitch ほど身近ではない。X3 完成テスト時の検証が必要
  - **cookies path が存在しない場合**: `getCookiesArgs` は path validation せずに `--cookies <path>` を返す。yt-dlp が起動時に「ファイル無い」エラーで死ぬ可能性 → recordSession の exit handler で `status='failed' + errorMessage='yt-dlp exited code=N'` で記録される
  - **shutdown フックで kill されない経路**: クラッシュ / タスクマネージャ強制終了 / Windows shutdown(時々)。これは Windows のプロセス親子関係の限界、Job Object 化が必要(将来)

---

## 2026-05-04 - 開設日表示削除 + フォロワー数による品質警告

- 誰が: Claude Code(Opus 4.7)
- 何を: 配信者カードから開設日表示を削除し、代わりに **フォロワー / 登録者数による impostor 検出バッジ** を追加
- 経緯:
  - 直前タスク完了後の実機テストで、Gemini の同名別人ヒット時にフォロワー数の差が圧倒的に分かりやすいことが判明:
    - JunichiKato(impostor): **15 フォロワー**
    - 柊ツルギ(本物): **436K フォロワー**
  - 数字だけで本物 vs 偽物が一発判別できるため、開設日は冗長 → 削除
  - 「Twitch follower count は app-only Client Credentials で取れない」と先のタスクで書いたが、**実際には取れる**ことが実機で判明。条件次第で 401 にならず total が返ってくる(broadcaster_id クエリのみで scope 不要なケースがある模様)
- 設計判断:
  - **閾値は 1K / 10K の 2 段階**:
    - `< 1K` (`critical`): 🚨 誤登録の可能性大(JunichiKato の 15 はここ)
    - `< 10K` (`low`): ⚠ 要確認(個人勢の小規模 VTuber 等が落ちる範囲)
    - `>= 10K` (`ok`): バッジ無し(柊ツルギの 436K はここ)
    - `null` (`unknown`): バッジ無し(API 制約 / 取得失敗 → 「不明」表示のまま)
  - **警告のみ、自動排除しない**:小規模配信者を意図的に登録したい場合に詰むのを避ける(個人勢 VTuber でフォロワー数千の人もいる)。ユーザの判断を尊重
  - **確認ダイアログでの強警告**(`critical` のみ):
    - 赤い警告ボックスで「{countLabel}が {N} と少なく、本人ではない可能性が高いです。本当に登録しますか?」
    - 登録ボタンが「登録する」→「**それでも登録する**」に変わる(止まる機会を増やす)
  - **`low` の確認ダイアログ**: 既存の confidence='low' 警告と同じ Box で「{countLabel}が {N} と少なめです。本人で合っているか確認してください。」
  - **Twitch / YouTube 共通ロジック**: フォロワー数も登録者数も同じ閾値・同じ UI。プラットフォーム差を吸収するため `getFollowerWarning(count)` ヘルパに集約
- なぜ 1K/10K の閾値か:
  - 1K: JunichiKato の 15 を確実に critical に落とせる + 仮に Gemini が「30 フォロワーの全くの別人」を返した時にも捕まえられる安全マージン
  - 10K: 個人勢 / 小規模配信者の境界線として一般的な水準。これ未満は「VTuber デビュー直後 / マイナーストリーマー」の領域なので「合ってますか?」と聞くのが妥当
  - これらは spec で明示された値、実測による調整で動かす想定(将来 TODO)
- 不採用案:
  - **完全除外**(spec 案 A):個人勢を登録したい時に詰むので不採用
  - **1K-10K も除外**(spec 案 C):同上、警告で十分
  - **ソート(検索結果のフォロワー降順)**: spec が「実装簡単なら入れる」と任意指示。現状の検索結果は最大 2 枚(Twitch + YouTube)なのでソートしても見栄えが変わらない → スキップ
- 影響ファイル:
  - `src/renderer/src/components/MonitoredCreatorsView.tsx`:
    - `FOLLOWER_THRESHOLDS` 定数 + `FollowerWarning` 型 + `getFollowerWarning` ヘルパ + `FollowerWarningBadge` コンポーネント追加
    - `formatYearMonth` 削除(呼び出しが消えたため未使用)
    - `SearchResultCard` の stats 行から `· 開設: 2018-03` 部分を削除、代わりに `<FollowerWarningBadge>` 表示
    - `RegisteredRow` の stats 行から同上削除、`<FollowerWarningBadge>` 表示
    - `ConfirmAddDialog` を拡張: stats 行に `フォロワー: 15` を inline 追加、warning='critical' なら赤い警告 box + 登録ボタン文言を「それでも登録する」に
- 観察すべき点:
  - **Twitch follower 取得の信頼性**: 直前タスクで「app-only token では取れない」と書いていたが実機で取れた(JunichiKato の 15 / 柊ツルギの 436K)。Helix の `/channels/followers` は **broadcaster_id クエリだけなら scope 無しでも total を返すケースがある模様**(API ドキュメントでは scope 必須となっているが、実装上の挙動が違う可能性)。Twitch 側の仕様変更で 401 に戻る可能性ゼロではないので、null フォールバック経路は維持
  - **YouTube subscriber count の hidden**: `hiddenSubscriberCount=true` の channel は count=null → warning='unknown' → バッジ無し。ここに「非公開」表示を入れる UX 改善は将来余地
  - **既存 Twitch 登録の追従**: pre-2026-05-04 登録は `followerCount=null` → 「不明」表示 + バッジ無し。「↻ 再取得」で更新可能(直前タスクで実装済)
  - **閾値の妥当性**: 実運用で「個人勢 VTuber 5K フォロワーが low 警告で煩わしい」となれば 10K → 5K に下げる、逆に「もう少し厳しく」なら 20K に上げる。ユーザフィードバック次第

---

## 2026-05-04 - 配信者カードにフォロワー / 登録者数表示 + 手動入力フォールバック

- 誰が: Claude Code(Opus 4.7)
- 何を: 検索結果 / 登録済みカードに **フォロワー数 / 登録者数 + アカウント開設日** を表示し、Gemini が同名別人を返した時のために **手動入力フォールバック UI** を追加
- 経緯: ユーザが「加藤純一」検索で Gemini が `JunichiKato @junichikato`(本物は `kato_junichi0817`)を返した。**フォロワー数で本人と同名別人を一目で区別** + **正しいログイン名を直接入力できる救済策** を整備

### Part 1 — フォロワー / 登録者数 + 開設日

- **Twitch**:
  - `searchUserByLogin` の `TwitchUser` に `createdAt` 追加(Helix `/users` の `created_at` フィールド)
  - 新規 `getTwitchFollowerCount(broadcasterId)` 追加 — `/helix/channels/followers?broadcaster_id=X` を叩く
  - **app-only Client Credentials トークンでは 401 で帰ってくる**(エンドポイントは `moderator:read:followers` scope 必須)→ null 返す → UI で「不明」表示
  - `creatorSearch.fetchTwitchProfile` が両方 fetch + パススルー
- **YouTube**:
  - `getChannelByHandle` / `getChannelById` の `part` を `snippet` → `snippet,statistics` に変更(同 1 quota unit)
  - `ChannelLookup` に `createdAt`(snippet.publishedAt)+ `subscriberCount`(statistics.subscriberCount、`hiddenSubscriberCount=true` なら null)追加
  - `creatorSearch.fetchYouTubeProfile` が両方 fetch + パススルー
- **`MonitoredCreator` 拡張**:
  - Twitch: `followerCount?: number | null` + `accountCreatedAt?: string`
  - YouTube: `subscriberCount?: number | null` + `accountCreatedAt?: string`
  - 両方 optional — pre-2026-05-04 の登録 entry は undefined、UI は「不明」で fallback
  - `monitoredCreators:add` IPC が新フィールド受領、`refetchTwitch` が follower + createdAt も更新
- **UI**:
  - `SearchResultCard` に `フォロワー / 登録者: 1.2K · 開設: 2018-03` 行追加
  - `RegisteredRow` に同じ行追加(誤登録に気づく機会を増やす — spec 1-6)
  - `formatCount(n)`:`< 1000` そのまま / `< 1M` `1.2K` / `< 1B` `1.2M`
  - `formatYearMonth(iso)`: `2018-03` 形式

### Part 2 — 手動入力フォールバック

- **`fetchYouTubeProfile` シグネチャ拡張**: `{ handle?: string | null; channelId?: string | null }` に。`channelId` が来たら `getChannelById` で直接取得、無ければ `handle` で `getChannelByHandle` フォールバック
- **UI**: 検索フォームの下に `▶ Gemini で見つからない場合、手動で入力する` の collapsible section
  - Twitch ログイン名直接入力 → `fetchTwitchProfile(login)`
  - YouTube `@handle` or `UCxxx` 直接入力 → `UC[A-Za-z0-9_-]{22}` regex で channelId 判定 → `fetchYouTubeProfile({ channelId or handle })`
  - 取得結果は **既存の検索結果カード形式** で表示(confidence='manual' でラベル表示)、追加ボタン → 確認ダイアログ → 登録の通常フローに乗る
- **`SearchCardCommon.confidence`** に `'manual'` を追加。手動入力経由のカードは「不確実(要確認)」の代わりに「手動入力」バッジを表示

### 不採用案

- **Twitch follower count を user OAuth flow で取得** — 大規模な scope 拡大、ユーザに OAuth フロー強制、本来の auto-record スコープを超える
- **search.list フォールバック** — 段階 X1 完成版で 100 quota コストを理由に削除済み、復活させない
- **動画本数 / プロフィール文 / フォロワー履歴グラフ** — spec の「やらないこと」、将来分

### 影響ファイル

- `src/main/twitchHelix.ts`(`createdAt` を `TwitchUser` に + `getTwitchFollowerCount` 追加)
- `src/main/dataCollection/youtubeApi.ts`(`ChannelLookup` に `createdAt` + `subscriberCount`、`getChannelByHandle/ById` で statistics 取得 + `toChannelLookup` ヘルパ抽出)
- `src/main/creatorSearch.ts`(profile types + fetch 拡張、`fetchYouTubeProfile` の channelId path)
- `src/main/index.ts`(`monitoredCreators:add` ハンドラが新フィールド受領、`refetchTwitch` が follower + createdAt 更新、`creatorSearch:fetchYouTubeProfile` シグネチャ更新)
- `src/common/types.ts`(`creatorSearch.fetchTwitchProfile/fetchYouTubeProfile` 戻り値型 + `monitoredCreators.add` 引数型)
- `src/common/config.ts`(`MonitoredCreator` に optional フィールド)
- `src/main/config.ts`(`normaliseMonitoredCreators` で新フィールド round-trip)
- `src/renderer/src/components/MonitoredCreatorsView.tsx`(`SearchCard` 型拡張、card 構築で新フィールド、`SearchResultCard` / `RegisteredRow` で stats 行表示、`formatCount` / `formatYearMonth`、manual input collapsible UI、`handleManualTwitchFetch` / `handleManualYouTubeFetch`)

### 観察すべき点

- **Twitch follower count が常に null になる**:Client Credentials の制約。実機でも基本「不明」表示。**創設日**(これは取れる)が impostor 判別の主軸になる。本物の有名人は数年前のアカウント、impostor は最近のことが多い
- **登録時の値が古くなる問題**:spec 通り「登録時 snapshot、再取得ボタンで更新」。Twitch は「↻ 再取得」で follower + createdAt 更新可能、YouTube は別途実装が必要(将来 — 現状は削除 → 再追加)
- **手動入力で channelId 判定**:`UC[A-Za-z0-9_-]{22}` regex で 24 文字 UC 始まりのみ channelId 扱い。`@xxx` プレフィックス含む文字列は handle 扱い。プレフィックス無しのハンドル名(例: `kato`)は handle 扱い → `getChannelByHandle('@kato')` が呼ばれる(`normaliseHandle` で `@` 補完)
- **`hiddenSubscriberCount=true` チャンネル**:YouTube で「登録者数を非公開」設定の channel は `subscriberCount` null になる。UI は「不明」。これは仕様

---

## 2026-05-04 - 録画 subprocess の `before-quit` shutdown フック追加(ゾンビプロセス漏れ対策)

- 誰が: Claude Code(Opus 4.7)
- 何を: アプリ終了時に in-flight 録画 subprocess を確実に kill する shutdown フック追加
- 経緯:
  - 5/3 22:08 開始の録画(柊ツルギ)が 0 byte で失敗、メタが `previous app session ended unexpectedly` で残った
  - ユーザ環境で 10 個のゾンビ yt-dlp プロセス(各 ~62 MB、合計 ~616 MB)を発見
  - 真因: Electron の `spawn(yt-dlp, ..., { windowsHide: true })` は子プロセスを **detached** として起動するので、親(Electron main)が死んでも子は生き残る
  - 録画開始 → アプリ quit / crash → yt-dlp.exe が orphan として残り続ける、を毎回繰り返してた
- 修正:
  - **`RecordingSession.killSync()`** 追加:既存の `async stop()` の同期版。`stopRequested = true` 設定 + `proc.kill()` だけ、exit を待たない
  - **`streamRecorder.shutdownSync()`** 追加:active map を全走査し、各 session に対して
    1. `writeMetadataSync(meta with status='failed', errorMessage='app shutdown — recording interrupted')` で同期メタ書き込み(boot recovery が「クラッシュ」と「正常 shutdown」を区別できるように)
    2. `session.killSync()` で subprocess に SIGTERM
    3. `powerSave.release(...)` で OS スリープ防止タグ解放
    4. active map clear、filesize timer stop
  - **`storage.writeMetadataSync()`** 追加:`writeFileSync` + `mkdirSync` 経由で同期書き込み。before-quit のような「これが最後の処理」hook で async write が flush 保証無いのを回避
  - **`app.on('before-quit')`** 内で `streamRecorder.shutdownSync()` を呼ぶ
- なぜ同期にしたか:
  - `before-quit` は Electron が process tear-down する直前 hook。preventDefault しない限り次の tick でプロセスが死ぬ
  - async write は `await` してても Electron の tear-down sequence と race する可能性あり
  - `writeFileSync` は OS file system に commit するまでブロックする → メタが確実に disk に着地
  - subprocess kill の方は同期 spawn の `proc.kill()` 自体が同期 syscall なので問題なし
- 取りこぼしパターン:
  - **アプリクラッシュ** / **タスクマネージャ強制終了**:before-quit 発火しない → 引き続き boot recovery で `previous app session ended unexpectedly` メッセージ。これは仕方ない
  - **PC 強制シャットダウン**:同上
  - **Ctrl+C(dev terminal)/ Tray 終了 / ✕ ボタン(closeToTray=false)/ Windows shutdown**:全部 before-quit 発火するので shutdown フックが動く
- 影響ファイル:
  - `src/main/streamRecorder/storage.ts`(`writeMetadataSync` 追加、`writeFileSync` / `mkdirSync` import)
  - `src/main/streamRecorder/recordSession.ts`(`killSync` 追加)
  - `src/main/streamRecorder/index.ts`(`shutdownSync` + `activeCount` 追加)
  - `src/main/index.ts`(`before-quit` で `streamRecorder.shutdownSync()` 呼出)

---

## 2026-05-04 - 加藤純一バグ調査ハンドル + スリープ防止機能

- 誰が: Claude Code(Opus 4.7)
- 何を: 2 件の小タスクを 1 タスクで:
  1. 「加藤純一の Twitch 配信が認識されない」バグを **可視化 + 自己修復ハンドル** で対応(リモートで真因確定不可なのでユーザに調査ツールを渡す形)
  2. 録画中の OS スリープ防止(`powerSaveBlocker`)実装

### Part 1 — 加藤純一バグ調査ハンドル

- 真因確定の制約: Claude Code 側からは Twitch API を直接叩けない + ユーザの `userData/config.json` を読めない → 真因 A〜E のどれかは **ユーザが実機で確認する必要**。代わりに「真因が即座にログから読める + 真因 A(stale user_id)なら 1 ボタンで自己修復」の 2 点を整備
- **`twitchHelix.getLiveStreams` 詳細ログ追加**:
  - `[twitch-poll] querying user_ids: [...]` — 投げた user_id リスト
  - `[twitch-poll] response entry: user_id=, user_login=, type=, title=` — Twitch から live で返ってきた個別エントリ(`type=''` = unlisted の検証用)
  - `[twitch-poll] missing (not in response): [...]` — 投げたが返ってこなかった id
  - これで「リクエストに含めてる」「Twitch が live と認識していない」の切り分けが即座に付く
- **「↻ 再取得」ボタン追加**(MonitoredCreatorsView の Twitch 行のみ):
  - 新 IPC `monitoredCreators:refetchTwitch({ twitchUserId })` を main 側に追加
  - 内部で stored `twitchLogin` から `searchUserByLogin()` を呼んで最新の user_id を取得
  - 旧 entry を delete + 新 entry を upsert(`enabled` / `addedAt` は保持)
  - ログ: `[refetch-twitch] <login>: <oldUserId> → <newUserId> (UPDATED)` or `(no change)`
  - UI には alert で「user_id が更新されました: A → B」/「user_id は最新の状態でした(変更なし)。配信検知されない場合は他の原因です」を表示
- **想定原因と切り分けフロー**:
  | ログ症状 | 想定原因 | 対処 |
  |---|---|---|
  | `querying user_ids: [..., kato_id]` + `missing: [kato_id]` で配信中なのに missing | A: stale user_id / B: ログイン名間違い | 「↻ 再取得」 → user_id 更新 → 次 poll で取れるか確認 |
  | `response entry: user_id=kato_id, type=''` | C: Twitch unlisted 配信 | helix/streams の仕様で取れる(type='' でも data[] に入る)→ 自動的に解決 |
  | `querying user_ids:` に kato_id 自体が無い | 登録漏れ / `enabled=false` | 配信者リストで「監視中」が ON か確認 |
  | `[stream-monitor] poll start: 0 twitch` | Twitch 認証情報未設定 | 設定 → Twitch 認証 |

### Part 2 — スリープ防止機能(`src/main/powerSave.ts`)

- Electron `powerSaveBlocker.start('prevent-app-suspension')` を thin wrap
- 「**`prevent-app-suspension`** を選択」the reason: ユーザは寝てる → ディスプレイ ON は不要、CPU + ネットワークだけ生きてれば録画継続。Electron docs 曰く Windows ではこれが system sleep も止める(良い意味で)
- **Reference-counted API**(複数同時録画対応):
  - `acquire(reason)` / `release(reason)` をタグベースで Set 管理
  - 1 個でも acquire されてれば `powerSaveBlocker` は engaged
  - 全 release で `powerSaveBlocker.stop`
  - タグは `recording:<recordingId>` 形式で各 RecordingSession 個別に持つ
- **ライフサイクル**: `streamRecorder.onStreamStarted` 内で `powerSave.acquire(...)` → `onStreamEnded` 内で `powerSave.release(...)` → `app.on('will-quit')` で `releaseAll`(belt-and-braces)
- **`AppConfig.preventSleepDuringRecording`**(default `true`)で gate。default true の理由は spec 通り「録画機能の主用途が深夜無人運用なので、知らずにスリープして録画切れる事故を防ぐ」
- UI: MonitoredCreatorsView のステータスバー直下に `SleepPreventionRow`(🔋 アイコン + チェックボックス + 「録画中: ● 防止 ON」インジケータ + 説明文「ディスプレイは消えても録画は継続します」)
- ログ:
  - `[power-save] blocker started: id=<n>`
  - `[power-save] acquire: recording:<id> (active=N)`
  - `[power-save] release: recording:<id> (active=N)`
  - `[power-save] blocker still active: N consumer(s) — [<list>]`(他に 1 件以上残っている時)
  - `[power-save] blocker stopped (was id=<n>)`(全 release)

### 影響ファイル

- `src/main/twitchHelix.ts`(`[twitch-poll]` debug logs 追加)
- `src/common/types.ts`(`monitoredCreators.refetchTwitch` IPC + `preventSleepDuringRecording` 将来 UI 用)
- `src/preload/index.ts`(`refetchTwitch` expose)
- `src/main/index.ts`(`monitoredCreators:refetchTwitch` IPC handler、`powerSave` import + `will-quit` で `releaseAll`)
- `src/common/config.ts`(`preventSleepDuringRecording` フィールド + DEFAULT)
- `src/main/config.ts`(load/save round-trip)
- `src/main/powerSave.ts`(新規、約 80 行)
- `src/main/streamRecorder/index.ts`(`powerSave.acquire` / `.release` を session start/end に hook)
- `src/renderer/src/components/MonitoredCreatorsView.tsx`(`SleepPreventionRow` + `handleRefetchTwitch` + RegisteredRow に「再取得」ボタン)

### 観察すべき点

- **加藤純一バグの真因が「アカウント名が違う」だった場合**: 「↻ 再取得」では解決しない(`searchUserByLogin` は登録時のログイン名で検索するので、登録時に間違ったログインが入っていれば再取得しても同じログインで再検索 → 同じ結果)。その場合は「削除 → 別の名前で再検索 → 追加」が必要。実機ログで `missing: [...]` が継続するなら hand-edit or 再登録
- **スリープ防止 + ディスプレイ電源**: `prevent-app-suspension` はディスプレイの電源管理は触らない → 通常の電源プラン通りに画面は消える。ユーザは画面消えても安心して寝られる + 録画は CPU レベルで動く
- **`powercfg /requests` で確認**: Windows のコマンドプロンプトで `powercfg /requests` 実行 → SYSTEM セクションに `[PROCESS] electron.exe / jikkyou-cut.exe` が出れば blocker engaged
- **同時録画の reference-count**: 加藤純一 + 柊ツルギの 2 配信同時録画で、片方の手動停止でも blocker は維持(もう片方が active なまま) → 残った 1 件が終わるまでスリープしない
- **`will-quit` での `releaseAll`**: アプリ再起動シナリオで blocker leak しないように。Electron は通常 process exit で OS が回収するが、明示的 release で `powercfg /requests` のクリーンさを保つ
- **加藤純一が YouTube に来ている可能性**: spec 想定原因 D。ユーザが Chrome で確認した URL が `twitch.tv` だったか確認推奨。`youtube.com/@kato` だったら登録プラットフォームを変更

---

## 2026-05-04 - 段階 X3+X4: 配信録画 + 編集統合(自動録画機能シリーズ完成)

- 誰が: Claude Code(Opus 4.7)
- 何を: 配信検知ポーリング(段階 X2)が発火する `streamMonitor:started` / `streamMonitor:ended` イベントを受けて、yt-dlp(主)/ Streamlink(任意)で **配信を自動録画 → 配信終了後に VOD 取り直し → 既存編集画面に流し込む** までの一気通貫を実装。これで自動録画機能シリーズが完成
- 機能シリーズ全体像(完成):
  | 段階 | 内容 | 状態 |
  |---|---|---|
  | X1 | Twitch + YouTube 配信者登録 UI | ✅ 2026-05-03 |
  | X2 | 配信検知ポーリング | ✅ 2026-05-03 |
  | X3.5 | タスクトレイ常駐 | ✅ 2026-05-04 |
  | X3 | 配信開始 → yt-dlp 起動連携(録画本体) | ✅ 2026-05-04(本タスク) |
  | X4 | 録画完了通知 + ファイル管理 + 編集画面連携 | ✅ 2026-05-04(本タスク) |
  | X5 | YouTube ライブ検知精度向上 | 未着手(将来) |

### 設計判断

- **yt-dlp 主役 / Streamlink フォールバック**: spec が想定した「Streamlink 主、yt-dlp フォールバック」を **逆転**。理由:
  - yt-dlp は同梱バイナリ(`resources/yt-dlp/yt-dlp.exe`)で確実に動く
  - Streamlink バイナリは Claude Code が単体ダウンロードできない上、ユーザの手動配置が必要
  - 段階 1-6d で yt-dlp 関連の最適化(JS runtime、cookies、format selector)が既に完成している
  - Streamlink が `resources/streamlink/streamlink.exe` に存在する **時だけ** 優先採用、無ければ yt-dlp が `--live-from-start` で代替。本実装はユーザが今夜何もせずに動く前提
- **`--live-from-start` + `--retries infinite` + `--fragment-retries infinite`**: 通常 DL 系(段階 6d)は `--retries 30 --abort-on-unavailable-fragment` で fragment 失敗を hard error にしているが、ライブは fragment 遅延が日常なので **infinite + no abort** に切り替え。録画中の数秒のジッタで全体を落とすほうが事故
- **VOD 再取得の責務分離**: 既存の `urlDownload.downloadVideoOnly` を流用しない。理由:
  - downloadVideoOnly は output template が `%(title)s.%(ext)s` 固定でファイル名が制御できない
  - 録画は `<recordingId>.vod.mp4` という決定論的な名前が必要(メタデータと整合させるため)
  - downloadVideoOnly は abort-on-unavailable-fragment を付けるが、配信終了直後の VOD 化はちょい遅れがあるので、ここでは別実装が安全
  - → `streamRecorder/vodFetch.ts` で yt-dlp を直接 spawn(cookies / JS runtime / format selector などは流用)
- **VOD 再取得のリトライ戦略**:
  - Twitch: `helix/videos?type=archive&first=1` を取得 → 5 分バックオフ × 3 試行。`published_at` を `startedAt` と比較してアーカイブが「現セッション分」かを確認
  - YouTube: `liveStreamingDetails.actualEndTime` が populated になるまでポーリング → 5 分バックオフ × 4 試行(最長 20 分)。actualEndTime さえ立てば video_id は変わらないので URL は固定
  - どちらも null で帰ってきたら `status='completed'` で確定(live ファイルを最終物として扱う)+ errorMessage に理由を記録。録画自体は失敗扱いにしない
- **メタデータ駆動**: 録画の真実源は `<recordingDir>/<platform>/<creator>/<recordingId>.json`。 in-memory 状態(`active: Map<creatorKey, RecordingSession>`)はあくまで running subprocess の管理用で、UI 表示は always disk から読む。アプリ再起動で active マップは空になるが、ファイルは残る + crash recovery で stale 'recording' を 'failed' にマーク
- **クラッシュ耐性 (boot-time recovery sweep)**: `recoverInterruptedRecordings` が `recording` / `live-ended` / `vod-fetching` のメタを `failed` に書き換える。前プロセスが録画中にクラッシュした場合の partial mp4 / mkv は残し、メタの status を更新するだけなので何度起動しても安全
- **FILE 自動再生サイズ更新**: 15 秒間隔で active session の `refreshFileSizes` → IPC push。renderer の UI が録画中のファイルサイズを段々増やしていく挙動を見せる。stat() 1 回 / 録画 / 15s なので無視できるコスト
- **同時録画上限 5**: spec 通り。回線が住宅向けの想定(平均 100 Mbps)、5 配信同時で実効 ~50 Mbps × 5 = 250 Mbps なので回線の半分使う計算。6 配信目以降は warning ログで黙ってスキップ
- **ディスク空きチェック**: 録画開始前に `freeBytes` で残量取得。50 GB 未満で warning、10 GB 未満で abort。途中で枯渇したら yt-dlp 自体が「No space left on device」で死ぬので、メタ status は 'failed' に推移する
- **`onMetadataChange` コールバック**: RecordingSession は disk + IPC を直接知らない。orchestrator が `deps.onMetadataChange` を渡し、その中で `writeMetadata` + IPC を実行する形にして、テスト容易性 + 責務分離を保つ

### ファイル/フォルダ構造

```
<recordingDir>/                        # 既定: <userData>/recordings
  twitch/
    葛葉_kuzuha/                        # sanitised displayName + creatorKey suffix
      twitch_kuzuha_2026-05-04_03-15-00.json    # メタデータ
      twitch_kuzuha_2026-05-04_03-15-00.live.mkv  # streamlink、または .live.mp4 等(yt-dlp 任せ)
      twitch_kuzuha_2026-05-04_03-15-00.vod.mp4   # yt-dlp 後追い
  youtube/
    加藤純一_UC...../
      youtube_UC...._2026-05-04_04-00-00.{json,live.*,vod.mp4}
```

メタデータ構造例:
```json
{
  "recordingId": "twitch_kuzuha_2026-05-04_03-15-00",
  "platform": "twitch",
  "creatorKey": "kuzuha",
  "displayName": "葛葉",
  "title": "APEX ランクマ",
  "startedAt": "2026-05-04T03:15:00Z",
  "endedAt": null,
  "sourceUrl": "https://www.twitch.tv/kuzuha",
  "files": { "live": "...live.mp4", "vod": null },
  "fileSizeBytes": { "live": 2147483648, "vod": null },
  "status": "recording",
  "folder": "C:\\Users\\Sakan\\AppData\\Roaming\\jikkyou-cut\\recordings\\twitch\\葛葉_kuzuha"
}
```

### IPC 表面

`window.api.streamRecorder.{list, stop, delete, getRecordingDir, revealInFolder, onProgress}`:
- `list()` — メタデータ全件 + 最新 fileSizeBytes
- `stop({ creatorKey })` — 強制停止(graceful → 'live-ended' → 'vod-fetching' → 'completed')
- `delete({ recordingId })` — メタ + live + vod 全削除
- `getRecordingDir()` — 設定 UI 表示用
- `revealInFolder({ recordingId })` — Explorer で該当ファイルをハイライト表示
- `onProgress(cb)` — 'streamRecorder:progress' イベント subscribe

### UI

- **MonitoredCreatorsView** に新セクション「録画済み動画 (N 件、合計 XX GB)」追加。録画行は:
  - 状態バッジ:`recording` / `live-ended` / `vod-fetching` / `completed` / `failed` の色付き表示
  - ファイル合計サイズ + 開始-終了時刻
  - 「編集を開始」ボタン → `closeMonitoredCreators()` → `setFile(absPath)` で既存 ClipSelectView に遷移(ローカルファイル drop と完全同経路)
  - 「フォルダを開く」「停止」「削除」アクション
- **SettingsDialog → 動画ダウンロードタブ** に「自動録画」セクション追加:
  - 自動録画 ON/OFF(初回 ON で disclaimer dialog)
  - 録画品質ラジオ(best / 1080p / 720p)
  - VOD 取り直しチェックボックス
  - 録画フォルダ表示 + パスをコピー
- **disclaimer dialog**: 「配信者の許諾を得たコンテンツのみで使用してください」「無断録画は規約違反の可能性があります」「自己責任です」 → 「はい、許諾を得ている」で `recordingDisclaimerAccepted = true` 永続化、以降は出ない

### ストリームモニター連携の追加 API

段階 X3.5 で `subscribeStatus(cb)` を追加していたのを、`subscribeStreamStarted(cb)` / `subscribeStreamEnded(cb)` まで拡張。in-process subscriber が同じイベントを IPC 経由でなく直接受け取れる。recorder はこれで反応する

### 影響ファイル

- `src/common/config.ts`(`recordingEnabled` / `recordingDir` / `recordingQuality` / `recordingVodFallback` / `recordingDisclaimerAccepted` 5 フィールド + DEFAULT)
- `src/common/types.ts`(`RecordingMetadata` / `RecordingStatus` / `RecordingProgressEvent` 型 + IpcApi に `streamRecorder` namespace)
- `src/main/config.ts`(load/save round-trip)
- `src/main/twitchHelix.ts`(`getLatestArchiveVod` + `parseTwitchDuration` 追加)
- `src/main/streamMonitor/index.ts`(`subscribeStreamStarted` / `subscribeStreamEnded` 追加 + `send` 内分岐)
- `src/main/streamRecorder/storage.ts`(新規、約 180 行 — メタ I/O + crash recovery + freeBytes + sanitise / formatStartedAt ヘルパ)
- `src/main/streamRecorder/recordSession.ts`(新規、約 170 行 — yt-dlp / streamlink subprocess ライフサイクル)
- `src/main/streamRecorder/vodFetch.ts`(新規、約 160 行 — Twitch / YouTube VOD URL 解決 + downloadVod)
- `src/main/streamRecorder/index.ts`(新規、約 240 行 — orchestrator)
- `src/main/index.ts`(`streamRecorder` import + boot + IPC 5 handler + monitor subscription + window attach)
- `src/preload/index.ts`(`streamRecorder` namespace expose)
- `src/renderer/src/components/MonitoredCreatorsView.tsx`(録画状態の useState + onProgress 購読 + handleOpenInEditor / handleStopRecording / handleDeleteRecording / handleRevealRecording + 「録画済み動画」セクション + `RecordingRow` + `formatBytes` / `formatDateRange`)
- `src/renderer/src/components/SettingsDialog.tsx`(`RecordingSettingsSection` + `RecordingDisclaimer` 追加)

### 観察すべき点

- **深夜長時間運用のリスク**:
  - yt-dlp プロセス stdout/stderr バッファ枯渇 → これは yt-dlp 側の onhandlers で読み出し続けているので問題なし
  - ディスク full → 自動 abort 経路あり、stale 'recording' は次回起動の crash recovery で 'failed' にマーク
  - **PC スリープ問題**: spec 範囲外。Windows のスリープ許可状態で寝かせると録画中でもスリープ → 録画切れる。`powercfg /requestsoverride PROCESS jikkyou-cut.exe SYSTEM` 等の対策は将来検討
- **Streamlink の有無**:
  - 現状 `resources/streamlink/streamlink.exe` は **同梱されていない**
  - streamRecorder は startup 時の検出で yt-dlp フォールバックに transparent に切替
  - ユーザ後配置手順は完了報告に明記
- **Twitch アーカイブ無効化**: 配信者が Twitch 設定で「過去の配信を保存」OFF にしてると VOD 化されない → `getLatestArchiveVod` が null で帰ってくる → `status='completed'` + errorMessage 「VOD unavailable」で完了。live 録画は手元に残るので最低限価値あり
- **YouTube 処理待ち時間**: 長配信(6 時間以上)は actualEndTime セット後も「処理中」状態が長引くことあり。yt-dlp 自体は処理中でも DL 開始するが、最初に取れた時点のフッテージが時間ベースで欠ける可能性。X5 でリトライ拡張検討
- **同時録画 5 制限**: 段階 X1 で 50 配信者まで登録可能なので、運悪く 6 人同時に live → 6 人目以降スキップ。実害は低い(深夜帯に同時 6 配信は稀)が、UI で「録画スキップしました」通知を出す改善余地
- **ファイル名サニタイズ**: 配信タイトルは保存しない(folder 名は creator displayName のみ)。yt-dlp の `%(title)s` を使うと配信途中のタイトル変更で混乱するので、recordingId を ID として使用 → タイトルはメタの `title` フィールドにのみ保存
- **編集連携**: `handleOpenInEditor` は `closeMonitoredCreators` → `setFile` の 2 段階。setFile が `phase: 'clip-select'` に遷移するので、registered-channels phase からの戻り遷移と setFile の遷移が race することはない(closeMonitoredCreators の set 完了後に setTimeout 0 で setFile を流す)

---

## 2026-05-04 - タスクトレイ常駐機能(段階 X3.5)

- 誰が: Claude Code(Opus 4.7)
- 何を: ウィンドウ ✕ ボタンを「タスクトレイに最小化」に変更し、PC 起動からずっと配信検知 / 録画(段階 X3 で実装予定)を動かせる土台を整えた
- 機能シリーズ全体像(更新):
  | 段階 | 内容 | 状態 |
  |---|---|---|
  | X1 | Twitch + YouTube 配信者登録 UI | ✅ 2026-05-03 |
  | X2 | 配信検知ポーリング | ✅ 2026-05-03 |
  | X3.5 | タスクトレイ常駐 + Windows 自動起動(本タスク、X3 の前提インフラ) | ✅ 2026-05-04 |
  | X3 | 配信開始 → yt-dlp 起動連携(録画本体) | 🔜 次タスク |
  | X4 | 録画完了通知 + ファイル管理 | 未着手 |
  | X5 | YouTube ライブ検知精度向上 | 未着手 |

### 設計判断

- **Windows 専用**: spec の方針通り。`process.platform === 'win32'` ガードで macOS / Linux は no-op(close 処理 + tray 作成 + loginItemSettings の 3 箇所)。**X-button が macOS で従来挙動のまま動くことを保証**
- **`closeToTray` のデフォルト ON**: アプリの本質が「配信を見逃さず録画する」なので、誤クリックで監視が止まる方が事故。spec が「ユーザの意図しない挙動を避けるためデフォルト OFF にしてもいい」としていたが、初回 hide 時のバルーン通知で挙動を伝える形で **デフォルト ON を採用**。バルーンは 1 プロセス 1 回だけ
- **同期判定の `cachedCloseToTray`**: Electron の `close` event は同期的に `preventDefault()` を呼ぶ必要があるので、`loadConfig()` の await を挟めない。boot 時 + `settings:save` IPC で常に最新値をキャッシュ
- **`actuallyQuit()` の単一経路**: 「✕ ボタンで quit に逃げない」を保証するため、本当に終了する経路は明示関数 `actuallyQuit()` を経由。`isQuitting` フラグで close handler が抜ける
- **メニュー Quit を `role: 'quit'` から click handler に**: `role: 'quit'` は内部で `app.quit()` を呼ぶが、これは `before-quit` 経由で各ウィンドウに `close` を送る → close handler が hide に化けて quit が止まる事故。click → `actuallyQuit()` で確実に抜ける
- **`before-quit` で `isQuitting = true`**: タスクトレイ右クリック「終了」が走った時の保険。`actuallyQuit()` は `isQuitting=true` 設定済だが、外部経路(macOS の Cmd+Q 等)を考えるとここでも立てておく
- **シングルインスタンス**: `requestSingleInstanceLock()` を **モジュールトップレベル** で呼ぶ。`app.whenReady()` 内に置くとタイミング依存になるため、最早タイミングで判定 + quit。`second-instance` イベントで既存ウィンドウを surface

### Windows 自動起動(`loginItemSettings`)

- Electron の `app.setLoginItemSettings({ openAtLogin, args })` で Windows のスタートアップ登録/解除
- `args: ['--minimized']` でブートランチ時の引数を制御。process.argv で受け取って `mainWindow.hide()`
- 適用タイミング: boot 時(`app.whenReady` で `applyLoginItemSettings(cfg)`)+ 設定変更時(`settings:save` IPC が saveConfig 後に呼ぶ)。idempotent なので頻繁な呼び出しは無問題
- `startMinimized` は `startOnBoot` ON 時のみ有効化(checkbox の disabled 制御 + UI 文言で明示)

### タスクトレイのインフラ

- `src/main/tray.ts` 新規。シングルトン `tray: Tray | null`
- アイコン 2 種類(プレースホルダ生成):
  - `resources/tray-icon.png`(32×32、青背景 + 白「JC」) — 通常状態
  - `resources/tray-icon-live.png`(同 + 右上の赤ドット) — 配信中状態
  - PowerShell `System.Drawing` で生成。配布段階で正式デザインに差し替える前提
  - `package.json` の `extraResources` に登録 → packaged build にも同梱
- 左クリック: ウィンドウの toggle visibility(Twitch / Discord / 1Password と同様の idiom)
- 右クリックメニュー: 「jikkyou-cut を開く」「登録チャンネル を開く」(ショートカット導線) /「配信監視: ●」(disabled、informational) /「終了」
- 「登録チャンネル を開く」: ウィンドウを show → 次 tick で renderer に `menu:openMonitoredCreators` 送信(直送だと hide → show のレースで React hydration と衝突)
- 配信中インジケータ: tooltip(`jikkyou-cut(N 人配信中)`)+ アイコン swap + メニュー label。`StreamMonitor` が in-process subscriber として tray を呼び出す

### `StreamMonitor.subscribeStatus()` 追加

- 段階 X2 では status 通知は IPC のみだった
- 段階 X3.5 で tray が in-process で同じ status を欲しがる → IPC は self-loop でナンセンス
- `subscribeStatus(listener)` 追加: in-process listener を Set で管理、`send('streamMonitor:status', payload)` 内で IPC + listeners 両方に流す
- subscribe 時に `getStatus()` を即時 push → 新規 subscriber が次 poll を待たずに最新状態を見られる

### 影響ファイル

- `src/common/config.ts`(`closeToTray` / `startOnBoot` / `startMinimized` フィールド + DEFAULT)
- `src/main/config.ts`(load/save round-trip)
- `src/main/tray.ts`(新規、約 160 行)
- `src/main/streamMonitor/index.ts`(`subscribeStatus()` + `statusListeners` Set + `send` で in-process フォーク)
- `src/main/menu.ts`(`buildMenu` シグネチャ変更: `{ getMainWindow, onQuit }`、`role: 'quit'` → click handler)
- `src/main/index.ts`(`isQuitting` / `launchedMinimized` / `cachedCloseToTray` 状態 + `showMainWindow` / `actuallyQuit` / `applyLoginItemSettings` ヘルパ + close handler + single-instance lock + second-instance handler + tray creation + tray live-count subscription + before-quit + will-quit)
- `src/renderer/src/components/SettingsDialog.tsx`(一般タブにタスクトレイ + PC 起動時の checkbox 3 個 + ヒント文)
- `package.json`(`extraResources` に tray-icon 2 ファイル追加)
- `resources/tray-icon.png`(新規、378 bytes)
- `resources/tray-icon-live.png`(新規、570 bytes)

### 観察すべき点

- **BrowserWindow ライフサイクル**: window-all-closed が発火しなくなる(close → hide で window はずっと存在)。`isQuitting` ガードを忘れると Linux / 非トレイ環境でアプリが終了しなくなる
- **Renderer のバックグラウンド挙動**: hide されたウィンドウの renderer は React 自体は生きているが、`requestAnimationFrame` は paused される。段階 X3 で録画 UI を出すなら、進捗表示が止まる現象が出るかもしれない。録画進捗は main → IPC pull モデルで作る方針で OK
- **multi-monitor / DPI**: 32×32 のアイコンは標準 DPI 想定。HiDPI モニタでぼやける可能性 → 配布前に 16/32/48px の multi-resolution `.ico` 生成検討
- **トレイバルーン通知**: Windows 10/11 ではモダントーストに置き換わる過渡期で、`displayBalloon` は内部で適切に shim されるが、グループポリシーで通知禁止されている環境では失敗する。失敗は cosmetic のみ
- **autorun + 多重起動**: Windows で「スタートアップ + 既起動チェック」を組み合わせた時、PC 起動時に jikkyou-cut が `--minimized` で起動 → ユーザがデスクトップから手動でショートカットダブルクリック → second-instance 検知 → 既存(隠れてる)ウィンドウを show。実機検証推奨
- **段階 X3 への接続**: 録画機能は背景動作を前提に設計可能。`streamMonitor:started` イベント受信 → main で yt-dlp 起動 → 録画完了で `streamMonitor:recording-done` を tray + UI に通知、というフローが綺麗に組める

---

## 2026-05-03 - 配信検知ポーリング機構(段階 X2/X4)

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 X1 完成版で登録した配信者を **1 分間隔で定期チェック** し、配信開始 / 終了を検知する機構を実装。**録画は段階 X3、トースト通知は段階 X4 のため本タスクではしない**。最低限の UI フィードバック(登録チャンネル画面の配信中バッジ + メイン画面のフローティング指示)は入れた
- 機能シリーズ全体像(更新):
  | 段階 | 内容 | 状態 |
  |---|---|---|
  | X1 | Twitch + YouTube 配信者登録 UI | ✅ 2026-05-03 |
  | X2 | 配信検知ポーリング(本タスク、Twitch + YouTube、1 分間隔、配信開始/終了イベント発火) | ✅ 2026-05-03 |
  | X3 | 配信開始 → yt-dlp 起動連携(録画本体) | 🔜 次タスク |
  | X4 | 録画完了通知 + ファイル管理 | 未着手 |
  | X5 | YouTube ライブ検知精度向上(scheduledStartTime 活用、ライブ予定リマインド) | 未着手 |

### 設計判断

- **ポーリング間隔 = 1 分(`POLL_INTERVAL_MS = 60_000`)**: spec 通り。Twitch のレート制限(800 req/min)からは桁違いに余裕。YouTube は quota がボトルネックなので RSS 経由で削減
- **多重実行防止**: `inflight` フラグ。スリープ復帰直後など、setInterval がバーストで発火しても次の tick まで早期 return
- **状態は in-memory Map**: `Map<'platform:id', LiveStreamInfo>`。プロセス再起動で消えるが、再 poll で 1 分以内に再構築されるので永続化不要(spec 準拠)
- **イベント発火タイミング**: 各 poll の最後に「前回 set との差分」を計算して `streamMonitor:started` / `streamMonitor:ended` を発火。`streamMonitor:status` は **毎 poll 必ず** 発火(UI 上の last-poll タイムスタンプを更新するため)
- **detectedAt の不変性**: ポーリングを跨いで配信中状態が継続している場合、`detectedAt` は最初に検知した時刻のまま据え置く(UI で「X 分前から配信中」を計算するため、tick 毎に更新したらカウントがリセットしてしまう)

### YouTube quota 戦略 — RSS feed が主役

`search.list?eventType=live` (100 quota / channel / poll) は単純に高すぎるので採用せず。代わりに:

1. **RSS feed**(`https://www.youtube.com/feeds/videos.xml?channel_id=UCxxx`)で channel の最近 15 件動画 ID を取得 — **0 quota**(API key 不要、公開 XML)
2. 上位 5 件を `videos.list?part=liveStreamingDetails`(1 quota / 50 ids batched)に投げて、`actualStartTime` あって `actualEndTime` 無いものが live
3. 1 channel あたり: RSS 0 quota + videos.list 1 quota = **1 quota**

**比較**:
| 方式 | 1 channel 1 poll | 10 channel × 1440 poll/day | 必要 key 数(10K/key/day) |
|---|---|---|---|
| `search.list` 方式 | 100 quota | 1,440,000 quota/day | **144 個** |
| RSS + `videos.list` 方式 | 1 quota | 14,400 quota/day | **2 個** |

RSS パースは正規表現で `<yt:videoId>([A-Za-z0-9_-]{11})</yt:videoId>` を grep。xml2js 等のフルパーサは過剰なので不採用。フィードフォーマット変更で破綻したら `[stream-monitor] youtube RSS fetch failed` ログで気付く

### 信頼性のトレードオフ

- **RSS のラグ**: 配信開始から RSS 反映まで数秒〜十数秒。1 分間隔 poll なら無視できるレベル
- **Premiere の扱い**: feed には載るが `actualStartTime` が空の状態で予約。実際にライブ化してから `actualStartTime` が埋まる → 正しく live として検知される
- **検知漏れの可能性**: 短時間配信(5 分以内)が poll 間隔の谷に挟まると見逃す。これは段階 X3 の録画機能には致命的でないが、段階 X4 で「気付いたら録画開始」体験を高めるなら間隔短縮 or EventSub への移行検討

### 配置

- `src/main/streamMonitor/index.ts` — `StreamMonitor` クラス + シングルトン export。ポーリングループ + 状態管理 + IPC 通知
- `src/main/streamMonitor/twitchPoll.ts` — `pollTwitchUsers(clientId, secret, userIds)` の薄いラッパ。エラーは log + 空 Map で吸収
- `src/main/streamMonitor/youtubePoll.ts` — RSS fetch + parse + `videos.list` ハンドリング。チャンネル毎の RSS フェイルは個別吸収(他のチャンネルは続行)
- `src/main/twitchHelix.ts` — 既存の `getStreamStatus`(単一 user_id)に加えて `getLiveStreams(userIds)`(配列、最大 100 ids/req batch)を追加
- `src/main/dataCollection/youtubeApi.ts` — `fetchVideoLiveDetails(videoIds)`(videos.list?part=liveStreamingDetails、最大 50 ids/req batch、1 quota)追加

### IPC

`window.api.streamMonitor`:
- `getStatus()` — 現在の `{ enabled, isRunning, lastPollAt, nextPollAt, liveStreams[] }`
- `setEnabled(enabled)` — toggle、`saveConfig({ streamMonitorEnabled })` + `start()`/`stop()` + 即時 status 返却
- `pollNow()` — 手動再 poll(UI の「今すぐ」ボタン用)
- `onStatus(cb)` / `onStreamStarted(cb)` / `onStreamEnded(cb)` — イベント subscribe(unsubscribe を返す)

### UI

- **登録チャンネル画面** に `MonitorStatusBar` セクション追加(画面トップ): 監視 ON/OFF チェックボックス + 「最終チェック: N 分前 / 次回: N 分後」ラベル + 「今すぐ」ボタン + 配信中人数表示
- **`RegisteredRow`** に `liveStream` prop 追加: 配信中の場合、配信タイトル(リンク化、外部ブラウザで開く)+ 「配信中(N 分前から)」赤バッジ表示。サブテキストは配信中時 → 配信タイトル / 非配信時 → handle/login
- **App.tsx に floating 指示子**: `liveCount > 0` のとき右上に固定の「N 人配信中」ピル状ボタン。クリックで登録チャンネル画面に飛ぶ。`monitored-creators` / `api-management` phase は早期 return で除外、編集系 phase(load / clip-select / edit)でのみ表示
- 60 秒 tick で「N 分前」表示を更新(再 poll を待たずに UI を進ませる)

### AppConfig

- `streamMonitorEnabled: boolean`(default `false`)
- データ収集と同じ「永続マスタースイッチ」パターン: 起動時に `streamMonitorEnabled === true` ならポーリング自動開始
- `monitoredCreators[].enabled` は **per-creator のフィルタ**(段階 X1 で予約済)。`streamMonitorEnabled` がマスター、`creator.enabled` が個別。両方 `true` でないと poll 対象外

### エラー処理

- Twitch credentials 未設定: 起動時に `[stream-monitor] twitch creators registered but credentials not set` 警告 → Twitch 分岐スキップ、YouTube 分岐は続行
- Twitch 401(token 期限): `helixGetWithRefresh` が内部 retry-once、二回目も 401 なら helix 側でエラー throw → twitchPoll が log + 空 Map で吸収 → 全体は継続
- Twitch 429: `helixGet` のリトライループで 5s × 3 retry、超えたら同上
- YouTube RSS タイムアウト(8s): channel 毎にスキップ、他は継続
- YouTube quota 超過: `callApi` が key を `markDailyDisabled` → 残 key でローテーション、全部 disable なら null 返却 → live 取得失敗、その channel はスキップ
- ネットワーク全体失敗: `poll()` の `try/catch` で吸収、次の interval で再試行

### 影響ファイル

- `src/common/config.ts`(`streamMonitorEnabled` フィールド + DEFAULT)
- `src/common/types.ts`(`LiveStreamInfo` / `StreamMonitorStatus` 型 + IpcApi に `streamMonitor` namespace)
- `src/main/config.ts`(`streamMonitorEnabled` の load/save round-trip)
- `src/main/twitchHelix.ts`(`getLiveStreams` バッチ + `TwitchLiveStream` 型)
- `src/main/dataCollection/youtubeApi.ts`(`fetchVideoLiveDetails` + `VideoLiveDetail` 型)
- `src/main/streamMonitor/index.ts`(新規、`StreamMonitor` クラス、約 200 行)
- `src/main/streamMonitor/twitchPoll.ts`(新規、薄いラッパ)
- `src/main/streamMonitor/youtubePoll.ts`(新規、RSS パース + `videos.list` 呼び出し)
- `src/main/index.ts`(`streamMonitor` import + `attachWindow` + IPC 3 handler + autostart)
- `src/preload/index.ts`(`streamMonitor` namespace expose + イベントリスナー)
- `src/renderer/src/components/MonitoredCreatorsView.tsx`(`MonitorStatusBar` + `LiveBadge` + `liveByKey` map + 60s tick)
- `src/renderer/src/App.tsx`(global live-count subscription + floating indicator)

### 観察すべき点

- **YouTube quota の実測**: 配信者数 × 1440 poll/day × ~1 quota/poll = N 日のキー消費。段階 X3 で録画頻度高めると視聴者数が増えてサムネ更新も増えるかも。実機で 1 週間 quota ログを観測したい
- **RSS パース崩壊**: YouTube が atom feed フォーマット変えたら `<yt:videoId>` regex が外れる。検出方法: `[stream-monitor] poll done` で 0 件しか出ない状態が連続 → ログ確認
- **配信中状態の永続化**: 再起動で消えるので、再起動直後の 1 分間は「誰も live じゃない」表示になる。spec 準拠だが UX で気になるなら lastPollAt + liveStreams を userData に書く案あり(将来 TODO)
- **floating indicator の被り**: 編集 phase で右上にあるボタン群と重なる可能性。`top: 8, right: 12` で位置調整したが、ヘッダ右側のボタンと衝突したら z-index / 配置見直し
- **multiple windows のサポート**: `attachWindow` が 1 ウィンドウしか覚えない。macOS で `Cmd+N` 等で複数ウィンドウ開かれた場合、最後に open したウィンドウだけにイベントが届く。本アプリは single-window 前提なので OK
- **段階 X3 の準備状況**: `LiveStreamInfo.url` が録画 URL として使える(Twitch は `https://www.twitch.tv/<login>` で live を yt-dlp に渡せる、YouTube は `https://www.youtube.com/watch?v=<videoId>` で OK)。`videoId` / `streamId` も保持しているので X3 の録画スクリプト書きやすい

---

## 2026-05-03 - 段階 X1 完成版: 登録チャンネル画面 + Gemini 検索 + YouTube 両対応

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 X1 初版で「設定 → 配信者管理タブ」「Twitch のみ」「ログイン名直接検索」だった構造を、ユーザの新ビジョンに沿って大幅に作り直した:
  1. 設定ダイアログのタブから **メイン画面のメニュー(登録チャンネル)経由の全画面ビュー** に移動
  2. Twitch-only から **YouTube + Twitch 両対応** に拡張
  3. ログイン名直接検索ではなく、**Gemini に日本語名で問い合わせ → 各プラットフォームの API でプロフィール解決** の 2 段階フロー
  4. 「追加」前に **必ず確認ダイアログ**(誤登録防止)
- 経緯:
  - 段階 X1 の初版を実装した直後、ユーザから「設定画面の中に隠れているのは導線として弱い」「最終的に YouTube も対象にしたい」「ログイン名なんて覚えてられない、表示名で検索したい」というフィードバック
  - 録画機能(段階 X3)のメイン画面導線として全画面ビューが自然
  - Gemini 経由にすると VTuber / 配信者の表示名 ↔ プラットフォーム ID のマッピング知識を活用できる(2.5-flash モデルの一般知識で十分)
- 機能シリーズ全体像(変更なし):
  | 段階 | 内容 | 状態 |
  |---|---|---|
  | X1 | Twitch + YouTube 配信者登録 UI(本タスクで完成) | ✅ |
  | X2 | 配信検知ポーリング | 🔜 次タスク |
  | X3 | yt-dlp 起動連携(録画本体) | 未着手 |
  | X4 | 録画完了通知 + ファイル管理 | 未着手 |
  | X5 | YouTube ライブ検知の Live Streaming API 実装 | 未着手(段階 X1 完成版で型は既に YouTube 対応済) |

### 実装内容

- **Gemini 検索アプローチ**:
  - `src/main/gemini.ts` に `generateTextWithRotation(prompt)` 追加 — Files API を使わない純テキスト generateContent 呼び出し、`responseMimeType: 'application/json'` 強制、既存の `GeminiKeyRotator` を再利用(401/403 → 24h mute、429/5xx → 60s mute)
  - `src/main/creatorSearch.ts` 新規 — Gemini プロンプト + Twitch/YouTube プロフィール解決
  - プロンプト: 「VTuber / 配信者の知識データベースとして、YouTube と Twitch の handle / login と confidence を JSON で返せ」
  - confidence は `'high' | 'medium' | 'low'` の 3 段階、UI で `'low'` を「不確実(要確認)」バッジ表示 + 確認ダイアログでも警告強調
  - `stripFences` ヘルパで code-fence 付きで返ってきた場合のフォールバック(responseMimeType 指定でも稀に fence 付きで返す)
- **YouTube プロフィール解決の cheap-first ordering**:
  - `src/main/dataCollection/youtubeApi.ts` に `getChannelByHandle(@xxx)` / `getChannelById(UCxxx)` 追加(各 1 unit)
  - `creatorSearch.fetchYouTubeProfile` のロジック:
    1. handle 指定あり → `channels.list?forHandle=` を 1 unit で試す
    2. 失敗 → `searchChannelByName(query)` を 100 unit で(段階 X1 既存)
    3. ヒット → `channels.list?id=` を 1 unit で thumbnail 含む詳細取得
    4. 全 fail → null
  - 50 キーローテーション機構をそのまま再利用、quota は SQLite に per-key/per-day 記録される既存メカ
- **MonitoredCreator 型のマイグレーション**:
  - 旧(段階 X1 初版): `{ platform: 'twitch'; userId; login; ... }`
  - 新: discriminated union `'twitch'` / `'youtube'`
    - Twitch: `twitchUserId` / `twitchLogin`
    - YouTube: `youtubeChannelId` / `youtubeHandle`
  - load 時に **旧フィールド名(`userId`/`login`)も認識** して新フィールド名(`twitchUserId`/`twitchLogin`)に翻訳。次回 save で自動的に新形式で書き直される
  - 共通フィールド: `platform`、`displayName`、`profileImageUrl`、`addedAt`、`enabled`
  - `monitoredCreatorKey(c)` ヘルパで platform-stable id を取得(IPC remove/setEnabled の key)
  - **同一人物が両プラに居る場合、別エントリとして登録**(段階 X3 で異なる URL から録画するため)
- **画面遷移**:
  - `EditorPhase` に `'monitored-creators'` 追加、`RestorablePhase` から除外(swap-in phase なので previousPhase に積まれない)
  - `openMonitoredCreators` / `closeMonitoredCreators` アクションを `editorStore` に追加 — `openApiManagement` / `closeApiManagement` と完全同形
  - 両 swap-in phase 間の相互遷移は **早期 return で禁止**(`previousPhase` の不変条件を壊さないため)
  - メニュー: `登録チャンネル`(`Ctrl+Shift+M`)→ IPC `menu:openMonitoredCreators` → store action 経由で phase swap
- **IPC 再編**:
  - 削除: `twitch:searchUserByLogin`、`twitch:listMonitoredCreators`、`twitch:addMonitoredCreator`、`twitch:removeMonitoredCreator`、`twitch:setCreatorEnabled`(段階 X1 初版)
  - 残存: `twitch:getClientCredentials`、`setClientCredentials`、`clearClientCredentials`、`testCredentials`(認証管理)
  - 新規: `creatorSearch:askGemini`、`fetchTwitchProfile`、`fetchYouTubeProfile`、`monitoredCreators:list`、`add`、`remove`、`setEnabled`
  - 設定 IPC は **monitoredCreators の add/remove/setEnabled の 3 操作だけ** で済む(`add` は idempotent: 既存 entry は `addedAt`/`enabled` 保持しつつ in-place 置換)
- **UI 構造**:
  - `MonitoredCreatorsView.tsx`(新規)— 全画面、3 セクション(検索 / 検索結果カードグリッド / 登録済みリスト)
  - 検索結果カード: アイコン + 表示名 + handle/login + プラットフォームタグ(色分け) + 「追加」ボタン(既登録なら disabled「登録済み」)
  - 確認ダイアログ: backdrop クリックでキャンセル、`stopPropagation()` で内部クリックは閉じない、low confidence 時は警告バナー追加
  - 登録済み行: アイコン + 表示名 + handle/login + プラタグ + 監視中チェックボックス(段階 X2 用) + 削除ボタン(`window.confirm` 経由)
- **設定ダイアログのタブ再編**:
  - 旧: `general` / `download` / `creators`(段階 X1 初版)
  - 新: `general` / `download` / `twitch-auth`
  - `creators` タブ → 全画面 `MonitoredCreatorsView` に移動
  - `twitch-auth` タブは旧 `CreatorManagementTab` の認証セクションだけを抽出した `TwitchAuthTab.tsx`(新規)
  - 旧 `CreatorManagementTab.tsx` 削除
  - `general` タブの「配信者の自動録画」説明文を「メニュー → 登録チャンネル」へ誘導するように更新

### 不採用案

- 確認ダイアログをスキップするオプション → 「誤登録防止」明示要件、UX 高速化より安全性優先
- 検索履歴 / お気に入り → 過剰実装、登録は数十件規模なので不要
- マイグレーション失敗時の rollback → 壊れたら手動で config.json 削除、復元価値より複雑度コスト
- 検索候補のサジェスト → Gemini 1 回で済むので不要
- Gemini-2.5-flash 以外のモデル指定 → 既存の MODEL 定数を流用、用途特化しない

### 影響ファイル

- `src/common/config.ts`(MonitoredCreator → discriminated union、`monitoredCreatorKey` ヘルパ)
- `src/common/types.ts`(IpcApi に `creatorSearch` / `monitoredCreators` namespace、`onMenuOpenMonitoredCreators` 追加、旧 twitch namespace 削減)
- `src/main/config.ts`(`normaliseMonitoredCreators` でレガシー Twitch shape を新形式に翻訳)
- `src/main/menu.ts`(「登録チャンネル」エントリ追加)
- `src/main/gemini.ts`(`generateTextWithRotation` 追加)
- `src/main/dataCollection/youtubeApi.ts`(`getChannelByHandle` / `getChannelById` 追加)
- `src/main/creatorSearch.ts`(新規)
- `src/main/index.ts`(IPC 再編 — 旧 twitch:list/add/remove/setEnabled 削除、新 creatorSearch / monitoredCreators IPC 追加、`monitoredCreatorKey` import)
- `src/preload/index.ts`(creatorSearch / monitoredCreators namespace expose、onMenuOpenMonitoredCreators)
- `src/renderer/src/store/editorStore.ts`(monitored-creators phase + openMonitoredCreators / closeMonitoredCreators)
- `src/renderer/src/App.tsx`(monitored-creators phase の早期 return + menu listener + import)
- `src/renderer/src/components/MonitoredCreatorsView.tsx`(新規、約 380 行)
- `src/renderer/src/components/MonitoredCreatorsView.module.css`(新規)
- `src/renderer/src/components/TwitchAuthTab.tsx`(新規、旧 CreatorManagementTab の auth セクション抽出)
- `src/renderer/src/components/SettingsDialog.tsx`(creators タブ → twitch-auth タブ、CreatorManagementTab → TwitchAuthTab import)
- `src/renderer/src/components/CreatorManagementTab.tsx`(削除)

### 観察すべき点

- **Gemini の精度**: 2.5-flash の VTuber 知識カバレッジ。小規模 / 新人配信者は `confidence='low'` か null になる可能性。実機で「柊ツルギ」「葛葉」「加藤純一」など主要配信者で当てて、精度を計測
- **YouTube quota**: cheap-first ordering(handle が当たれば 1 unit、外れたら 100+1 unit)の効果測定。検索フォーム連打されても 50 keys × 10K/day で大丈夫だが、handle が常に外れるケース(マイナーな配信者多用)で quota 食う可能性あり
- **Twitch Client Credentials の token キャッシュ**: 段階 X1 初版で実装した token キャッシュが `creatorSearch.fetchTwitchProfile` でも効くこと(同じ `searchUserByLogin` を呼んでいる)。複数連続検索でトークン取り直し発生しないことを実機で確認
- **マイグレーション動作**: 段階 X1 初版で Twitch 配信者を登録していたユーザの config.json が、新形式で読み込まれて再保存されること。レガシーフィールド `userId`/`login` が次回 save で消えること
- **Gemini API キー未設定時**: `generateTextWithRotation` が `'Gemini API キーが未設定です'` を throw → UI で `error` ステータス表示。API 管理画面への誘導はまだ無い(将来 TODO)
- **YouTube API キー未設定時**: `searchChannelByName` / `getChannelByHandle` が null を返す → 検索結果に YouTube カードが出ない。ユーザが「あれ?」となる可能性、API 管理画面への誘導文言を将来 UX 改善
- **handle の正規化**: `@` プレフィックスの有無を `normaliseHandle` で吸収しているが、Gemini が `@` 抜きで返してきた場合は自動で `@` 補完される

---

## 2026-05-03 - 配信者自動録画機能シリーズ 段階 X1: Helix クライアント + 配信者登録 UI

- 誰が: Claude Code(Opus 4.7)
- 何を: 新機能シリーズ(Twitch 配信者を登録 → 配信開始検知 → 自動録画 → 通知)の **段階 X1 のみ**。 Helix API クライアント実装 + 配信者登録 UI まで。**録画機能は段階 X3、ポーリングは段階 X2、通知は段階 X4** で別タスク化
- 機能シリーズの全体像:
  | 段階 | 内容 | 状態 |
  |---|---|---|
  | X1 | Twitch Helix クライアント + 配信者登録 UI | ✅ 本タスク |
  | X2 | 配信検知ポーリング(`getStreamStatus` 定期呼出) | 未着手 |
  | X3 | 配信開始検知 → yt-dlp 起動連携(録画本体) | 未着手 |
  | X4 | 録画完了通知 + ファイル管理 | 未着手 |
  | X5 | YouTube 対応(`MonitoredCreator.platform = 'youtube'` 拡張) | 未着手 |
- 実装内容:
  - **新規 `src/main/twitchHelix.ts`**(約 270 行):
    - **Client Credentials flow** で OAuth token 取得(`https://id.twitch.tv/oauth2/token`、grant_type=client_credentials)。app token なので scope なし、read-only 公開エンドポイント(helix/users / helix/streams)用
    - メモリトークンキャッシュ + fingerprint(`clientId.length:clientId:secret.length`)で credentials 切替を検知
    - 並行リクエストの dedupe(`inflightToken` プロミス共有)
    - **expiresAt - 60s 余裕** で proactive refresh、401 で自動 retry-once + キャッシュクリア
    - `searchUserByLogin(login)` — `helix/users?login=X`、見つからなければ null(throw しない、UI で「ユーザが見つかりません」表示)
    - `getStreamStatus(userId)` — `helix/streams?user_id=X`、empty data[] = `{ isLive: false }` で正規化(段階 X2 が使う、本タスクでは「認証テスト」の代替として役に立つ予定だが今は未使用)
    - 429 rate limit は 5s × 3 retry、404 / 401 / 403 / network error は別文言で throw
    - 各 fetch に 10s timeout(AbortController)
  - **secureStorage に Twitch スロット追加**:
    - `userData/twitchClientSecret.bin`(DPAPI 暗号化)
    - 既存 Gladia / Anthropic / YouTube / Gemini と同じ `saveAt`/`loadAt`/`deleteAt`/`existsAt` パターン
    - **renderer に生 Secret を返す API は無い**(`hasTwitchSecret` で presence のみ返す)
  - **AppConfig 拡張**:
    - `twitchClientId: string \| null`(平文、公開情報)
    - `monitoredCreators: MonitoredCreator[]`(配信者リスト)
    - 新型 `MonitoredCreator { platform: 'twitch'; userId; login; displayName; profileImageUrl; addedAt; enabled; }` を `src/common/config.ts` に追加。platform は段階 X5 で `'youtube'` 拡張予定の discriminator
    - load/save round-trip + `normaliseMonitoredCreators` でドロップ malformed エントリ + dedup userId
    - DEFAULT_CONFIG に追加(既存ユーザは config.json マイグレーションで `[]` フォールバック)
  - **IPC**: `window.api.twitch.{getClientCredentials, setClientCredentials, clearClientCredentials, testCredentials, searchUserByLogin, listMonitoredCreators, addMonitoredCreator, removeMonitoredCreator, setCreatorEnabled}`
    - `setClientCredentials` は plaintext で受け取り即座に save → cache クリア(古い token を破棄)
    - `addMonitoredCreator` は idempotent(同じ userId は in-place 置換、`addedAt`/`enabled` 保持)
    - 各 mutation 系は更新後の配列を返す(renderer 側の round-trip を 1 IPC で済ませるため)
  - **SettingsDialog タブ化**:
    - **3 タブ構造**: 「一般」「動画ダウンロード」「配信者管理」
    - 「一般」: 既存 API 管理画面への hand-off + 配信者自動録画機能の説明文(X1 段階)
    - 「動画ダウンロード」: 段階 6c-d で追加した cookies / browser 設定をそのまま移動
    - 「配信者管理」: 新コンポーネント `CreatorManagementTab.tsx`(認証 + 検索 + リスト)
    - タブ stripe の CSS は `SettingsDialog.module.css` に minimal 追加(横並び、active 時 border-bottom + accent color)
  - **`CreatorManagementTab.tsx`**(新規、約 360 行):
    - **Section 1**: Client ID / Secret 入力。Secret は `type="password"` + `autoComplete="new-password"` + 「変更する場合のみ入力」プレースホルダ。`hasSecret` で「✓ 設定済み / ⚠ 未設定」表示。保存後に Secret 入力欄を即座にクリア(肩越し閲覧 / paste-into-screenshot 事故防止)
    - **Section 2**: ログイン名で検索 → ユーザカードプレビュー(アイコン + 表示名 + login + id) → 「追加」ボタン → リスト反映。Enter キーで検索発火
    - **Section 3**: 配信者カードリスト。アイコン + 表示名 + login + 登録日 + 「監視中」チェックボックス(段階 X2 のフラグ)+ 削除ボタン(`window.confirm` 経由)
    - 認証テストは「認証テスト」ボタンで `getAccessToken` を試行 → 「✓ 認証成功」or「⚠ 認証失敗:<エラー>」
- 経緯:
  - IDEAS.md の「配信アーカイブ → 自動動画化」の最初の一歩。録画機能は最終ゴールだが、まずは「配信者を登録できる、永続化される、リスト表示される」までで凍結
  - Webhook / EventSub は将来 TODO(段階 X4 以降で検討)。Client Credentials のみで十分な範囲を 段階 X1 の境界線とした
- 不採用案:
  - User Token / OAuth Authorization Code → 不要(X1-X4 は全 read-only 公開エンドポイント)
  - Webhook / EventSub → 公開 endpoint 必須でデスクトップアプリでは複雑。代わりに段階 X2 で polling
  - Client Secret の暗号化以外の保護(HSM 連携等)→ 過剰
  - 配信者のサムネイル定期更新 → 将来 TODO、頻繁に変わらないので登録時 1 回だけ
  - 認証エラーの自動リカバリ → 401 時の token refresh 1 回のみ、それ以上はユーザに対応を委ねる
- 影響ファイル:
  - `src/common/config.ts`(`MonitoredCreator` + AppConfig 2 フィールド + DEFAULT)
  - `src/common/types.ts`(`twitch` IPC namespace + MonitoredCreator import)
  - `src/main/config.ts`(`normaliseMonitoredCreators` + load/save round-trip)
  - `src/main/secureStorage.ts`(`saveTwitchSecret` 等 4 関数)
  - `src/main/twitchHelix.ts`(新規)
  - `src/main/index.ts`(twitch:* IPC handler 9 個 + import)
  - `src/preload/index.ts`(`twitch` namespace expose)
  - `src/renderer/src/components/CreatorManagementTab.tsx`(新規)
  - `src/renderer/src/components/SettingsDialog.tsx`(タブ構造 + activeTab state + body 条件分岐)
  - `src/renderer/src/components/SettingsDialog.module.css`(`.tabStrip` / `.tabButton` / `.tabButtonActive` 追加)
- 観察すべき点:
  - **rate limit**: 800 points/min(app token)で十分余裕、UI 操作だけでは届かない。段階 X2 の polling で配信者数 × 頻度がボーダー(50 配信者を 1 分毎なら 50/min、安全圏)
  - **token 期限切れ**: ~60 日で自動取得し直す(`expiresAt - 60s` で proactive refresh)。401 が来たら 1 回だけ refresh + retry、それでも 401 なら credentials 不正
  - **既存ユーザの影響**: `monitoredCreators` field が無い古い config.json は `[]` フォールバック、`twitchClientId` も `null` フォールバック。既存挙動と bit-identical
  - **Client ID が公開情報なのは Twitch developer console の規約**: dev console で「Application 登録 → Client ID 表示 + Client Secret 生成」のフロー、Client ID は OAuth リダイレクト URL に載るため公開前提
  - **Secret 暗号化保存の限界**: DPAPI なのでアプリと同じユーザ権限で動く別プロセスからは復号可能。攻撃者がアプリと同等権限を取った時点でアプリ全体が危険なので妥当な脅威モデル

---

## 2026-05-03 - Twitch クッキー認証 + 波形低密度プレースホルダ + 自動スクロール race 修正(段階 8)

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 7 直後の実機テストで発覚した 3 件のバグを 1 タスクで修正
  - **Bug A**(Twitch チャット 58 件で打ち切り): Twitch GraphQL の integrity gateway が無認証リクエストを 1-2 ページ目で `failed integrity check` で拒否
  - **Bug B**(波形グラフが空): 58 件のチャット → ほぼ全 bucket が commentCount=0 → rolling score も全部 0 近似 → 波形は描画されてるが y=100 の平らな線で視認不能
  - **Bug C**(自動スクロールデフォルト OFF にリグレッション): `useState(true)` のはずなのにデフォルト OFF に見える。programmatic scroll の race condition で初回起動直後に `setAutoScroll(false)` が誤発火してた

### Bug A — Twitch クッキー認証経路追加

- **`twitchGraphQL.ts`**:
  - `readTwitchCookieHeader(cookiesFile)` 追加。Netscape format を行ごとパースして domain に `twitch.tv` を含むエントリを `name=value; ...` 形式で返す。`#HttpOnly_` プレフィックスのドメインも認識
  - **セキュリティ**: 値は **絶対にログに出さない**。読み込んだクッキー名(auth-token / persistent / 等)だけログに出す
  - `fetchPage(vodId, cursor, signal, cookieHeader)` シグネチャに 4 番目の引数追加。`cookieHeader != null` のとき `Cookie:` ヘッダを送る
  - `fetchTwitchVodChat(vodId, options?)` の `options.cookiesFile` を起動時に 1 度だけ読み、ループ内全 fetch で共有
  - `errors[]` の文字列が `failed integrity check|integrity` にマッチしたら新ステータス `'integrity'` を返す
  - integrity 検出時の **クッキー有無で別ログ**:
    - `cookies=none`: 「Set Twitch cookies in settings to bypass this gate.」
    - `cookies=set`: 「Cookies may have expired; re-export from the browser and update settings.」
- **`chatReplay.ts`**: Twitch 経路で `options.cookiesFileTwitch ?? options.cookiesFile` を `fetchTwitchVodChat({ cookiesFile })` に渡す。段階 7 で `cookiesFileTwitch` フィールドを予約していたのを今回実利用化
- **クッキー browser path は転送しない**: `--cookies-from-browser` は yt-dlp 専用機構(DPAPI / Chrome cookie DB をネイティブ復号する必要)、本コードベースで再実装するのは過剰。ファイル指定経由のみサポート

### Bug B — 波形グラフ低密度プレースホルダ

- **真因確定**: `bucketize` は durationSec / 5 個のバケットを常に生成、空 bucket も保持。`computeRollingScores` も `bucketsPerWindow > buckets.length` 以外で空配列にならない。58 件 → 2076 buckets(2h53m)→ 2052 samples が出るが、ほぼ全 sample で `total=0` → SVG path は y=100 の平らな線(視認不能)
- 修正: コンポーネント描画時に `messageCount < 10` の判定を入れ、波形 SVG の上に **半透明オーバーレイ** で「コメント密度が不足しています(N 件) Twitch クッキー設定 or 動画 DL 完了後にローカル動画で編集してください」を表示
- 波形 SVG 自体は引き続き描画(seek-on-click や segment 操作が機能するため)、`pointerEvents: 'none'` でオーバーレイは透明にマウス通過
- **閾値 10 の根拠**: 4h 配信で ≥10 件あれば rolling score がピーク 1 つは作る。それ以下だと normalisation の母数不足で全 sample が低値
- **Y 軸スケーリング再設計は不採用**: `s.total` は既に max-normalized なので、コメント数自体が増えれば自然にピークが立つ。少件数時は本質的に「データ不足」なのでプレースホルダで意思を伝える方が正直

### Bug C — 自動スクロール race 修正

- **真因確定**: `useState(true)` は正、checkbox `checked` 連動も正。問題は `handleScroll` の programmatic-scroll detection
  - 旧設計: `lastProgrammaticScrollTopRef` に **最新の target 1 つだけ** を保持、scroll event の `top` と ±4 px 比較
  - 失敗ケース: ClipSelectView マウント直後に currentSec が複数回変動 → auto-scroll effect が連発 → ref が 2 つ目の target で上書き → 1 つ目の scroll event 到着時に `Math.abs(actualTop1 - target2) > 4` → user-scroll と誤判定 → `setAutoScroll(false)`
- 修正: 単一値の ref を **時間窓に変更**。programmatic scroll の直前に `programmaticScrollUntilRef.current = Date.now() + 150ms` を立て、handleScroll は `Date.now() < deadline` の間は user-scroll 判定をスキップ
- **150ms の根拠**: スクロールイベントは scrollTo 後 1-2 frame 以内に到着。最遅でも 50ms 程度。150ms はバースト 3-4 連発でも全部カバーできて、ユーザの実際のホイール入力に被るほど長くない
- 旧 `PROGRAMMATIC_SCROLL_TOLERANCE_PX` 定数は撤去

### 影響ファイル

- `src/main/commentAnalysis/twitchGraphQL.ts`(Cookie ヘッダ + integrity ステータス + log差分化)
- `src/main/commentAnalysis/chatReplay.ts`(Twitch 経路で cookiesFileTwitch ?? cookiesFile を forward)
- `src/renderer/src/components/CommentAnalysisGraph.tsx`(LOW_DENSITY_THRESHOLD + オーバーレイ JSX)
- `src/renderer/src/components/LiveCommentFeed.tsx`(`programmaticScrollUntilRef` 時間窓 + `PROGRAMMATIC_SCROLL_TOLERANCE_PX` 撤去)

### 観察すべき点

- **クッキー期限切れ頻度**: ユーザの実機 Twitch ログイン状態がどれくらいで切れるか。`cookies=set` で integrity 失敗したらクッキー再 export を促すログが出る
- **integrity gateway 仕様変更**: Twitch が `failed integrity check` の文言を変更 or HTTP ステータスベース(403 等)に変えたら検出 regex が外れる。`PersistedQueryNotFound` と同じく ad-hoc な対応窓口が必要
- **GraphQL に `Client-Integrity` トークン要求が広がった場合**: 現状は cookies で通る前提。仕様が硬化したら proper integrity token 取得実装が必要(yt-dlp 内部実装を参考)
- **150ms 時間窓の十分性**: 極端な長 layout pass(初回マウント + 大量 messages)で 150ms を超えるかどうか。超えたら `setAutoScroll(false)` 誤発火が再発するので 250ms に拡大検討
- **波形 LOW_DENSITY_THRESHOLD=10 の妥当性**: コメント 9 件で「不足」表示は厳しすぎ?ユーザのフィードバック次第で 5 や 3 に下げる余地あり

---

## 2026-05-03 - Twitch チャット GraphQL 直接実装 + cookies プラットフォーム別分離(段階 7)

- 誰が: Claude Code(Opus 4.7)
- 何を: Twitch VOD のチャット取得を yt-dlp `--sub-langs rechat` から **公開 GraphQL 直接 fetch** に変更。同時に cookies.txt をプラットフォーム別 (`ytdlpCookiesFileYoutube` / `ytdlpCookiesFileTwitch`) に分離可能化
  - **新規ファイル `src/main/commentAnalysis/twitchGraphQL.ts`**:
    - `fetchTwitchVodChat(vodId)` — `https://gql.twitch.tv/gql` に `Client-ID: kimne78kx3ncx6brgo4mv6wki5h1ko`(yt-dlp も使ってる Twitch 公開クライアント ID)+ persisted query hash `b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a` で `VideoCommentsByOffsetOrCursor` を POST。cursor で paging、`hasNextPage=false` or 空 cursor で終了
    - 600ms throttle / 5s linear backoff / max 3 retry / 5000 page hard cap
    - 404 = VOD 削除、401/403 = sub-only(将来クッキー対応で解決予定)、`PersistedQueryNotFound` = hash ローテーション(yt-dlp 最新値とすり合わせ要)— いずれも空配列で返す(throw しない)
    - `cancelTwitchVodChat()` で AbortController + `cancelRequested` フラグ経由のキャンセル
    - 結果は `ChatMessage[]`(既存型)、page 境界での重複は `timeSec|author|text` キーで dedupe
  - **`chatReplay.ts` 構造変更**:
    - `parseTwitchJson` 撤去(rechat フォーマット用、不要に)
    - `downloadChatJson` を `downloadYouTubeChatJson` にリネーム + YouTube 専用化、内部の if/else platform 分岐を削除、`--sub-langs live_chat` 固定、ファイル拡張子も `.live_chat.json` 固定
    - `fetchChatReplay` のシグネチャに `cookiesFileYoutube` / `cookiesFileTwitch` 追加。`extractVideoId` の `platform` を見て YouTube は yt-dlp 経路、Twitch は GraphQL 経路にディスパッチ
    - GraphQL 結果が **0 件のときキャッシュに書かない**(rate limit / hash rotation の transient で stale 「no chat」が永続化するのを防ぐ)。逆に YouTube 経路は 0 件でも `writeCache` する(yt-dlp 0 件 = 確定的、再試行価値なし)
    - `cancelChatReplay` は両 transport を unconditional cancel
  - **`AppConfig` 拡張**:
    - `ytdlpCookiesFileYoutube: string \| null`
    - `ytdlpCookiesFileTwitch: string \| null`
    - 既存 `ytdlpCookiesFile` は **汎用フォールバック** として残す
    - 既存ユーザの config.json は `ytdlpCookiesFile` のみで動く(後方互換)。両プラットフォーム別フィールドが無ければ `null` フォールバック
  - **`getCookiesArgs` 再設計**:
    - 旧: `({ cookiesBrowser, cookiesFile })`
    - 新: `({ cookiesBrowser, cookiesFile, cookiesFileYoutube, cookiesFileTwitch, platform })`
    - 優先順位: **プラットフォーム別ファイル > 汎用ファイル > ブラウザクッキー > なし**
    - `classifyUrlPlatform(url)` ヘルパを export。URL から `'youtube' | 'twitch' | 'unknown'` を返す。downloadVideo / downloadAudioOnly / downloadVideoOnly が `args.url` から推定して `platform` を渡す
  - **SettingsDialog UI**:
    - 旧: クッキーファイル 1 行
    - 新: 「汎用(両プラットフォーム)」「YouTube 専用(汎用より優先)」「Twitch 専用(汎用より優先)」の 3 行に分割
    - `renderCookieRow` 関数で 3 行を構造的に同一に
    - 各行に独立 missing 警告。dialog open 時に 3 ファイル並列 validate
- 経緯:
  - 段階 6d まででユーザの実機 Twitch VOD で `[chat-replay] yt-dlp exited 1: ERROR: Unable to download video subtitles for 'rechat': HTTP Error 404` を確認
  - yt-dlp の Twitch rechat 抽出器が 2026-05 頃に Twitch 側 deprecation で死んでいた(yt-dlp 自身も内部で GraphQL に乗り換えつつある)
  - `kimne78kx3ncx6brgo4mv6wki5h1ko` は Twitch 公式 web client ID、`b70a3591...` は `VideoCommentsByOffsetOrCursor` の persisted query hash(両方とも twitch.tv 自体が first-party バンドルで配布している値、無認証で公開 VOD chat 取得可能)
- なぜプラットフォーム別 cookies を同時に入れたか:
  - 段階 6c でファイル指定に切り替えた際、cookies.txt が「YouTube 用」と「Twitch 用」を区別せず単一ファイル前提だった
  - Twitch 経路に YouTube cookies が漏れる(無害だがログがノイジー)+ 将来 Twitch サブスク VOD 認証対応する時に分離されている方が clean
  - GraphQL 経路は **クッキー不要**(公開 VOD は Client-ID だけで OK、Twitch 専用 cookies は将来サブスク VOD 対応用の予約フィールド)
- 不採用案:
  - chat-downloader CLI を別プロセスで呼ぶ → Python 依存追加、UX 悪化
  - yt-dlp 側にパッチ送る → コミュニティ依存、待ち時間長い
  - GraphQL hash の自動更新 → yt-dlp ソースのスクレイピング必要、過剰
  - Twitch ライブチャット取得 → VOD のみ対象、ライブは別タスク
  - 既存 YouTube 経路の変更 → リスク回避、touch しない
- セキュリティ配慮:
  - クッキーファイル中身は依然として読まない・コピーしない・ログに出さない(段階 6c の方針継続)
  - GraphQL 経路はクッキー渡さない(本タスクでは)。サブスク VOD 対応は future TODO
- 影響ファイル:
  - `src/main/commentAnalysis/twitchGraphQL.ts`(新規、約 290 行)
  - `src/main/commentAnalysis/chatReplay.ts`(`downloadChatJson` → `downloadYouTubeChatJson` リネーム + YouTube 専用化、`parseTwitchJson` 撤去、`fetchChatReplay` ディスパッチ、`cancelChatReplay` 両 transport 対応)
  - `src/main/commentAnalysis/index.ts`(`AnalyzeCommentsOptions` に cookies 2 種追加)
  - `src/main/urlDownload.ts`(`getCookiesArgs` リファクタ、`CookiesPlatform` / `classifyUrlPlatform` 追加、3 download 関数のシグネチャに cookies 2 種追加)
  - `src/main/index.ts`(URL DL × 3 + commentAnalysis IPC で 2 種類の cookies フィールドを config から injection)
  - `src/common/config.ts`(`ytdlpCookiesFileYoutube` / `ytdlpCookiesFileTwitch` 追加 + DEFAULT)
  - `src/main/config.ts`(load/save round-trip + `normaliseCookiesPath` ヘルパ抽出)
  - `src/renderer/src/components/SettingsDialog.tsx`(3 行構成、`renderCookieRow` 関数化)
- 観察すべき点:
  - **GraphQL hash の rotation**:`PersistedQueryNotFound` エラーが出たら yt-dlp の最新 hash と sync 要(`twitchGraphQL.ts` の `VIDEO_COMMENTS_QUERY_HASH` 定数を更新)
  - **rate limit**:600ms throttle で問題なさそうだが Twitch 側の挙動は不安定で、長時間配信(4h+)で 429 連発しないか実機検証要
  - **paging 速度**:1 page ~100 messages、~1.6s/page → 4h 配信(50K messages)で約 8 分。許容内だが進捗 UI を出してない
  - **キャッシュ無効化条件**:Twitch GraphQL は 0 件キャッシュしない(rate limit / hash rotation 対策)。挙動が違うので意識しておく

---

## 2026-05-03 - format selector 緩和 + JS runtime 指定(段階 6d)

- 誰が: Claude Code(Opus 4.7)
- 何を: yt-dlp に `--js-runtimes node` を全経路で渡し、format selector の avc1 / mp4 制約を撤廃して fallback を簡素化
  - **`--js-runtimes node` を 4 箇所追加**: `downloadVideo` / `downloadAudioOnly` / `downloadVideoOnly`(urlDownload.ts)+ `downloadChatJson`(chatReplay.ts)
    - Node.js は npm run dev / packaged build 両方で PATH 上に存在する前提(electron-vite が node を起動してる時点で確実)
    - yt-dlp が PATH 経由で自動検出
  - **buildFormatSelector を簡素化**:
    - 旧: `bestvideo[ext=mp4][vcodec^=avc1]<h>+bestaudio[ext=m4a] / bestvideo[ext=mp4][vcodec^=avc1]<h>+bestaudio / bestvideo<h>+bestaudio<h> / best[ext=mp4]<h>/best<h>`(4 段、avc1+m4a 優先)
    - 新: `bestvideo<h>+bestaudio / best<h> / best`(3 段、コンテナ / コーデック非指定)
    - 旧 `worst` 経路 `worstvideo[ext=mp4]+worstaudio[ext=m4a]/worstvideo+worstaudio/worst[ext=mp4]/worst` も同形式で簡素化
  - **downloadAudioOnly の `-f` 緩和**:
    - 旧: `bestaudio[ext=m4a]/bestaudio`
    - 新: `bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio`(webm/opus を明示候補に)
  - **friendlyDownloadError 拡張**: 新カテゴリ `(E) format-not-available`(`/Requested format is not available|No suitable formats|format not available/i`)→「利用可能な動画フォーマットが見つかりません。動画が削除・地域制限されているか、yt-dlp のバージョンが古い可能性があります。」
- 経緯:
  - 段階 6c でクッキーファイル指定が動いて bot 検出は突破できたが、yt-dlp が次に「Requested format is not available」で落ちた
  - ユーザの実機で `yt-dlp --list-formats` を実行 → format 自体は存在(140 m4a / 251 opus / 299 1080p60 mp4 等)
  - stderr に `WARNING: No supported JavaScript runtime could be found.` を確認 → JS runtime 不在で YouTube の nsig / SABR 解決ができず、解決済 format が空集合になっていた
  - YouTube は近年 JS runtime 必須化(deprecated → 段階的に必須)、PhantomJS / deno / node のいずれかが必要
- なぜ avc1+mp4 制約を撤廃したか:
  - 元々の意図: 「Chromium が H.264 + AAC をネイティブ再生」だから avc1+m4a を優先 → Merger は pure remux で済む
  - 現実: Chromium ~70 以降 MP4+VP9 ネイティブ再生対応、avc1 制約の必要性は低下
  - JS runtime 不在のときに `bestvideo[ext=mp4][vcodec^=avc1]` の解決失敗 → 第 4 候補の `best[ext=mp4]/best` まで降りて picky になっていた
  - 制約撤廃 → fallback chain が短くて読みやすい + JS runtime と組み合わせて確実に format 解決成功
- WebM 出力の影響(`bestvideo<h>+bestaudio` で VP9 を引いた場合):
  - `--merge-output-format mp4` + `Merger:-c:v copy` で MP4+VP9 になる(Chromium で再生可能)
  - audio は `-c:a aac -b:a 192k` で AAC 化されるので Chromium 互換維持
  - audioExtraction.ts は `ffmpeg -i input.* -vn ...` でコンテナ自動判別、webm/m4a/mp4 全部対応
- 不採用案:
  - yt-dlp バイナリの更新(段階 1 で最新版確認済み)
  - deno インストール推奨(node で十分、追加依存を避ける)
  - format selector を quality 別に複雑分岐(柔軟さで十分カバー)
  - クッキーローテーション対応(YouTube 側仕様、TODO で将来検討)
  - WebM → MP4 自動変換(FFmpeg は両対応で不要)
- 影響ファイル:
  - `src/main/urlDownload.ts`(`buildFormatSelector` 簡素化、3 関数に `--js-runtimes node` + audio の `-f` 緩和、friendlyDownloadError に (E) 追加)
  - `src/main/commentAnalysis/chatReplay.ts`(`--js-runtimes node` 追加)
- 観察すべき点:
  - WebM 出力が増えた場合の export.ts 互換性(現状 `-c:v copy` で MP4 化、ffmpeg は VP9-in-MP4 を生成するが extra check 推奨)
  - yt-dlp の警告「The provided YouTube account cookies are no longer valid」が出た場合の挙動(将来 TODO)

---

## 2026-05-03 - cookies.txt ファイル直接指定機能追加(段階 6c)

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 6b の `--cookies-from-browser` 統合に加えて、yt-dlp `--cookies <file>` 経路を追加。SettingsDialog の「動画ダウンロード」セクションにファイル選択 UI を追加し、ブラウザクッキーよりも **優先** する設計に
  - **AppConfig 拡張**: `ytdlpCookiesFile: string | null`(default `null`)
    - `src/common/config.ts` の DEFAULT 追加
    - `src/main/config.ts` の load/save で round-trip。空文字列は `null` に正規化、`null` を明示的に保存できる(クリアボタン経由)
  - **getCookiesArgs を再設計**: シグネチャを `(opts: { cookiesBrowser, cookiesFile })` に変更。優先順位は `cookiesFile (--cookies <path>) > cookiesBrowser (--cookies-from-browser <browser>) > [] (anonymous)`
  - **新規 IPC**:
    - `dialog:openCookiesFile` — Electron `showOpenDialog` のラッパ、フィルタは .txt + すべて
    - `cookiesFile:validate` — `fs.stat` で存在 + サイズ + 拡張子を返す。**ファイル中身は読まない**(セキュリティ)
  - **SettingsDialog UI**(動画ダウンロード セクション内、ブラウザクッキー使用ラジオの下):
    - 「またはクッキーファイル(優先度: 高)」ラベル + 現在のパス表示(rtl で末尾ファイル名見える、ホバー title で全パス)+ ファイル選択ボタン + クリアボタン
    - ファイル選択時に validate を呼んで存在/サイズ/拡張子をチェック → 警告のみ alert、保存はする(spec: 「ファイル指定はクリアしない、ユーザの意図的な事前設定もありうる」)
    - dialog open 時にも再 validate(ユーザがファイル移動 / 削除した場合に warning 表示)
    - ヒント文 + 「※ クッキーファイルは認証情報を含みます。第三者と共有しないでください」の警告
  - **friendlyDownloadError 拡張**:
    - 新カテゴリ `(D) cookies-file-not-found` を追加(`/cookies file (?:does not exist|not found|cannot be opened)|No such file or directory.*cookies/i`)
    - 既存 `(C) クッキーロック` メッセージに「クッキーファイル指定もご検討ください」追記
- 経緯: 段階 6b 完了直後、ユーザの実機(Windows 11)で全ブラウザのクッキー読み取りが失敗:
  - Chrome: `Could not copy Chrome cookie database`(プロセスロック、ブラウザを閉じても発生)
  - Edge: `Failed to decrypt with DPAPI`(Windows 11 の DPAPI 変更で yt-dlp の復号ロジックが追従できてない)
  - Firefox: 同様
  - → ブラウザクッキー経路は環境依存で全滅 → 最も確実な「cookies.txt ファイル直接指定」を追加
- 優先順位の設計判断:
  - **ファイル > ブラウザ**(両方設定された場合)
  - 理由: cookies.txt は Chrome 拡張「Get cookies.txt LOCALLY」等で **手動 export** したもの = ユーザの **明示的意思**。一方ブラウザクッキーは「自動取得」で、ファイル指定があるなら最新の意思はファイル側
  - 両方を組み合わせる選択肢は不採用。yt-dlp の引数としては併用可能だが、stderr で混乱を招く + 「ファイルを優先」の SettingsDialog 文言と一致しない
- セキュリティで配慮した点:
  - **ファイル中身は読まない・ログに出さない・コピーしない**。`validateCookiesFile` は `fs.stat` で size と existence のみ取得
  - パス自体はログに出す(機密情報は中身、パスではない)
  - SettingsDialog に注意書き「※ クッキーファイルは認証情報を含みます。第三者と共有しないでください」を明示
  - ファイル妥当性チェックは警告のみ(エラーで保存をブロックしない) — ユーザの意図的な事前設定 / 一時的なファイル移動を許容
- 不採用案:
  - cookies.txt の自動取得(ブラウザ拡張不要にする)→ 不可能(各ブラウザの DRM ライセンスフラグメント越えが困難)
  - パスを暗号化保存 → 複雑、効果限定的(コピーされたら復号鍵もアプリと一緒)
  - クッキー期限切れ自動検出 → 困難(yt-dlp 実行時のエラーで十分)
  - 複数クッキーファイルの切替 → オーバーキル
- 影響ファイル:
  - `src/common/config.ts`(`ytdlpCookiesFile` 追加 + DEFAULT)
  - `src/common/types.ts`(`CookiesFileValidation` 型 + IpcApi に 2 メソッド追加)
  - `src/main/config.ts`(load/save round-trip + 空文字列正規化)
  - `src/main/fileDialog.ts`(`openCookiesFileDialog` + `validateCookiesFile`)
  - `src/main/index.ts`(2 IPC handler 追加 + URL DL × 3 / commentAnalysis IPC で `cookiesFile` も注入)
  - `src/main/urlDownload.ts`(`getCookiesArgs` リファクタ + downloadVideo / downloadAudioOnly / downloadVideoOnly のシグネチャに `cookiesFile` 追加 + friendlyDownloadError の(D)分岐追加)
  - `src/main/commentAnalysis/index.ts`(`AnalyzeCommentsOptions.cookiesFile` 追加)
  - `src/main/commentAnalysis/chatReplay.ts`(`fetchChatReplay` / `downloadChatJson` のシグネチャに `cookiesFile` 追加)
  - `src/preload/index.ts`(`openCookiesFileDialog` + `validateCookiesFile` を expose)
  - `src/renderer/src/components/SettingsDialog.tsx`(クッキーファイルセクション、ファイル選択 / クリア / 警告表示)
- 観察すべき点:
  - cookies.txt の有効期限が切れた時の挙動(yt-dlp が「cookies expired」相当の stderr を出すかは未検証)
  - ユーザ環境でブラウザクッキー全滅 → ファイル指定で本当に動くか実機検証

---

## 2026-05-03 - --cookies-from-browser 統合(YouTube bot 検出回避)

- 誰が: Claude Code(Opus 4.7)
- 何を: yt-dlp に `--cookies-from-browser <browser>` を統合し、SettingsDialog で Chrome / Edge / Firefox / Brave / 使用しない を選択できるようにした
  - **AppConfig 拡張**: `ytdlpCookiesBrowser: 'none' | 'chrome' | 'edge' | 'firefox' | 'brave'`(default `'none'`)
    - `src/common/config.ts` に union type + `YTDLP_COOKIES_BROWSER_VALUES` 配列を追加
    - `src/main/config.ts` の load/save に `normaliseCookiesBrowser` を通して domain 外の値が来たら `'none'` フォールバック
  - **getCookiesArgs ヘルパ**: `urlDownload.ts` で export、`'none'` なら `[]`、それ以外は `['--cookies-from-browser', <browser>]`
  - **適用先**: `downloadVideo` / `downloadAudioOnly` / `downloadVideoOnly`(全 3 つの URL DL 経路)+ `chatReplay.ts` の `downloadChatJson`(コメント分析の yt-dlp 呼び出し)
  - **設定の取得タイミング**: 各 IPC handler が起動時に `loadConfig()` を呼んで都度反映 → 設定変更後の **次の URL 入力** で即座に効く(アプリ再起動不要)
  - **friendlyDownloadError の 3 カテゴリ分類**(stderr 分岐順):
    1. **クッキーロック** (`/cookies database is locked|could not copy cookies|Permission denied.*cookies/i`) — bot 検出より先に判定。クッキー有効化中はこっちが原因のことが多い
    2. **bot 検出** (`/Sign in to confirm you'?re not a bot/i`) — 「設定で『ブラウザクッキー使用』を有効に(推奨: Edge / Chrome)」
    3. **認証必要** (`/Sign in to confirm your age|members?-only|This video is private|age-restricted/i`) — 「年齢制限 / メンバー限定 / 非公開。設定で『ブラウザクッキー使用』を有効に」
- 推奨が Edge の理由: Windows 11 デフォルトでほぼ全ユーザがインストール済み + yt-dlp の Chromium edge クッキー抽出器が安定 + クッキーロックが Chrome より穏やか(observed)
- 既存ユーザへの影響:
  - DEFAULT_CONFIG.ytdlpCookiesBrowser = 'none' なので新規 / 既存共に既存挙動と bit-identical
  - bot 検出が出てから設定 UI で有効化する流れ(オプトイン)
  - 既存 config.json に `ytdlpCookiesBrowser` フィールドが無い場合は `normaliseCookiesBrowser(undefined)` → `'none'` フォールバック
- データ収集経路は **対象外**: バックグラウンド unattended 実行 → クッキーロックで破綻する + ユーザ個人アカウントでクォータ消費が増える、リスクが大きい。spec 通り URL DL + commentAnalysis のみ
- 不採用案:
  - `cookies.txt` 直接指定 → ユーザが手動 export する手間 + UX 悪化
  - 自動でブラウザ検出して切替 → 過剰実装
  - クッキー有効性の事前チェック → yt-dlp 実行時のエラーで十分
  - bot 検出後の自動リトライ → 複雑、UX 不明瞭
- 影響ファイル:
  - `src/common/config.ts`(union type + DEFAULT 追加)
  - `src/main/config.ts`(load/save round-trip + normaliser)
  - `src/main/urlDownload.ts`(getCookiesArgs export + 3 関数のシグネチャ拡張 + friendlyDownloadError 分類拡張)
  - `src/main/commentAnalysis/index.ts`(`AnalyzeCommentsOptions.cookiesBrowser` 追加 + analyzeComments のシグネチャ拡張)
  - `src/main/commentAnalysis/chatReplay.ts`(fetchChatReplay + downloadChatJson のシグネチャ拡張、getCookiesArgs を urlDownload から import)
  - `src/main/index.ts`(URL DL × 3 IPC + commentAnalysis IPC で `loadConfig()` を呼んで cookiesBrowser を注入)
  - `src/renderer/src/components/SettingsDialog.tsx`(動画ダウンロード — ブラウザクッキー使用 セクション追加、ラジオボタン × 5、useSettings 経由で双方向バインド)
- 観察すべき点:
  - クッキーロック頻度(ユーザがブラウザ起動中に DL → friendlyDownloadError(C) が出る頻度)
  - 個人アカウントでのプライベート動画リーク事故(まずいので警告で対応中)
- 将来流用可能: Twitch 認証統合(現状未実装)に同じ仕組み(`getCookiesArgs` ヘルパ + friendlyDownloadError の分岐)を流用可能

---

## 2026-05-03 - 段階 6a: URL 入力時の並列化(コメント取得 + グローバルパターン)

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 1-5 完了後の追加最適化。**URL 入力直後** に audio DL / video DL / コメント分析 / グローバルパターン読込を **4 つ並列起動**。ClipSelectView オープン時点でコメント分析が走り始め(or 既に完了済み)、グローバルパターンはキャッシュ済みになる
  - **新規 IPC**: `aiSummary.loadGlobalPatterns()` で main 側の `loadGlobalPatterns()` を expose(返り値は renderer で `unknown` 扱い、opaque cargo として store に保持)
  - **editorStore 拡張**: `commentAnalysisStatus: CommentAnalysisLoadStatus` + `globalPatterns: unknown | null`、対応 setters。`enterClipSelectFromUrl` / `setFile` / `clearFile` で `commentAnalysisStatus` を idle に reset(stale 値の漏れ防止)
  - **App.tsx**: audio DL await 完了直後に video DL + コメント分析 + global patterns を **3 つ並列 fire**(audio が条件として要るのは sessionId / sourceUrl / durationSec の確定のため)。各 promise は session 一致チェックを通過したら editorStore に書き込み。`useEffect` で sessionId 消滅(clearFile)を検知して `commentAnalysis.cancel()` 発火
  - **ClipSelectView**: 既存の commentAnalysis 用 useEffect + 局所 `analysisState` を **完全撤去**、editorStore の `commentAnalysisStatus` を購読するだけに。`AnalysisState` 型と stage 1 から残ってた `[comment-debug:renderer]` ログも全部除去
  - **'no-source' の判定**: 旧 union の kind から、`!!filePath && !sourceUrl && status.kind === 'idle'` の派生フラグ `isLocalNoSource` に
- 並列化対象 / 非対象の境界:

  | 処理 | 並列化 | 理由 |
  |---|---|---|
  | 音声 DL | ✅ | 段階 2 から並列、本タスクで stable |
  | 動画 DL | ✅ | 段階 2 で並列化済 |
  | チャットリプレイ取得 | **✅ 本タスクで追加** | URL からほぼ確実に取得、待ち時間が長い |
  | グローバルパターン読込 | **✅ 本タスクで追加(symbolic)** | 既存内部読込は ms 級だが spec 準拠 |
  | Gemini 音声分析 | ❌ 非対象 | API 消費懸念、ユーザ意図確認(ボタン押下)必須 |
  | AI 抽出本体(Claude Haiku)| ❌ 非対象 | 同上 |
  | ヒートマップ取得 | ❌ 非対象 | AI 抽出フローで使ってない |
- Gemini を非対象にした理由:
  - 段階 6a の目的は「ユーザの待ち時間短縮」だが、Gemini は API リクエスト = 課金 = ユーザ意図必須
  - URL 入力で自動 fire するとユーザが意図しないキー消費が発生する → 「自動で切り抜き候補を抽出」ボタン押下時のままで明示性を維持
- session 一致チェックの設計:
  - `expectedSession = audio.sessionId` をクロージャに保持、各 promise 完了時に `useEditorStore.getState().sessionId === expectedSession` で確認
  - ユーザが「戻る」を押した(clearFile → sessionId=null)後に late promise が resolve した場合、editorStore への書込を skip
  - 同じ URL を再入力すると同じ sessionId なので、stale promise の結果も新セッションに書込まれる(意図通り、stable)
- ローカル drop 時の挙動:
  - URL 無し → コメント分析 / グローバルパターンの並列 fire は走らない
  - `setFile` が `commentAnalysisStatus = 'idle'` をセット
  - ClipSelectView が `isLocalNoSource` true で「ローカル動画(モック表示)」表示
- キャンセル経路:
  - `useEffect(() => {... }, [sessionId])` で sessionId が string→null に遷移したら `commentAnalysis.cancel()` を発火 → 進行中の yt-dlp プロセス kill
  - audio / video DL の cancel は段階 2 から既存
  - global patterns の cancel: `fs.readFile` だけなので不要(ms オーダ)
- 体感の変化(理論):
  - 旧: URL 入力 → audio DL(数十秒)→ ClipSelectView mount → useEffect で comment 起動 → 数秒〜数分待ち
  - 新: URL 入力 → audio DL(数十秒、裏でコメント取得も並走)→ ClipSelectView mount → 多くの場合 **コメント分析が既に進行中** か **完了済み** で表示される
  - 大幅短縮ではなく重複待ち時間の解消が主効果
- 影響: `src/common/types.ts`(`CommentAnalysisLoadStatus` 型 + `aiSummary.loadGlobalPatterns` IPC 型)/ `src/main/aiSummary.ts`(`loadGlobalPatterns` を export)/ `src/main/index.ts`(`aiSummary:loadGlobalPatterns` IPC handler)/ `src/preload/index.ts`(expose)/ `src/renderer/src/store/editorStore.ts`(state + actions + lifecycle reset)/ `src/renderer/src/App.tsx`(並列 fire + sessionId watcher)/ `src/renderer/src/components/ClipSelectView.tsx`(useEffect 撤去 + store 購読 + 局所 state 削除 + debug ログ削除)
- コミット: (未コミット)

---

## 2026-05-03 - 段階 5/5: Twitch 動作確認 + 微調整(動画 DL 高速化 5 段階再設計 完了)

- 誰が: Claude Code(Opus 4.7)
- 何を: 段階 1-4 で組んだ audio-first / embed / 切替フローの **Twitch 完走確認** + 失敗時の UX 微調整 3 件。実装は最小、ユーザ実機検証ありき
  - **EmbeddedVideoPlayer**: `EMBED_READY_TIMEOUT_MS = 10s` watchdog 追加。X-Frame-Options 拒否 / parent パラメータ不一致で iframe が空ロードしたまま無音 fail する Twitch 特有の挙動を明示エラーに変換。`onReady` / Twitch `'ready'` event でタイマー解除、unmount でも掃除
  - **urlDownload**: `friendlyDownloadError(stderr, sessionId, fallback)` 追加。`HTTP Error 404|410|Video does not exist|Sorry, the streamer` を検出 → Twitch sessionId なら **「Twitch VOD が見つかりません(配信から 14 日以上経過、または非公開の可能性)」**、それ以外は「動画が見つかりません(404)」
  - 認証必須(`Sign in to confirm` / `age-restricted` / `members-only`)も別ブランチで「ログイン認証が必要な動画です」に変換
  - audio / video 両 path で stderr を 16 KB rolling buffer で蓄積 → exit code != 0 時に変換に流す
- parent パラメータの最終値:
  - **`['localhost', '127.0.0.1', 'jikkyou-cut.local']`** で確定(段階 3 から無変更)
  - **dev 環境** (`http://localhost:<port>`): `localhost` で確実にマッチ ✅
  - **prod 環境** (`file://...`): origin に hostname がないため Twitch SDK が **拒否する可能性が高い**。発生したら 10s 後に「Twitch の埋め込み再生に失敗しました。動画 DL 完了後にローカル再生されます。」が出る → ユーザは段階 4 の自動切替で救済される
  - prod での恒久対策(custom protocol / localhost server)は **段階 5+ 別タスク** へ繰り越し。dev では問題なく動くため必要に応じて
- X-Frame-Options 対処:
  - 上記 ready timeout が唯一の検知手段(YT は onError event があるが Twitch は無音で失敗)
  - 拒否時はエラーメッセージのみ表示、UI は壊れない
  - 段階 4 のローカル切替は完全に独立して動くため、video DL 完了で自動救済される
- 14 日問題のエラー表示:
  - audio DL の段階で yt-dlp が 404/410 → friendlyDownloadError で Twitch 専用文言に変換
  - ClipSelectView に到達せずに alert で表示(spec の §動作確認 B 通り)
- Twitch チャットリプレイ対応:
  - 既存の `chatReplay.ts` が `--sub-langs rechat` で Twitch 対応済(段階 3 以前から)
  - `parseTwitchJson` が v5 API 形式 (`comments[].content_offset_seconds` / `message.body` / `commenter.display_name`) をパース
  - **実機での yt-dlp 出力フォーマットは未検証** — 実装は揃ってるが、Twitch 側の API 変更で動かない可能性あり。動作確認はユーザに委ねる
- 5 段階再設計の総括:

  | 段階 | 内容 | 完了日 |
  |---|---|---|
  | 1 | yt-dlp `--concurrent-fragments 8` + バイナリ最新化 + ベンチログ | 2026-05-03 |
  | 2 | 音声優先 DL + AI 抽出早期実行(audio-first / video-background) | 2026-05-03 |
  | 3 | YouTube/Twitch 埋め込みプレイヤー導入 | 2026-05-03 |
  | 4 | 編集中のプレイヤー切替(埋め込み ↔ ローカル動画) | 2026-05-03 |
  | 5 | Twitch 動作確認 + 微調整 | 2026-05-03 |

  完成形のフロー: URL 入力 → 音声 DL(数十秒)→ ClipSelectView オープン + embed 再生開始 + AI 抽出可能 → 裏で動画 DL → DL 完了で再生位置維持で seamless 切替 → 編集 → 書き出し
- 影響: `src/renderer/src/components/EmbeddedVideoPlayer.tsx`(ready timeout)/ `src/main/urlDownload.ts`(friendlyDownloadError + audio/video stderr buffering)
- コミット: (未コミット)

---

## 2026-05-03 - 段階 4/5: 埋め込み ↔ ローカル動画プレイヤー切替ロジック

- 誰が: Claude Code(Opus 4.7)
- 何を: 動画 DL 完了時に EmbeddedVideoPlayer から VideoPlayer に **再生位置を引き継いで自動切替**。トースト通知 3 秒表示。これで段階 2 の audio-first 体験から段階 4 の seamless 編集体験までが繋がる
  - **VideoPlayer 拡張**: `initialSec?` / `shouldAutoPlay?` props 追加。`handleLoadedMetadata` で 1 度だけ適用(`initialSeekAppliedRef` flag で多重適用防止)。subsequent metadata events は既存の volume 等の初期化のみ実行
  - **ClipSelectView 拡張**:
    - state: `swappedToLocal` / `initialSeekSec` / `shouldAutoPlay` / `embedPlaying` / `toast`
    - `sessionId` 変更時に swap state リセット
    - filePath 到着時の useEffect で `embeddedRef.current.getCurrentTime()` を捕捉 → `setSwappedToLocal(true)` で 1 tick 遅延のレンダー切替 → unmount 前に位置を確実に取得
    - 派生フラグ `useLocalPlayer = !!filePath && (!sessionId || swappedToLocal)` で render 分岐:ローカル drop は即 VideoPlayer、URL DL は捕捉後に切替
    - Toast 自動消滅 3s + CSS slide-in animation
  - **EmbeddedVideoPlayer の `onPlayStateChange`** を ClipSelectView に接続 → `embedPlaying` を track → swap 時に `shouldAutoPlay` に転写。embed 再生中の swap → ローカル側も自動再生継続
- パターン A 採用根拠(自動切替 + 位置維持):
  - **手動切替ボタン案は却下** — ユーザに切替の判断を委ねるとリロード操作が増える、UX 後退
  - **DL 完了タイミングの自動切替**が UX 的に最も自然(視聴中に裏で seamless に切替)
  - 位置引き継ぎが必須 — 切替時に頭から再生し直しは認知負荷が高い
- 1-tick lag による位置捕捉:
  - filePath が string になった瞬間に `swappedToLocal=true` を即時 set すると、同レンダーで EmbeddedVideoPlayer が unmount → ref が null → `getCurrentTime()` 取れない
  - useEffect で「現在 mount されてる embed の ref から読み取り → state 更新 → 次のレンダーで unmount」とすることで、必ず embed mount 中の値を捕捉できる
  - `getCurrentTime()` 失敗時は 0 にフォールバック(エラー時の embed や API ロード失敗時)
- トースト通知の意図:
  - 切替が seamless すぎてユーザが気付かない → 「字幕や削除区間スキップが急に動くようになった理由」が不明になる懸念
  - 3 秒のトースト「ローカル再生に切替しました」で気付きを与える
  - フェードアウト時間も含めて画面を圧迫しない位置(右下)
  - pointer-events: none で操作妨害しない
- 切替不可逆の判断:
  - filePath が一度 set されたら、ユーザが「埋め込みに戻したい」要望は想定しない(編集に向かう動線で必要なし)
  - `swappedToLocal` は false → true の単方向 flag
  - sessionId が変更された(別 URL を新規入力した)場合のみ reset、これは新規セッションなので妥当
- 切替時の position 引き継ぎ精度:
  - YouTube IFrame `getCurrentTime()` は実数秒(精度あり、ms オーダ)
  - HTMLMediaElement の `currentTime` setter はキーフレームに丸める(動画 codec 次第、典型 ±0.5-2s)
  - 結果として **±0.5-2 秒のズレ**が発生、許容範囲(編集フェーズで微調整可能)
  - Twitch の `getCurrentTime()` も同様の挙動を期待(段階 5 で実機確認)
- エッジケース処理:
  - embed 一時停止中の DL 完了 → `embedPlaying=false` → `shouldAutoPlay=false` → ローカル側も停止状態で位置だけ移行(spec 通り)
  - embed エラー(101/150 等)→ `getCurrentTime()` が catch で 0 にフォールバック → ローカル側 0 秒から再生(spec 通り)
  - ローカル drop(sessionId null)→ `useLocalPlayer = true && (!sessionId || ...)` で即 VideoPlayer、swap 経路を通らない(toast も出ない、spec 通り)
- 段階 5(Twitch 検証)が次タスク
- 影響: `src/renderer/src/components/VideoPlayer.tsx`(initialSec / shouldAutoPlay props)/ `src/renderer/src/components/ClipSelectView.tsx`(swap state + useEffect + toast)/ `src/renderer/src/components/ClipSelectView.module.css`(toast styles)
- コミット: (未コミット)

---

## 2026-05-03 - 段階 3 のリグレッション修正:audio-first 経路でコメント取得が 0 件になる問題

- 誰が: Claude Code(Opus 4.7)
- 症状: URL 入力 → audio-first DL → ClipSelectView オープン後、LiveCommentFeed が「コメントが取得できていません(ローカル動画 / 取得失敗時)」と表示される。yt-dlp のチャットリプレイは取得可能なはずなのに 0 件
- 真因(調査結果):
  - 仮説 A/B/C いずれも当たらず — IPC は sourceUrl ベースで正常、URL も渡っている
  - **段階 3 で導入した EmbeddedVideoPlayer の onReady 内で `player.getDuration()` を呼び `onDuration → setDuration(0)` を発火していた**
  - YT IFrame Player / Twitch Embed の `getDuration()` は **iframe 初期 buffering 中は 0 を返す**(metadata 未ロード)
  - これが editorStore.durationSec を **正しい値(段階 2 の audio probe で設定済)から 0 に上書き**
  - ClipSelectView の comment analysis useEffect が依存配列に `durationSec` を持つため re-run、gate `durationSec <= 0` で early return + cleanup 関数が `commentAnalysis.cancel()` を発火 → in-flight の yt-dlp チャット取得を kill
  - 結果: messages = [] で完了 → mockAnalysis fallback → empty state 表示
- なぜ stage 1/2 で発生しなかったか:
  - Stage 2 完成時点では filePath null 中はプレースホルダ overlay のみで `<video>` も embed も無し → setDuration を呼ぶ経路が存在しない → audio probe 値が維持
  - Stage 3 で EmbeddedVideoPlayer をマウントした瞬間に onReady → setDuration(0) パスが発生
- 修正:
  - **EmbeddedVideoPlayer.tsx**: `tryEmitDuration(player)` ヘルパ + `durationEmitted` flag を導入。`getDuration() > 0` を確認できるまで onDuration を発火しない。onReady で 1 回試行 + 500ms polling 内でも valid 値が出るまで再試行 → 確定後は再発火しない
  - **editorStore.setDuration**: 防御的に `sec > 0` のみ受け付ける guard を追加。VideoPlayer / Embedded どちらの将来の経路でも 0 で上書きできないように
- なぜ防御を 2 段にしたか:
  - EmbeddedVideoPlayer の修正は根本対処
  - editorStore の guard は別経路で同じパターンが現れた時の保険(VideoPlayer の `<video>.duration` も実は metadata 前は 0 を返す。これまで偶発的に問題化していなかっただけ)
- 動作確認方法(実機):
  1. URL 入力 → ClipSelectView オープン
  2. LiveCommentFeed のヘッダが「コメント (NN件)」と件数を表示
  3. コメント本文が時刻付きで表示される
  4. グラフが密度を反映して描画される
  5. AI 抽出時の Claude Haiku プロンプトに `候補 C1/C2/...` が含まれる(段階 3 で実装済の C/G prefix 出力)
- 影響: `src/renderer/src/components/EmbeddedVideoPlayer.tsx` / `src/renderer/src/store/editorStore.ts`
- コミット: (未コミット)

---

## 2026-05-03 - 段階 3/5: YouTube/Twitch 埋め込みプレイヤー導入

- 誰が: Claude Code(Opus 4.7)
- 何を: 動画 DL 高速化 5 段階の **段階 3**。video DL 完了を待たずに YouTube IFrame / Twitch Embed プレイヤーで再生開始できるようにする。VideoPlayer は無変更で温存(段階 4 で切替ロジック実装)
  - **新規 lib** `src/renderer/src/lib/youtubePlayerApi.ts`(YT IFrame API singleton loader、`onYouTubeIframeAPIReady` ベース、30s safety timeout)
  - **新規 lib** `src/renderer/src/lib/twitchPlayerApi.ts`(Twitch Embed SDK loader、`script.onload` ベース、polling fallback)
  - **新規 component** `EmbeddedVideoPlayer.tsx` + `.module.css`(forwardRef でビルド済 imperative handle: `play / pause / seekTo / getCurrentTime / getDuration`、500ms `onTimeUpdate` polling、parseSessionId で platform 振り分け)
  - **ClipSelectView 統合**: video area の分岐を `filePath ? VideoPlayer : sessionId ? EmbeddedVideoPlayer : DL Overlay` の 3 段に。embed の上に DL 進捗 badge(右上)+ プレビュー注意書き(左下)を絶対配置
  - **ref 統合**: `videoRef`(VideoPlayer 用)+ `embeddedRef`(Embed 用)を並列保持、`handleSeekInternal` が active な方を判定して seekTo を呼ぶ
- 旧フロー(段階 2 完成時点)の課題:
  - URL 入力 → 音声 DL → ClipSelectView 開く までは早くなったが、**動画再生は依然として動画 DL 完了待ち**
  - 大きな視聴体験の改善余地が残っていた
- 新フロー(段階 3 後):
  - 音声 DL 完了 → ClipSelectView 開く → **即座に YouTube/Twitch 埋め込みで再生可能**
  - 動画 DL は引き続きバックグラウンドで進行
  - 視聴 + 範囲選定 + AI 抽出が DL 完了を待たずに全部動く
  - 動画 DL 完了後の自動切替は段階 4 で実装(本タスクではユーザがリロードで切替)
- VideoPlayer 並走方針:
  - `VideoPlayer.tsx` は **完全に無変更**で温存
  - `EmbeddedVideoPlayer.tsx` を独立コンポーネントとして新設
  - ClipSelectView が条件分岐で出し分け(filePath あり = VideoPlayer / sessionId あり = Embedded / どちらもなし = DL overlay)
  - 段階 4 で「filePath 到着時に Embedded → VideoPlayer に seamless swap」を実装、その時点で本タスクの中間状態は解消
- 埋め込みプレイヤーの制限事項(spec §7 通り):
  - **削除区間プレビュースキップ無効** — `decidePreviewSkip` ロジックは `<video>.currentTime` 直接操作前提、iframe には届かない
  - **字幕オーバーレイ無効** — `SubtitleOverlay` は `<video>` 上にレイヤー、iframe には乗らない
  - **シーク精度はキーフレーム単位** — YouTube `seekTo(sec, true)` の挙動、フレーム精度が必要なカット確認は DL 完了後に
  - これらは ClipSelectView の左下 hint(`ℹ プレビュー視聴中 — 字幕確認・カット確認は DL 完了後`)で明示
- CSP 設定変更の経緯:
  - 既存の renderer HTML / BrowserWindow webPreferences には **明示的な CSP 設定なし**(Electron デフォルト)
  - YouTube / Twitch の iframe + 外部スクリプトロードは **デフォルトで通る** ことを確認
  - 段階 3 では追加の CSP 緩和は不要、`webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }` を維持
  - 将来 strict CSP を導入する場合の必要追加: `frame-src https://www.youtube.com https://player.twitch.tv` / `script-src ... youtube.com player.twitch.tv`(現時点では spec の記述として残置のみ)
- Twitch parent パラメータ:
  - Twitch Embed は `parent: string[]` 必須(任意のホスト名でいくつでも指定可、SDK が match する origin を選ぶ)
  - 設定値 `['localhost', '127.0.0.1', 'jikkyou-cut.local']`
  - dev 環境(`http://localhost:<port>`): `localhost` で確実にマッチ
  - prod 環境(`file://...`): origin に hostname がないので Twitch SDK 側がどう扱うか実機検証が必要 — 現状は推測で 3 値投入、ダメなら段階 5(Twitch 動作確認)で別解決策
- session ID パース:
  - `youtube_<11chars>` → YouTube IFrame Player(videoId に投入)
  - `twitch_<numeric>` → Twitch Player(video に投入、VOD ID)
  - `url_<sha256>` → 「埋め込みプレイヤー非対応」エラー表示(local drop 等の希少ケース、URL DL 経由なら必ず yt/twitch/url のいずれか)
- 影響: `src/renderer/src/lib/youtubePlayerApi.ts`(新規)/ `src/renderer/src/lib/twitchPlayerApi.ts`(新規)/ `src/renderer/src/components/EmbeddedVideoPlayer.tsx`(新規)+ `.module.css`(新規)/ `src/renderer/src/components/ClipSelectView.tsx`(分岐 + ref 並列)/ `src/renderer/src/components/ClipSelectView.module.css`(badge + hint)
- コミット: (未コミット)

---

## 2026-05-03 - 段階 2/5: 音声優先 DL + AI 抽出早期実行

- 誰が: Claude Code(Opus 4.7)
- 何を: 動画 DL 高速化 5 段階の **段階 2**。URL DL を「音声優先 + 動画バックグラウンド」の二段に分割し、ユーザを動画 DL 完了待ちから解放
  - **新規 main 関数** `urlDownload.ts` の `downloadAudioOnly()` / `downloadVideoOnly()` / `cancelAudioDownload()` / `cancelVideoDownload()` / `deriveSessionId(url)`(YouTube/Twitch ID 抽出 + URL hash フォールバック)
  - **新規 IPC** `urlDownload.startAudioOnly` / `cancelAudio` / `onAudioProgress` / `startVideoOnly` / `cancelVideo` / `onVideoProgress`
  - **editorStore 拡張**: `audioFilePath` / `sessionId` / `videoDownloadStatus { status, progress, error }` state、`enterClipSelectFromUrl()` / `setVideoFilePath()` / `setVideoDownloadProgress()` / `setVideoDownloadFailure()` actions
  - **App.tsx**: `startDownloadFlow` を再構成。await audio → enterClipSelectFromUrl → background fire video → progress/completion を store に流し込み
  - **ClipSelectView**: `if (!filePath && !audioFilePath) return null;` に緩和、VideoPlayer の代わりに `videoDlOverlay`(📥 + バー + AI 抽出可能ヒント)を表示、edit ボタンを `filePath` で gate
  - **aiSummary 統合 IPC**: `audioFilePath` を args に追加。orchestrator は audioFilePath があれば ffmpeg 抽出を **skip**(`audio-extract` phase は `skipped: true` で即座に進行)、ない場合のみ既存の `extractAudioToTemp` 経路
  - **aiSummary cache key**: 旧 videoFilePath ベース → renderer が `sessionId ?? filePath ?? audioFilePath` を `videoKey` として送る形に。同じ URL の audio→video 遷移で cache が継続使用できる
- 旧フロー(DL 完了待ち)の課題:
  - 10 時間配信で 1-2 時間の DL を **何もできずに待たされる**
  - 段階 1 で並列化したが video の絶対サイズはどうしようもない
  - AI 抽出が動画ファイル必須だったため早期実行も不可
- 新フロー:
  - 数十秒で audio が終わる → ClipSelectView 開く → ユーザは即座に範囲選定 / AI 抽出可能
  - 動画は裏で DL 中、完了したら `<video>` がロード(seamless)
  - 「この区間を編集」ボタンだけは動画必須(編集の精度の都合) → DL 完了まで disabled
- セッション ID 設計:
  - YouTube: `youtube_<11-char-id>`(`?v=` / `youtu.be/` 両対応)
  - Twitch: `twitch_<numeric-id>`
  - その他: `url_<sha256-12char>`
  - Cache key 統一: refine cache / Gemini cache どちらも sessionId をキーにする → audio→video 遷移してもキャッシュヒット維持
- 失敗時の扱い:
  - 音声 DL 失敗: ClipSelectView 開かず、エラーモーダル表示(spec 通り)
  - 動画 DL 失敗: ClipSelectView は開いたまま、player overlay にエラー表示。AI 抽出は継続実行可、編集ボタンだけ disabled のまま
  - キャンセル: clearFile が phase=load に戻すので、stale な video DL promise が完了しても sessionId 不一致で setVideoFilePath が no-op
- やらなかったこと:
  - 編集中のプレイヤー切替(段階 4)/ 埋め込みプレイヤー(段階 3)/ Twitch 検証(段階 5)
  - audioFilePath を再生・字幕で使う(編集 phase は引き続き videoFilePath 必須、spec §10 通り)
  - 既存 `urlDownload.start` の削除(段階 5 まで残置、現在は App.tsx から呼ばれない dead 経路)
- 段階 3 への接続:
  - 段階 3 で YouTube/Twitch 埋め込みプレイヤーを導入すれば、video DL 中も再生可能になり「動画 DL 中…」 overlay も置き換わる。
  - 現状の `videoDlOverlay` は段階 3 で「埋め込み iframe」に進化する見込み(同じ場所、同じ条件 = `filePath` null)
- 影響: `src/common/types.ts`(audio/video DL 用 args/result + IpcApi 拡張)/ `src/main/urlDownload.ts`(downloadAudioOnly + downloadVideoOnly + cancel + sessionId)/ `src/main/index.ts`(IPC handlers + autoExtract orchestrator audioFilePath 対応)/ `src/preload/index.ts`(expose)/ `src/renderer/src/store/editorStore.ts`(state + actions)/ `src/renderer/src/App.tsx`(startDownloadFlow 再構成)/ `src/renderer/src/components/ClipSelectView.tsx`(null check 緩和 + DL overlay + edit gate + autoExtract args)/ `src/renderer/src/components/ClipSelectView.module.css`(`videoDl*` クラス追加)
- コミット: (未コミット)

---

## 2026-05-03 - yt-dlp 高速化(段階 1/5: concurrent-fragments + バイナリ更新)

- 誰が: Claude Code(Opus 4.7)
- 何を: 動画 DL の体感速度改善 5 段階再設計の **段階 1**。yt-dlp の引数に `--concurrent-fragments 8` を追加 + ベンチログ整備
  - **追加引数** `'--concurrent-fragments', '8'` を [urlDownload.ts:194](src/main/urlDownload.ts:194) に
  - **新規ログ**: 開始時 `yt-dlp start: url=..., quality=..., version=2026.03.17, concurrent=8`、完了時 `yt-dlp done: 47.2s, size=152.3MB, avg=3.23MB/s`
  - **yt-dlp バージョンを lazy-cache**: `getYtDlpVersion()` が初回 `--version` spawn 後にキャッシュ、以降の DL はキャッシュ使用(spawn コスト回避)
  - **新規** `.gitattributes`: `resources/yt-dlp/yt-dlp.exe binary` + `*.exe binary` で EOL 変換による破損防止
- 5 段階再設計計画(本タスクは段階 1):

  | 段階 | 内容 | 状態 |
  |---|---|---|
  | 1 | yt-dlp 高速化(concurrent-fragments + バイナリ更新) | ✅ 本タスク |
  | 2 | 音声優先 DL + AI 抽出の早期実行(動画 DL 待たず音声だけ先取り) | 次タスク |
  | 3 | YouTube/Twitch 埋め込みプレイヤー導入(DL 完了前から再生可) | 後続 |
  | 4 | 編集中のプレイヤー切替ロジック(埋め込み ↔ ローカル動画) | 後続 |
  | 5 | Twitch 動作確認 + 微調整 | 後続 |

- 旧仕様(シングル接続)の体感:
  - ユーザ報告で「動画ダウンロードが遅い」、10 時間配信で 1-2 時間
  - yt-dlp デフォルトは sequential fragment download、HLS/DASH(YouTube の separate video+audio はほぼ全部これ)で帯域を活かせていない
- `--concurrent-fragments 8` の採用根拠:
  - 経験則的に 4-12 の範囲が最適、8 はサーバ throttling リスクと並列効果のバランス点
  - YouTube は per-fragment の rate limit がゆるく、8 並列でも問題なし(過去事例より)
  - `--concurrent-fragments` は fragment-based DL(HLS/DASH)のみ有効、single-file DL では無視される → 既存の YouTube / その他混在 URL に対して「効くものだけ効く」性質
  - 並列度を UI で設定可能にする抽象化は **やらない**(先回り抽象化禁止)
- yt-dlp バイナリ更新前後:
  - 更新前: `2026.03.17`(`resources/yt-dlp/yt-dlp.exe`)
  - GitHub releases/latest をダウンロードして比較 → **同一バージョン(SHA256 完全一致)で更新不要**
  - 既に最新版が同梱されていたため、binary は触らず
- 進捗パーサの懸念:
  - `--concurrent-fragments 8` で stdout に複数 fragment の `JCUT_PROGRESS` 行が interleave して出力される
  - 既存パーサは「最後の進捗行」を採用する単純実装で、percent 値が時間軸で oscillation する可能性
  - spec の判断「まず既存挙動で動かしてユーザに体感判断」に従い **パーサ無修正で投入**
  - ユーザが「進捗バーがガタつく」報告した場合の対処策(将来):単調増加保証 = `Math.max(currentPercent, latestPercent)` ロジック追加
- 次タスク(段階 2): 音声のみ DL 経路を新設し、commentAnalysis / Gemini 分析を動画 DL の完了を待たずに走らせる。総待ち時間が `max(動画 DL, 音声 DL + 分析)` に短縮する想定
- 影響: `src/main/urlDownload.ts`(args 追加 + ベンチログ + version cache)/ `.gitattributes`(新規)
- コミット: (未コミット)

---

## 2026-05-03 - Gemini キー UI を YouTube と統一(per-key bar + 個別追加/削除)

- 誰が: Claude Code(Opus 4.7)
- 何を: Gemini キー登録 UI を textarea ベースの一括保存 → YouTube キーセクションと同形の **常時表示の per-key 一覧 + 使用状況バー + 個別削除** にリライト
  - **新規 DB テーブル** `gemini_request_log`(`api_key_hash` / `requested_at` / `success` / `status_code` / `model`)+ index `idx_gemini_request_log_key_time`
  - **新規 main 関数** `database.ts` の `logGeminiRequest()` / `getGeminiKeyUsage()`
  - **新規 main util** `utils.ts` に `hashApiKey(key) = sha256(key).slice(0, 12)` 追加 — DB には生キー保管せず hash prefix のみ
  - **gemini.ts の `generateAnalysis`** に呼び出し直後の usage logging を追加(成功/失敗どちらも記録、status_code 込み)
  - **新規 IPC** `gemini.getKeyUsages()` → `GeminiKeyUsage[]`(keyHash / todayCount / todayLimit / lastError)
  - **UI 全面リライト**: 旧 textarea + 一括保存 → YouTube quota panel 形式の per-key 行(キー N / マスク / 使用状況バー / RPD 値 / 状態ラベル / 削除ボタン)+ 1-input + 「追加」ボタン(即保存)+ 30 秒間隔の auto-refresh
- 旧 UI(textarea 一括)の課題:
  - 複数キー一括貼り付けはペースト時の摩擦が低いが、登録後の編集で「どのキーが何件使ったか」が不可視
  - 個別削除ができず、1 個直したい時も全削除→再貼り付けが必要
  - 429/401 エラー時にユーザがどのキーを修正すべきか分からない
- 新 UI の改善:
  - キーごとに使用状況バー(`~24 / 500 RPD ● 利用可能`)
  - 状態ラベル 4 段階: ● 利用可能 / ⚠ もうすぐ上限(≥90%)/ 🔴 上限達成(≥100%)/ 🔴 一時的に利用不可(24h 以内に 401/429)
  - 1 個ずつ追加・削除でユーザの mental model が明確
  - YouTube セクションと視覚一貫性が取れた
- 使用状況の概算性:
  - **自前カウント**(generateContent 呼び出し時に DB に書く)で、AI Studio dashboard の正確値とはズレ得る
  - ズレ要因: (a) 別アプリ / 同じキーの別 IPC からの呼び出しは検知できない、(b) Files API の upload/status/delete は 500 RPD カウントに含まれないが想定と乖離する可能性
  - UI に「~」「(概算)」表記で明示し、ユーザに不正確性を周知
- `todayLimit = 500` のハードコード根拠:
  - gemini-2.5-flash の無料枠 RPD(2026-05 時点)
  - 将来 gemini-3-flash 等への移行 / pay-as-you-go プランで RPD 上限が変わったら再評価
  - モデルごとに per-model 設定を持たせる抽象化は **やらない**(先回り抽象化禁止)
- DB 設計判断:
  - 既存 `api_quota_log` を流用(provider カラム追加)案も検討したが、YouTube は「units / day」で集計済み行、Gemini は「per-request 行」とデータ shape が違いすぎる → 独立テーブルが綺麗
  - `requested_at` は SQLite の `CURRENT_TIMESTAMP`(UTC、`YYYY-MM-DD HH:MM:SS` 形式)、文字列比較で日付フィルタが安定して動く
  - lastError は 24h スライディングウィンドウ + status 401/429 限定(5xx は server-side flake で恒久的なキー品質シグナルではない)
- 影響: `src/main/utils.ts`(`hashApiKey` 追加)/ `src/main/dataCollection/database.ts`(`gemini_request_log` テーブル + `logGeminiRequest` + `getGeminiKeyUsage`)/ `src/main/gemini.ts`(`generateAnalysis` の呼び出し後ログ)/ `src/main/index.ts`(`gemini:getKeyUsages` IPC + `GEMINI_DAILY_RPD = 500`)/ `src/preload/index.ts`(`getKeyUsages` expose)/ `src/common/types.ts`(`GeminiKeyUsage` + `IpcApi.gemini.getKeyUsages`)/ `src/renderer/src/components/ApiManagementView.tsx`(`GeminiKeysSection` 全面リライト)
- コミット: (未コミット)

---

## 2026-05-03 - Gemini 統合 AI 自動切り抜きパイプライン完成(タスク 2)

- 誰が: Claude Code(Opus 4.7)
- 何を: タスク 1 で単独動作していた Gemini 音声分析を、既存の AI 自動切り抜きパイプライン(Claude Haiku refine)に統合。「自動で切り抜き候補を抽出」ボタン 1 つで音声構造理解 → コメントピーク統合 → AI 絞り込み → タイトル生成まで一気通貫
- 変更:
  - **`AutoExtractProgress` 拡張**: phase に `'cache-check' / 'audio-extract' / 'gemini'` を追加(従来 `'detect' / 'refine' / 'titles'` のみ)。`skipped?: boolean` を追加して Gemini 失敗時の表示
  - **`buildRefinePrompt` 拡張**: `geminiHighlights?` + `geminiTimeline?` 引数追加。Gemini 結果あれば 3 セクション(`# 音声内容ベースのハイライト候補` / `# 動画全体の構造` / `# 統合判断の指示`)を差し込む
  - **AI 出力 JSON shape 変更**: 旧 `{ startSec, endSec, reason, predictedTitle }` → 新 `{ candidateIndex, reason, confidence, suggestedStart, suggestedEnd, predictedTitle }`。`candidateIndex` は `'C1' / 'G1' / 'C1+G2'` の文字列で出所明示
  - **`validateRefinedItems` 緩和**: 旧 ±0.1s strict match → 新 `HALLUCINATION_TOLERANCE_SEC = 30` の loose anchor check(AI が ±5-10s で文脈拡張する案を尊重)。`suggestedStart/End` を優先、legacy `startSec/endSec` も後方互換で受ける
  - **`refineCacheKey` 拡張**: `geminiHash` 引数追加。Gemini 再実行で自動キャッシュ無効化
  - **IPC `aiSummary:autoExtract` 再構成**: orchestrator が cache-check → audio-extract → Gemini → autoExtractClipCandidates の順で実行。Gemini 失敗時は warn ログ + skipped フラグで継続(comment-only fallback)
  - **`autoExtractClipCandidates` 内の messages/dominantCategory 解決**: `parseCommentIndex(candidateIndex)` で C-prefixed pick から直接索引、なければ ±30s tolerance で fuzzy match。G-only pick は messages = [] / dominantCategory = null(タイトル生成は predictedTitle にフォールバック)
  - **UI**: `🧪 Gemini 分析(テスト)` ボタン削除、Gemini 専用進捗 modal 削除、`GeminiAnalysisDialog` 描画削除(コンポーネントファイル自体は **残置** — 将来「動画の構造を見たい」用途で復活する可能性)。auto-extract 進捗 modal を 5 ステップ表示(`AutoExtractStepIndicator` 新設、Gemini skipped は `⊘` 付きで struck-through)
  - **キャンセル**: `handleCancelAutoExtract` から `aiSummary.cancel` + `gemini.cancelAnalysis` 両方を発火
- 設計判断:
  - **Gemini 失敗 = comment-only 継続**: Gemini quota 切れ等で AI 抽出全体が詰まないように、Gemini 障害は warn 級。M1.5b と同じ動作にフォールバック
  - **Gemini なしでもボタンは disable しない**: Gemini キー未登録ユーザにも従来機能を提供
  - **`detect` フェーズは UI に出さない**: sub-ms で完了するので独立ステップにする UX 価値が薄い。`refine` ステップに包含
  - **C/G プレフィックス文字列を AI に出させた**: 数値 ID で索引より自然言語に近く、AI が間違いにくい(検証済 prompt 例参照)
  - **`HALLUCINATION_TOLERANCE_SEC = 30s`**: ±5-10s の context-extension は受け入れ、明らかなハルシネーション(99:99 等)は弾く境界値
- 残置したもの:
  - `src/renderer/src/components/GeminiAnalysisDialog.tsx` + `.module.css`(将来の「動画構造ビュアー」復活用)
  - `IpcApi.gemini.analyzeVideo` / `cancelAnalysis` / `onProgress`(統合パスでは別経路で使うが、将来の再活用用に IPC を残す)
  - `extractAudioToTemp` の `filenamePrefix` パラメータ(orchestrator の `jcut-gemini-audio-` で活用中)
- キャッシュキー統合:
  - 旧: `sha256(basename | candidates_sig | tN | globalLastUpdated)`
  - 新: `sha256(basename | candidates_sig | tN | globalLastUpdated | g=geminiHash)`
  - `geminiHash` = `sha256(JSON.stringify(highlights start/end/contentType)).slice(0, 8)` または `'no-gemini'`
  - Gemini cache(`userData/gemini-cache/`)+ refine cache(`userData/comment-analysis/`)の 2 段チェーンで、同じ動画の再抽出は実質 0 秒で返る
- 影響: `src/common/types.ts` / `src/main/aiSummary.ts`(buildRefinePrompt / validateRefinedItems / refineCacheKey / refineCandidatesWithAI / autoExtractClipCandidates)/ `src/main/index.ts`(aiSummary:autoExtract orchestrator)/ `src/renderer/src/components/ClipSelectView.tsx`(Gemini test button 撤去 + 5 ステップ progress modal)/ `src/renderer/src/components/ClipSelectView.module.css`(Gemini-test 関連 CSS 削除 + skipped class 追加)
- コミット: (未コミット)

---

## 2026-05-03 - Gemini モデルを 2.5-flash に変更

- 誰が: Claude Code(Opus 4.7)
- 何を: `src/main/gemini.ts` の `MODEL` 定数を `gemini-2.0-flash-exp` → `gemini-2.5-flash` に変更。あわせて関連コメント(gemini.ts ヘッダ)と UI 説明文(ApiManagementView の help)も更新
- 旧モデル(`gemini-2.0-flash-exp`)を捨てた理由:
  - 2026/3/6 以降、新規プロジェクトでは利用不可
  - 2026/6/1 にシャットダウン予定
  - 「実験版」位置づけで stable 品質保証なし
- 候補比較(2026/5 時点):
  - **`gemini-2.5-flash`**: stable / 無料枠 ~10 RPM / 500 RPD / reasoning 機能 + 1M context + 音声入力 9.5h まで
  - `gemini-2.5-flash-lite`: stable / 無料枠 ~15 RPM / 1000 RPD / 音声コスト低だが reasoning が弱め
- `2.5-flash` を選んだ理由:
  - ハイライト抽出は **構造理解の質が肝心**(spec § 重要な観点で「起承転結」「感情の起伏」が選定基準)、reasoning が強い flash 系が向いている
  - 1M context は 9.5 時間音声に対応、長尺配信切り抜きにも余裕
  - 無料枠(500 RPD)+ multi-key rotation で実質運用可能
- 採用しなかった点:
  - **2.5-flash-lite**: RPM/RPD は多いが reasoning が弱い → スポンサー読み除外などの判断質が落ちる懸念
- API endpoint は変更不要(`/v1beta/models/{model}:generateContent` は両モデルで共通)
- 2.5-flash の挙動差で要観察:
  - **thinking 機能がデフォルト ON** → レスポンス時間が伸びる可能性。本タスクでは `thinkingConfig.thinkingBudget` で制御せず、デフォルトで運用開始。レイテンシが問題になれば budget を絞る判断
  - JSON 出力は `responseMimeType: 'application/json'` で同等、コードフェンス混入時は既存 `parseAnalysisResponse` のフェンス剥がしで吸収可能
- 将来検討:
  - **`gemini-3-flash` 系**が無料枠で安定提供されたら切替検討(現時点(2026/5)では gemini-3 系は preview / 有料のみ)
  - 無料枠縮小傾向への対応(API キー追加運用 / 別モデルへの一時退避)
- 影響: `src/main/gemini.ts`(2 箇所:ヘッダコメント + MODEL 定数)/ `src/renderer/src/components/ApiManagementView.tsx`(GeminiKeysSection の help 文言)
- コミット: (未コミット)

---

## 2026-05-03 - Gemini 音声分析パイプライン実装(タスク 1)

- 誰が: Claude Code(Opus 4.7)
- 何を: 動画音声を Gemini に投げて構造理解 + ハイライト候補を取得するバックエンドを実装。タスク 1 のスコープは「Gemini に投げて結果を JSON モーダルで表示するまで」。既存 AI 抽出パイプラインへの統合はタスク 2 持ち越し
  - **新規ファイル**: `src/main/gemini.ts`(rotator + Files API resumable upload + generateContent + cache + cancel)
  - **新規ファイル**: `src/main/utils.ts`(`videoKeyToFilenameStem` を aiSummary.ts から共通化、gemini.ts と共有)
  - **新規ファイル**: `src/renderer/src/components/GeminiAnalysisDialog.tsx` + `.module.css`(タイムライン + ハイライト + JSON コピー結果モーダル)
  - **拡張**: `secureStorage.ts` に `saveGeminiApiKeys` / `loadGeminiApiKeys` / `clearGeminiApiKeys` / `hasGeminiApiKeys` / `countGeminiApiKeys`(YouTube と同じ DPAPI 多重キーパターン)
  - **拡張**: `audioExtraction.ts` の `extractAudioToTemp` に `filenamePrefix?` パラメータ追加(default `jcut-audio-`、Gemini path で `jcut-gemini-audio-` を渡してファイル名衝突回避)
  - **新規 IPC**: `gemini.{hasApiKey, getKeyCount, getKeys, setKeys, clear, validateApiKey, analyzeVideo, cancelAnalysis, onProgress}`
  - **UI**: `ApiManagementView` に `GeminiKeysSection`(textarea ベース、1 行 1 キー、最大 50 件)
  - **UI**: `ClipSelectView` ヘッダに「🧪 Gemini 分析(テスト)」ボタン(暫定、タスク 2 で撤去予定)+ 4 フェーズ進捗モーダル
- 背景:
  - 現状の AI 自動切り抜き(M1.5b 完了)はコメント密度・キーワードベースで判定 → 「コメントが盛り上がってる ≠ 内容が面白い」というギャップ(スポンサー読み・配信冒頭挨拶などコメントは多いが切り抜き対象として外れる区間が選ばれる)
  - 解決方針: 動画音声を Gemini API に投げて **音声内容そのもの** を構造理解させ、内容ベースのハイライト候補を取得
- なぜ Gemini を選んだか:
  - プロジェクト無限作戦(Google Cloud の無料枠を複数プロジェクトで横断)で実質無料運用可能
  - 既存の Gladia(編集後文字起こし)とは役割を明確に分離: **Gladia = 編集前最終出力用の transcribe / Gemini = 分析フェーズの構造理解**(同じ動画に対し両方走るのは無駄に見えるが、Gladia は精度優先で時間がかかり、Gemini は分析特化で速度優先)
  - `gemini-2.0-flash-exp` を選択: Files API 経由で長時間音声を扱える + responseMimeType=application/json で strict JSON 出力 + flash 系で速度・コスト優位
- 設計判断:
  - **rotator は in-memory で独立実装**: YouTube の `ApiKeyRotator`(SQLite quota log 依存)と同じ抽象を作るより、Gemini 専用のシンプルな round-robin + mute-on-error にした。「先回り抽象化禁止」原則に従い、quota tracking が将来必要になったら抽象化判断
  - **Files API は resumable upload を採用**: 2 round-trip だが任意サイズに対応。multipart は単発で済むがバイナリ multipart の手書きが煩雑
  - **キャッシュは永続(TTL なし)**: 同じ動画に対して同じ音声入力なら同じ結果になる性質、AI 抽出と同じ判断
  - **`onProgress` は IPC イベントで「extracting → uploading → understanding → parsing」の 4 フェーズ通知**: 進捗 % は出さない(構造理解は 1-3 分かかるため細かいバーは無意味、フェーズ表示で十分)
  - **キャッシュヒット時も `parsing` イベントを 1 回送る**: モーダルが進捗バー描画完了感を持たずに即座に閉じてしまう UX 問題を回避
  - **音声抽出は既存 `extractAudioToTemp` を流用**: 16kHz mono 64kbps mp3 で Gemini 内部 downsample に合致。コメントに「Gemini downsamples to internally」と書かれていた(つまり過去に Gemini 統合された遺物)— prefix 切替で再活用
- リトライポリシー:
  - 401 / 403: 24 時間 mute(キー無効 / 認証失敗)
  - 429 / 5xx: 60 秒 mute(rate limit / transient)
  - 不明エラー: 30 秒 mute
  - 最大試行 = キー数 × 2(2 周まで)、それでも全死亡で `全 API キーが quota 超過 / エラー` を throw
  - JSON パース失敗: 同じキー + 同じアップロードで 1 回再試行 → 二度目も失敗なら **空 highlights のフォールバック結果**(UI が壊れるよりマシ)
- 監査結果(タスク 2 着手時の参考):
  - `analyzeVideoAudio` の引数は `(audioFilePath, videoTitle, durationSec, signal, onProgress)` で signal を combined(timeout + user cancel)化
  - cancellation は `cancelAnalysis()` でモジュールレベルの ac.abort() → 進行中の fetch も中断
  - cleanup: 成功/失敗どちらでも uploaded file を best-effort DELETE、temp 音声ファイルも IPC handler の finally で削除
- 影響: `src/main/utils.ts`(新規)/ `src/main/gemini.ts`(新規)/ `src/main/secureStorage.ts`(Gemini 拡張)/ `src/main/audioExtraction.ts`(prefix 引数追加)/ `src/main/index.ts`(IPC ハンドラ群)/ `src/main/aiSummary.ts`(`videoKeyToFilenameStem` を utils.ts から import)/ `src/preload/index.ts`(gemini namespace expose)/ `src/common/types.ts`(GeminiAnalysisResult 等の型 + IpcApi.gemini)/ `src/renderer/src/components/ApiManagementView.tsx`(GeminiKeysSection)/ `src/renderer/src/components/ClipSelectView.tsx`(test button + 進捗 modal)/ `src/renderer/src/components/ClipSelectView.module.css`(geminiTestButton + 進捗 modal CSS)/ `src/renderer/src/components/GeminiAnalysisDialog.tsx`(新規)/ `src/renderer/src/components/GeminiAnalysisDialog.module.css`(新規)
- コミット: (未コミット)

---

## 2026-05-03 - aiSummary キャッシュパス連結バグ修正

- 誰が: Claude Code(Opus 4.7)
- 症状: ClipSelectView で「自動で切り抜き候補を抽出」を押すと `ENOENT: no such file or directory, open 'C:\Users\...\comment-analysis\C:\Users\...\Downloads\jikkyou-cut\5.mp4-summaries.json'` で失敗。2 つの絶対パスが連結されたパスが投げ込まれていた
- 真因: `aiSummary.ts` のキャッシュファイル名構築で、renderer から渡される `videoKey`(= `editorStore.filePath` の絶対パス)を **basename 化せずに** ファイル名にそのまま interpolate していた。Windows の `path.join(cacheDir, "C:\\full\\path-summaries.json")` は右側の絶対パスをそのまま付与するので、`<cacheDir>\C:\<full>\path-summaries.json` という不正パスが生成されて fs が ENOENT を返していた
- 修正(2 箇所、いずれも [aiSummary.ts](src/main/aiSummary.ts) 内):
  - 共通ヘルパ `videoKeyToFilenameStem(videoKey)` 追加 — `path.basename` で flatten した後 Windows 禁止文字 `\ / : * ? " < > |` を `_` に置換
  - `cacheFilePath`(行 70-71、summaries 用): `${videoKey}` → `${videoKeyToFilenameStem(videoKey)}`
  - `refineCacheFilePath`(行 386-387、extractions 用): 同上
- 監査結果(該当箇所が他にないか):
  - `aiSummary.ts` 内で `videoKey` をファイル名に interpolate していたのは上記 2 箇所のみ
  - `refineCacheKey`(行 417 付近)は `videoFileBasename` 引数を受け取るが sha256 hex 化されるのでファイルシステム上の不正文字問題は発生しない(関数名は misleading だが機能的には問題なし、本タスクでは触らず)
  - 他モジュール(`project.ts` / `export.ts` / `gladia.ts` / `audioExtraction.ts`)は `path.dirname` / `path.basename` を経由しており同様のバグはなし
- なぜ気付かれなかったか:
  - M1.0 の AI タイトル生成パスは「videoKey として renderer の `filePath`(絶対パス)」をそのまま受け取って同じ構築をしていたが、ユーザがその flow を本格運用する前に M1.5* / Phase 2a / M1.5b の連続改修が入った
  - 自動抽出ボタンを **本格的に押した最初の機会で発覚** したと推定
- 影響: `src/main/aiSummary.ts` のみ
- コミット: (未コミット)

---

## 2026-05-03 - frequentKeywords フィルタを viewBoost 軸に変更

- 誰が: Claude Code(Opus 4.7)
- 何を: AI プロンプトの「頻出キーワード」セクションのフィルタを **頻度ベース → 視聴ブーストベース** に切替
  - **撤廃**: `BOILERPLATE_FREQ_THRESHOLD = 0.5`(`freq < 0.5` で除外)
  - **新設**: `VIEW_BOOST_THRESHOLD = 0.7`(`viewBoost < 0.7` を「伸びを妨げる boilerplate」として除外)
  - フィルタ後は **viewBoost DESC でソート**して上位 5 個を取得(spec の期待出力に合わせ)
  - プロンプト内の見出しを「頻出キーワード(boilerplate 除外後):」→「頻出キーワード(伸びる傾向のあるもの):」に
- 旧 spec(`freq >= 0.5`)が機能しなかった経緯:
  - 直前タスクの実機データ確認で、global 集計(1552 videos × 75 creators × 5 groups)では top 1 の `切り抜き` でも freq 29.6% で 0.5 閾値に届かないと判明
  - データ規模が大きく多様性があるほど単一語の頻度は薄まる → 閾値 0.5 のままだと boilerplate がそのままプロンプトに混入
- viewBoost 軸への切り替え理由:
  - 「伸びる動画にはこういう単語が多い」が AI に渡したい本来のシグナル
  - `viewBoost = (キーワードを含む動画の平均 view_count) / (全動画の平均 view_count)`
  - boilerplate(`切り抜き` `にじさんじ`)は viewBoost < 1.0(よくある単語=平均的、特に伸びてない)、hashtag 系(`#shorts` `#切り抜き`)は viewBoost > 1.0(SEO 効果で実際に伸びる)という対比が綺麗に出る
- `VIEW_BOOST_THRESHOLD = 0.7` の根拠:
  - 現データで以下が綺麗に切れる:
    - **採用**: `#切り抜き` 1.70 / `#shorts` 1.49 / `#にじさんじ` 1.15 / `ぶいすぽ` 0.93 / `にじさんじ切り抜き` 0.86
    - **除外**: `切り抜き` 0.65 / `にじさんじ` 0.59 / `葛葉` 0.62 / `ホロライブ切り抜き` 0.47
  - `ホロライブ` 0.73 はぎりぎり通過(top 5 内には入らず実質除外)
- キャッシュ無効化の扱い:
  - `refineCacheKey` は `globalPatterns.lastUpdated` を folding しているので、パターン再生成すれば自動で新キャッシュに
  - 本タスクはコード側のフィルタロジック変更なので、global.json を再生成しなくても挙動は変わる
  - 既存キャッシュ(boilerplate 入りプロンプト由来)はユーザが「再抽出」を押した時に新ロジックで上書き
- 残課題: コンテンツ語(神回 / 発狂 / APEX 等)は global 集計では取り出せない問題が依然として残る。tf-idf や配信者別併用で抽出する別タスク化(TODO 行き)
- 影響: `src/main/aiSummary.ts`(定数 + `buildPatternBlock` のフィルタ + ソート + 見出し)
- コミット: (未コミット)

---

## 2026-05-03 - AI 抽出を全動画統合パターンに切替(M1.5b + ClipSelectView UI 整理)

- 誰が: Claude Code(Opus 4.7)
- 設計変更: AI 自動切り抜き候補抽出のパターン feed を **配信者別 → 全動画統合(global.json)1 つだけ**に切替
  - **追加**: `analyzer.ts` に `analyzeGlobal(db, ts)` 追加、`runPatternAnalysis()` が `userData/patterns/global.json` を生成
  - **追加**: `aiSummary.ts` に `loadGlobalPatterns()` 追加、`buildRefinePrompt` に「# 切り抜き動画一般の伸びパターン」セクション挿入
  - **削除**: `buildRefinePrompt` の `creator?` 引数は legacy として残置(default undefined)、すべての caller は globalPatterns 経由
  - **削除**: `autoExtractClipCandidates` から `creatorOverride` / main 内 `estimateCreator` フォールバック処理
  - **削除**: `AutoExtractStartArgs.creatorOverride` フィールド(`videoTitle` / `channelName` は将来用に残置)
  - **削除**: ClipSelectView の配信者バッジ UI、`detectedCreator` state、`estimateCreator` 自動呼び出し、`CreatorPickerDialog` 描画
  - **CSS 整理**: `autoExtractWrap` / `creatorRow*` 関連クラス削除、`autoExtractGroup` を flat に戻す
- 残置したコード(将来の Phase 2 残りタスクで再活用予定):
  - `src/main/dataCollection/estimateCreator.ts`(配信者推定 + listSeedCreatorsForPicker)
  - `src/renderer/src/components/CreatorPickerDialog.tsx` + `.module.css`
  - IPC `dataCollection.estimateCreator` / `dataCollection.listSeedCreators`
  - `buildRefinePrompt` の `_creator?` 引数(現状すべて undefined で呼ばれる)
- なぜ配信者別をやめたか:
  - 朝の Phase 2a の動作確認で、配信者ごとのパターンが現データ規模(各 100 件前後)では統計的に弱いと判断
  - 「切り抜き動画一般の伸びパターン」を AI に渡す方が、配信者属性に依存せず汎用的に機能
  - データが 10K+ 件貯まった段階で配信者別の有意性を再評価する余地はあり(Phase 2b 範囲)
- frequentKeywords フィルタ(`freq >= 0.5` 除外)の根拠:
  - 朝の Phase 2a 観察で boilerplate キーワード(`にじさんじ` `切り抜き` `#shorts` 等)が top 10 を支配する現象を確認
  - SEO 目的の hashtag / boilerplate を AI プロンプトから除く意図
  - **ただし実データ(1552 videos 集計)では top 1 が `切り抜き` 29.6% で、0.5 閾値だと 1 語も filter されない**(報告参照)。閾値の再評価が次の課題
- キャッシュキー変更: `refineCacheKey` の formula を `sha256(videoFileBasename | candidates_sig | tN | globalPatterns.lastUpdated).slice(0,12)` に
  - M1.5a の creator-folding 形式とは互換切れ
  - 古いキャッシュ entry は新キーで上書きされていくので削除不要
  - パターン再分析(`lastUpdated` 更新)で自動的に cache miss → 新プロンプトで再抽出
- 影響: `src/main/dataCollection/analyzer.ts`(analyzeGlobal 追加)/ `src/common/types.ts`(PatternAnalysisResult 拡張・creatorOverride 削除)/ `src/main/aiSummary.ts`(loadGlobalPatterns / buildPatternBlock / refineCacheKey の sha256 化)/ `src/renderer/src/components/ClipSelectView.tsx`(badge UI 削除)/ `src/renderer/src/components/ClipSelectView.module.css`(dead CSS 削除)/ `src/renderer/src/components/DataCollectionSettings.tsx`(dialog 文言更新)
- コミット: (未コミット)

---

## 2026-05-03 - Phase 2a パターン分析 analyzer 実装(creator/group 別 JSON 生成)

- 誰が: Claude Code(Opus 4.7)
- 何を: 蓄積データから配信者別 / グループ別の伸びパターンを JSON で書き出す analyzer を新設。M1.5b の AI プロンプトに食わせるパターン情報の供給源
  - **新規ファイル**: `src/main/dataCollection/analyzer.ts`(`runPatternAnalysis()` 同期関数)
  - **新規 IPC**: `dataCollection.runPatternAnalysis()` → `PatternAnalysisResult { generatedCreators, skippedCreators, generatedGroups }`
  - **UI**: `DataCollectionSettings` の取得操作ボタン群に「パターン分析を実行」(BarChart3 アイコン)を追加。完了後 `window.alert` で件数サマリ表示
  - **出力**: `userData/patterns/<creatorName>.json` + `userData/patterns/group_<group>.json`(Windows 禁止文字を `_` に置換)
- 簡易版スコープ(確定):
  - 実装: `titlePatterns`(frequentKeywords / lengthDist / emojiUsage)、`durationPatterns`(p10/p50/p90)、`peakLocationPatterns`(rank=1 ピーク位置の earlyHook/midSpike/endingClimax 比率)
  - 後回し(M3+): viewVelocity / thumbnailPatterns / chapterPatterns / topVideos
  - 根拠: thumbnailPatterns は画像処理(顔検出 / 色 / OCR)が重く依存追加が必要、まず 3 種で M1.5b のプロンプト統合価値を検証してから判断
- 閾値判断:
  - **`MIN_SAMPLES_FOR_CREATOR_PATTERN = 20`** — 統計的に意味のあるパターンの最低限。これ未満だと「神回:100% / 発狂:80%」のような誤誘導パターンが出る
  - 現データで個別 JSON 生成は **葛葉(153) / 叶(131) / 不破湊(68)** の 3 名、72 名スキップ。グループ別は 5 グループ全部生成
  - グループ別は閾値ガード無し(全員集計でサンプル十分)
- 形態素解析を入れず単純トークン分割にした理由:
  - MeCab / kuromoji 等は重い native dependency を追加する
  - AI(Haiku)は雑音入りトークンリストでも文脈理解できる前提で「事実をそのまま渡す」設計に倒した
  - 実出力では `にじさんじ` `切り抜き` `#shorts` `#葛葉` 等の hashtag / boilerplate が上位を占める結果。M1.5b でプロンプト側でフィルタリングする
- ピーク位置バケット境界:
  - earlyHook: pos < 0.2、midSpike: [0.2, 0.7)、endingClimax: pos >= 0.7
  - 母数 = rank=1 peak が存在する動画のみ(spec の単純化案を採用)
  - 葛葉実データ: earlyHook 76% / midSpike 24% / endingClimax 0% — ショート系切り抜きが多く、peak が動画前半に集中する傾向を反映
- データアクセス:
  - read-only クエリのみ(better-sqlite3 同期 API、event loop 一時ブロックは ms オーダーなので yield 不要)
  - 既存 `openDb()` 経路を踏襲、estimateCreator.ts と同じ階層
- 影響: `src/main/dataCollection/analyzer.ts`(新規)/ `src/main/index.ts` / `src/preload/index.ts` / `src/common/types.ts` / `src/renderer/src/components/DataCollectionSettings.tsx`
- コミット: (未コミット)

---

## 2026-05-03 - batch サイクルを動的間隔に変更(2h 固定 → 新規率ベース 3/10/20/30 分)

- 誰が: Claude Code(Opus 4.7)
- 何を: data-collection の batch スケジューラを「2h 固定間隔」から「直前 batch の新規率に応じた動的 sleep」に置き換え
  - 新仕様の **SLEEP_TIERS**:

    | 新規率(`newCount / candidateCount`)| sleep |
    |---|---|
    | ≥ 20% | 3 min |
    | 10–20% | 10 min |
    | 5–10% | 20 min |
    | < 5%(0% 含む)| 30 min |

  - cancelled / candidateCount=0 / 例外時 は `FALLBACK_SLEEP_MS = 30 min`(最下層 tier と同じ)
  - **`COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1000` を撤廃**
  - **`BatchResult` 型を新設**: `{ cancelled, candidateCount, newCount, savedCount, failures }`。`_collectBatch` / `runOneBatch` の戻り値型に
  - 4 つの `cancelRequested` 早期 return パスはすべて `buildResult(true)` を返し、partial counter を保持
  - `scheduleNext` を「runOneBatch の結果から `pickNextDelay` で次回 delay を計算 → 自分自身を再 arm」する形に置換。既存の `setTimeout` recursive re-arming + `clearTimeout` キャンセル機構をそのまま活用(spec の自前 loop 案は採用せず)
  - `runOneBatch` は `_collectBatch` 内エラーを既存通り `logError(`batch error: ...`)` で吸収して fallback BatchResult を返す。`scheduleNext` 側の `.catch` は最終防衛(programming error 時に schedule を死なせない保険)
  - `runOneBatch` 完走時に **batch summary** ログ:`batch summary — new rate X% (n/c), saved=S, failures=F, sleeping Mmin`
  - **quota 80% 警告**: `maybeWarnOnQuota()` を batch 完走時に呼び、`getTotalQuotaUsedToday() / (keyCount × 10000)` が `QUOTA_WARN_THRESHOLD = 0.80` を超えたら logInfo で `⚠ quota at X% (used/limit) — consider adding new API keys`。UI 通知は出さない(別タスク TODO 化)
  - **UI**: `formatNextBatch` の閾値を `sec <= 60` で「間もなく」に変更(動的化後は最短 3 分間隔なので秒単位精度の表示は意味が薄い)。それ以外の formatter ロジックは温存 — 「次まで 3 分」「次まで 30 分」が秒数から自動で出る
- 旧仕様の課題: 2026-05-02 〜 05-03 の運用観測で本日 quota 消費が 39K / 500K = 7.8% と判明、92% 残量。50 キー体制を活かせていない一方、無駄打ち(新規 0 件 batch 連発)も避けたい。新規率ベースなら YouTube 側の upload pace を吸収しつつ、波があるときは 3 分回しに加速する
- 採用しなかった案:
  - **spec 案 2(自前 while loop に書き換え)**: 既存の `setTimeout` recursive + `clearTimeout` キャンセルが既に等価に動く構造だったため、最小変更で動的 delay を流し込む方式に変更。pause/cancel の動線をいじらずに済む
  - **quota 残量による sleep 延長**: 「枯れたら新キー追加」運用前提とユーザが明示。実装しない
  - **UI 通知ポップアップ**: ログだけで十分(操作者は log viewer で気付ける)、別タスク化
- 開放されている設計判断:
  - **SLEEP_TIERS の閾値**: 初期値、運用 1 週間後にデータドリブンで再評価予定(TODO 行き)
  - **quota 警告の頻度**: batch 完走ごとに毎回ログを出すので、80% 超過後はログが連発する。閾値クロスの 1 度だけ警告する形に絞るかは様子見
  - **`saved === 0 && failures >= 5` の `NETWORK_RETRY_COOLDOWN_MS`(5 min)追加 sleep**: dynamic cycle delay の前段として残してある。ネットワーク自体が壊れている時の tight retry を防ぐ。重複に見えるが意味は別(in-band cooldown vs out-of-band tier)
- 影響: `src/main/dataCollection/index.ts` / `src/renderer/src/components/DataCollectionSettings.tsx`(`formatNextBatch` 1 関数のみ)
- コミット: (未コミット)

### 追記 2026-05-03 - SLEEP_TIERS を攻めの設定に短縮

- 初期投入の `3/10/20/30 min × 20%/10%/5%/0%` で運用開始したところ、新規率 < 5% tier(30 分待機)が頻発しユーザ体感で「待ちすぎ」
- 閾値はそのままに sleep 値だけ短縮: **`1/3/5/10 min`**
- `FALLBACK_SLEEP_MS`(cancelled / candidateCount=0 / 例外時)も最遅 tier に追従して `30min → 10min`。「異常時だけ昔の仕様」を残さず一貫性を保つ
- quota 試算(最悪ケース): 24h × 60min ÷ 1min/batch × 700 units/batch ≈ **336K/day**、50 キーの 500K 枠の 67% — まだ余裕あり
- 運用 1 週間後にまた再評価する余地あり(TODO 行きの SLEEP_TIERS 閾値再評価項目をそのまま継続)

---

## 2026-05-02 深夜 - logger.ts を appendFileSync に切替えて write chain freeze を解消

- 誰が: Claude Code(Opus 4.7)
- 観測症状(2026-05-02 のバックテスト):
  - `userData/data-collection/collection.log` の最終書込みが 13:06:52Z で固着
  - 一方で DB(better-sqlite3, sync)には毎分 16-26 video の挿入が継続
  - `batch start` 9 件に対し `batch done` 0 件、`batch error` も 0 件 — orchestrator は動いてるのに log が出ない
- 当初仮説と外れた経緯:
  - 仮説 A:「promise chain が一度 reject されたら catch 不在で chain が swallow される」だったが、コードを読んだら `writeQueue.then(append).catch(handleErr)` で **既に `.catch()` が末尾に付いていた** — 個別の reject からは構造的に回復できる作り
  - 単発の reject ではこの症状にならない
- 修正版仮説(採用):
  - `fs.appendFile` が **永久 pending(settle しない)** ケースが起きると、chain head が pending のまま固まり、後続の全 `writeLine` がそこで詰まる
  - Windows でこれが起きうる原因:アンチウイルス / OneDrive / Windows Search indexer の排他ロック、`logReader.ts` 等の同時 read、ファイルハンドルリーク
  - DB は別チャネル(better-sqlite3, sync)なので継続、log だけ止まる症状と一致
  - `batch done` も `batch error` も logger 経由なので両方とも書き出されない → 0 件症状の一次原因はこれと推定
- 採用した修正:
  - `writeLine` を `fs.appendFileSync` に切替、`writeQueue` chain を全廃
  - `try/catch` で同期エラーを `console.error` に出すのみ、再 throw せず(log 失敗が pipeline を落とさない)
  - import を `promises as fs` → `appendFileSync, mkdirSync` に変更、関連 dead code なし
- なぜ「chain + timeout race」(spec 案 A 改) や「queue + interval flush」(spec 案 B) でなく sync 化を選んだか:
  - chain そのものが脆弱性の温床(pending が滞留する構造)。timeout race は orphan promise を貯める対症療法
  - queue 方式は内部 buffer + interval state を増やす — 「壊れにくい単純な構造優先」の指示に逆行
  - sync 化は chain メカニズムを物理的に廃止 → 「queue 頭が pending で固まる」事象が発生不可能に
  - 行のテアリングも構造的に起きない(per-call open+write+close が atomic)
- トレードオフ:
  - event loop ブロック ~50-200µs/call、1 batch ~数百行 → 累積 10-100ms
  - 同じ event loop で `better-sqlite3`(sync)が回っているので新規ペナルティではない
  - yt-dlp / API call(数秒〜数分)に比べて誤差レベル
- 残課題:
  - **batch done ログが本修正で出るようになるか、明朝のバックテスト(2026-05-03 朝)で確認**
  - もし出ない場合は logger 以外(orchestrator の早期 return / 例外パス / cancelRequested の意図しない発火)を別タスクで調査
- 影響: `src/main/dataCollection/logger.ts`(write 関数のみ)
- コミット: (未コミット)

---

## 2026-05-02 - AI 抽出に配信者推定を追加(M1.5a)

- 誰が: Claude Code(Opus 4.7)
- 何を: AI 自動抽出の refine プロンプトに配信者情報を埋め込めるよう、推定 + 手動オーバーライド + ピッカー UI を追加。M1.5 を **M1.5a(配信者推定だけ)** と **M1.5b(パターンファイル読込)** に分割し、本タスクは前者だけ実装
  - **新規 pure 関数** `src/main/dataCollection/estimateCreator.ts`:
    - `estimateCreator(db, { videoTitle, channelName? })` → `{ creatorName, creatorGroup, source: 'channel-match' | 'title-match' | 'unknown' }`
    - 優先順位: (1) channelName 完全一致 → (2) videoTitle に creators.name 部分一致(最長一致 + 3 文字以上、`MIN_TITLE_MATCH_LEN=3` で「叶」等の 1-2 文字名は title-match 不可)→ (3) unknown
    - `listSeedCreatorsForPicker(db)` も同居(is_target=1, group→name 順)
  - **AI プロンプト拡張**: `buildRefinePrompt(candidates, targetCount, creator?)` の冒頭に `# 動画情報\n配信者: <name> (<group>)\n\n` を差し込む。creator なしなら何も足さない(M1.0 動作維持)
  - **キャッシュ key 拡張**: `refineCacheKey` に creator を folding。同じ pool でも creator 違いで別キャッシュ。creator 未指定時は prefix 空で M1.0 のキャッシュにヒット
  - **`autoExtractClipCandidates` 拡張**: 引数に `creatorOverride?: { name; group } | null` + `videoTitle?` + `channelName?`。三状態 — explicit value / null = 指定なし強制 / undefined = main 内で estimateCreator フォールバック(legacy caller 互換)
  - **新規 IPC**: `dataCollection.estimateCreator(args)` + `dataCollection.listSeedCreators()`
  - **UI**: `CreatorPickerDialog`(検索 + グループ別セクション + 「指定なし」)。ヘッダの ✨ ボタン下に `配信者: 葛葉 (にじさんじ) [変更]` の小バッジ。「変更」で picker 開く
  - **推定タイミング**: ClipSelectView の `useEffect` が `fileName` 変化で `estimateCreator` IPC を呼ぶ。fileName(basename)を videoTitle 代わりに使う(yt-dlp の default template にタイトルが含まれる前提の pragmatic shortcut。実際の videoTitle を流すには urlDownload の return → editorStore の plumbing が必要、それは out-of-scope)
  - **永続化**: 配信者選択は ClipSelectView の local state のみ。ファイル切替で消える(spec 通り)
- スコープ分割の理由: M1.5b(`loadPatterns`)は「Phase 2 の analyzer がパターン JSON を吐く前提」だが、Phase 2 はまだ未着手かつ蓄積データが安定してない。明朝のバックテスト(2026-05-03 朝)結果を見てから JSON スキーマを **実データドリブンで** 決める方針。先行で type だけ決めると後で書き直しになる
- 仕様書差分の処理:
  - **シグネチャ**: spec の `creatorOverride` 三状態 (undefined/null/value) は実装が遵守。renderer は実用上 null か value しか送らないが、main 側のフォールバック estimation はテスト/legacy caller 用に残してある
  - **fileName を videoTitle 代わりに使った**: editorStore に video の本物 title が無いため。urlDownload は `{ filePath, title }` を返すが store に保存していない。M1.5b 着手時に「title を store に乗せる」を別タスクで切り出すか判断
  - **AI への指示文や選定基準は変更せず**: spec 9 の「やらないこと」に従って配信者名を渡すだけ。今後 M1.5b でパターン情報を渡す段で指示文も拡張する
- 影響: `src/common/types.ts` / `src/main/dataCollection/estimateCreator.ts`(新規)/ `src/main/index.ts` / `src/main/aiSummary.ts` / `src/preload/index.ts` / `src/renderer/src/components/ClipSelectView.tsx` / `src/renderer/src/components/ClipSelectView.module.css` / `src/renderer/src/components/CreatorPickerDialog.tsx`(新規)/ `src/renderer/src/components/CreatorPickerDialog.module.css`(新規)
- コミット: (未コミット)

---

## 2026-05-02 - AI 自動切り抜き候補抽出 M1.0 ギャップ埋め(ClipSegment 拡張 + 視覚区別)

- 誰が: Claude Code(Opus 4.7)
- 何を: 仕様書 `AI_AUTO_EXTRACTION_DESIGN.md` の M1.0 を実装しようとしたら**コア機能はほぼ全部実装済み**だった。残ギャップだけを埋めた:
  - `ClipSegment` に `aiSource?: 'auto-extract' | 'manual'` / `aiReason?: string` / `aiConfidence?: number` を optional 追加(types.ts)
  - `autoExtractClipCandidates` の最終 segments 組み立てで `aiSource: 'auto-extract'` + `aiReason: r.reason` を埋める(aiSummary.ts)
  - 手動追加経路(`handleAddFromDrag`)は `aiSource: 'manual'` を明示。AI 抽出経路(`handleAutoExtract`)は spread + 上書きで passthrough
  - `ClipSegmentsList` のカード左に Sparkles バッジ(`aiSource === 'auto-extract'` のときのみ)。`title` 属性で `AI 抽出: <reason>` をホバー表示
  - `aiConfidence` は型のみ追加、現時点では Stage 2 が返さないので埋まらない。M1.5+ で `RefinedCandidate` 拡張時に伝播
- 仕様書との差分メモ(本タスクで**修正しない**と明示判断したもの):
  - **ファイル名**: 仕様書は `src/main/autoExtract.ts` 新規だが、実装は `src/main/aiSummary.ts` の Stage 2/4 に統合配置。共有する `callAnthropicRaw` / `cleanTitle` / `runParallel` を 1 ファイルに置く判断。リネーム churn 回避
  - **IPC 名**: 仕様書は `autoExtract.start/cancel`、実装は `aiSummary.autoExtract / aiSummary.cancel`。`aiSummary.*` 名前空間で AI 系統を束ねる設計時の整理。動作影響なし
  - **入力形式**: 仕様書は renderer で `topPeaks` を渡す、実装は `buckets + windowSec` を渡して main 側で `detectPeakCandidates` を毎回呼ぶ。peak detection は sub-ms なので等価
  - **キャッシュ TTL**: 仕様書 24h、実装は永続(TTL なし)。同じ動画 + 同じピーク入力なら出力も同じ性質の処理なので時間で陳腐化させる意味がないと判断。クリア手段が無いのは別タスク TODO 化
  - **editorStore.autoExtractMeta**: 未配置(ClipSelectView の local state で管理)。困っていないので移植せず
- 理由: CLAUDE.md の「先回り抽象化禁止 / MVP スコープ」に従い、動いてるコードのリネーム churn(ログ・既存 PR・ドキュメントとの不整合リスク)を避けた。ユーザに状況報告して合意の上で「ギャップだけ埋める」方針確定
- 影響: `src/common/types.ts` / `src/main/aiSummary.ts` / `src/renderer/src/components/ClipSelectView.tsx` / `src/renderer/src/components/ClipSegmentsList.tsx` / `src/renderer/src/components/ClipSegmentsList.module.css`
- コミット: (未コミット)

---

## 2026-05-03 12:00 - データ収集の最終検証 + 運用 Runbook 整備

- 誰が: Claude Code
- 何を: 直前 migration 後に発覚した NULL group 2 件(ぶゅりる→streamer / 剣持刀也→nijisanji)を毎起動の reseed で恒久解決、新規収集サイクル時の auto-add 回帰検出用に diagnose Q15-Q17 拡張、本格運用前のチェックリスト + 監視ポイント + トラブル対処を `docs/DATA_COLLECTION_OPS.md` に Runbook 化
- NULL group の真因(コード読みベース、collection.log で確証):batch の per-creator hit 経路で旧式 `upsertCreator(name, channelId, isTarget)` 3 引数版が group 引数なしで INSERT したケース。creators.json は 75 ある状態で DB 行が無いとき(`seedOrUpdateCreators` は creators.json を見て「sync 済み」判定で skip → DB に行を作らない)、batch が動くと per-creator hit から INSERT が走り、group=NULL で DB 行が出来る。今は uploaders 分離 migration 後で 3 引数版経路は撤廃済みだが、過去のデータが残っていたので reseed が必要だった
- 修正:
  - `seedCreators.ts` に `reseedGroupsForExistingCreators()` 追加 — `UPDATE creators SET creator_group = ? WHERE name = ? AND (creator_group IS NULL OR creator_group != ?) AND is_target = 1` を SEED_CREATORS の全エントリに対して実行(冪等)
  - `seedOrUpdateCreators` の早期 return を撤去、reseed を **毎起動必ず実行**。SEED_CREATORS を source-of-truth として DB を整合させる
  - `diagnose.ts` に Q3b(NULL group creator 名一覧)+ Q15(直近 1h videos 振り分け)+ Q16(直近 1h 新規 uploaders)+ Q17(直近 1h 新規 creators、0 期待・非 0 で `⚠ AUTO-ADD REGRESSION SUSPECTED`)
- 検証(実機 hot-reload で reseed 実行):
  - collection.log に `reseed group: "剣持刀也" → nijisanji` / `reseed group: "ぶゅりる" → streamer` / `reseed: corrected creator_group on 2 existing creator(s)` 確認
  - 続けて dev 起動 → reseed no-op(冪等性確認)
  - Python で post-state:`null_group: 0` / nijisanji=20 / streamer=20 で全 75 揃った
- 運用 Runbook(`docs/DATA_COLLECTION_OPS.md`):
  - 開始前チェックリスト(キー登録 / 配信者リスト / DB 診断結果 / バックアップ確認)
  - 開始手順(API 管理 → データ収集 → 有効化する)
  - 監視ポイント表(クォータ消費 / uploaders 増加 / creators 75 固定 / ERROR 件数 / Q3b NULL group)
  - トラブル対処(A. クォータ枯渇 / B. better-sqlite3 / C. creators 増加 / D. 配信者ヒットなし / E. 新規 0 / F. yt-dlp 失敗)
  - バックアップ / ロールバック手順
  - マイグレーション履歴
- 開放されている設計判断:
  - 自動 reseed の頻度(現状毎起動 = 高頻度すぎるかも、必要なら起動数回に 1 回に絞る)
  - 本物の運用ダッシュボード(現状はコンソール console.log + UI 数値のみ)
  - デバッグメニュー + diagnose.ts の最終撤去タイミング(Phase 2 着手 = 安定運用後)
- 影響: `seedCreators.ts`(reseedGroupsForExistingCreators + early-return 撤去)、`diagnose.ts`(Q3b + Q15-Q17)、`docs/DATA_COLLECTION_OPS.md`(新規)
- コミット: `cd30fda`(code)、後続で docs commit

## 2026-05-03 11:30 - データモデル根本修正: uploaders テーブル分離 + creators 純化(migration 001)

- 誰が: Claude Code
- 何を: 直前の DB 診断で「creators 325 件 = seed 75 + auto-add 切り抜き投稿者 250」と判明したのを受け、データモデルを 2 テーブル分離
- 新スキーマ:
  - `uploaders`(id / channel_id / channel_name UNIQUE / first_seen_at / video_count キャッシュ)
  - `videos.uploader_id`(FK to uploaders.id)
  - `creators` は純化(`is_target=1` のみ残す)
- 単一トランザクションで完結する migration 001:
  1. uploaders + indexes 作成 + videos.uploader_id 列追加
  2. videos.channel_name の DISTINCT を uploaders へ一括投入(各 name の最初の non-null channel_id を集約)
  3. is_target=0 creators で videos に出てこない孤児も uploaders へ移送(belt-and-braces)
  4. videos.uploader_id を channel_name JOIN で backfill
  5. videos.creator_id を NULL に(is_target=0 由来分のみ — broad-search hits は seed creator が不明のため)
  6. is_target=0 creators を DELETE
  7. uploaders.video_count を再集計
- 安全装置:
  - 冪等性 → `PRAGMA user_version` で管理(target=1)
  - 実行前に `PRAGMA wal_checkpoint(TRUNCATE)` で WAL flush → タイムスタンプ付き .bak ファイル自動作成
  - 既存行は移送のみで削除前に新テーブルへ書き込み(失敗時 transaction で全 rollback)
- 収集ロジック修正:
  - broad-search 由来の `upsertCreator(channelTitle, ...)` を撤廃
  - `_collectBatch` で各 video について `upsertUploader(channelId, channelName)` を呼んで uploader 登録
  - `creatorHint` ありの video のみ `getCreatorIdByName` で creator_id 解決(per-creator hint なら is_target=1 行を引く、なければ NULL)
- UI:`DataCollectionSettings` ステータスパネルに「切り抜きチャンネル」追加、「配信者」→「配信者(seed)」リネーム
- 開放されている設計判断:
  - uploader と creator のクロス参照(配信者本人投稿の切り抜き)
  - per-creator search のチャンネル ID 自動補完(seed creators の channel_id 利用度向上)
  - uploaders の手動編集 UI(現状は read-only data)
  - 既存 creators テーブルの NULL group 2 件の調査(2 人 nijisanji + streamer から削れた可能性、別タスク)
- 影響: `migrations.ts`(新規)、`database.ts`(`upsertUploader` / `bumpUploaderVideoCount` / `getCreatorIdByName` / VideoUpsert.uploader_id / getStats 拡張)、`index.ts`(_collectBatch refactor)、`main/index.ts`(runMigrations 起動時呼出)、`diagnose.ts`(Q10-Q14)、`types.ts`(uploaderCount)、`DataCollectionSettings.tsx`(UI)
- 実機検証 ✅(user の実 DB に対して):
  - user_version: 0 → 1
  - creators: 325 → 75(全て is_target=1)
  - uploaders: 0 → 252(channel_id 全件解決済み)
  - videos.uploader_id: 全 347 件紐付け成功
  - videos.creator_id: per-creator 由来 3 件のみ残存(broad は NULL)
  - バックアップ `data-collection.db.bak.20260502T123359` 自動生成 + ユーザの手動 backup `*.bak.20260502T212737` も別途確保
- コミット: `280ad6c`

## 2026-05-03 10:30 - 緊急: better-sqlite3 ネイティブモジュール読み込み失敗の真因確定 + 再発防止

- 誰が: Claude Code
- 何を: ユーザ収集ログ(`collection.log`)で「`Could not dynamically require "<root>/build/better_sqlite3.node" / @rollup/plugin-commonjs`」エラーが 7 件発生していたのを調査。**当該エラーは 2026-05-02 09:29Z〜10:11Z の時間帯に集中、それ以降は INFO のみで停止済み**(= 既に直っとる)。**transient なビルドキャッシュ破損** が真因と確定。再発防止に `electron.vite.config.ts` の `main.build.rollupOptions.external` に `better-sqlite3` と `bindings` を明示ピン
- 調査の流れ:
  1. **仮説 A(electron-rebuild 未実行)**:`npx @electron/rebuild -f -w better-sqlite3` 実行 → `✔ Rebuild Complete`、ただし `.node` ファイルの mtime は変わらず(prebuild キャッシュからコピー、binary 自体は既に Electron 33 ABI に向いてた)→ ABI mismatch ではない
  2. **仮説 B(externalize 未設定)**:`electron.vite.config.ts` は `externalizeDepsPlugin()` 設定済み、`out/main/index.js` を grep して `import Database from "better-sqlite3"` のみ残存(bundled されてない)→ externalize は機能してた
  3. **仮説 C(out/ ビルドキャッシュ問題)**:`out/` 削除 → `npm run build` 再生成 → 同じく externalize 状態正常
  4. **collection.log のタイムスタンプ確認**:エラー 7 件すべて `2026-05-02T09:29Z〜10:11Z` の間。それ以降の `[INFO] no heatmap available for ...` 大量ログ + `batch start / search broad → 50 items` で **以降は DB 書き込み成功**してることが確定 → 一時的な build cache 状態の問題
- 真因(推定):一時的に `bindings`(better-sqlite3 の transitive dep)が bundled された時間帯があり、その bundle に rollup-commonjs が runtime stub を埋めて throw していた。`externalizeDepsPlugin` は **package.json の direct deps だけ** externalize するため、transitive の `bindings` がバンドル対象になった瞬間がある(v8 dev mode の incremental rebuild のタイミング等)
- 再発防止:`electron.vite.config.ts` の `main.build.rollupOptions.external` に `better-sqlite3` と `bindings` を明示ピン(belt-and-braces)。これで `externalizeDepsPlugin` が何らかの理由で transitive を取りこぼしても、明示 external で守られる
- ⚠️ 「動画 347 件 / 配信者 325 件」表示は **エラー停止後の正常 batch run で蓄積されたデータ**。エラー時間帯のロスはあるがデータ自体は健在
- 影響: `electron.vite.config.ts`(rollupOptions.external 追加)
- 動作確認 ✅:`npm run build` 後 bundle に bindings 参照なし / runtime stub なし、`npm run dev` clean boot、creators.json 75 件 seed step 正常
- 次: 配信者 325 件問題の診断(別タスク `fca786a` で diagnose.ts 投入済み、ユーザが「デバッグ → DB 診断」を押せば実行)
- コミット: `5160da8`

## 2026-05-03 09:30 - データ収集制御ボタンの整理 + npm run dev 必須を CLAUDE.md に明文化

- 誰が: Claude Code
- 何を: データ収集 UI のボタン整理(「今すぐ実行」→「1 回だけ取得」リネーム、「取得を停止」ボタン新設、旧「一時停止 / 再開」ボタン廃止)+ Manager に `cancelCurrentBatch()` 追加 + `nextBatchAt` 追跡 + `isBatchActive` を IPC に公開。並行で CLAUDE.md の最上段に **npm run dev 必須 / npm run start 禁止** を強調記載 + `dev:fresh` script 追加
- 理由: 1) 「実行」より「取得」の方がデータ取得の意図が伝わる、2) 既存に「停止」相当ボタンが無く進行中バッチを途中で止める手段が無かった、3) Claude Code セッションが `npm run start`(preview コマンド)で古いビルドを掴む事故が複数回発生していたため再発防止
- ボタンの意味分離(3 軸):
  - 永続マスタースイッチ(再起動跨ぐ)→ 「有効化する / 無効化する」(既存、`dataCollectionEnabled` フラグ)
  - 1 回手動取得(off-cycle)→ 「1 回だけ取得」(旧「今すぐ実行」、`triggerNow` IPC)
  - 進行中バッチ停止(永続状態を変えずに)→ 「取得を停止」(NEW、`cancelCurrent` IPC)
- Manager の cancel セマンティクス:
  - `cancelCurrentBatch()` は state を `paused` に変えない。`cancelRequested = true` を立てるだけで、進行中バッチが次のチェックポイントで自然に exit
  - 次回スケジュール(`scheduleNext` の timer)は影響を受けない → 規定の 2h 後に通常通り再開
  - `runOneBatch()` 先頭で `cancelRequested = false` を再リセット(前回の cancel が次バッチに漏れない)、finally で「cancelled」ログ
- UI のステータス表示優先度刷新:バッチ進行中なら最優先で「🟢 取得中…」、それ以外は enabled / paused / idle / no-keys を 4 way に区別。`nextBatchAtSec` で「待機中(次まで N 分)」を可視化
- 起動コマンドの明文化:
  - CLAUDE.md 最上段(概要より上)に「⚠️ アプリ起動時の絶対ルール」セクション追加。✅ `npm run dev` / ✅ `npm run dev:fresh` / ❌ `npm run start` / ❌ ビルド成果物直接実行 を一覧表で明示。dev 起動成功の目印 + 古い electron プロセス掃除コマンド(PowerShell + bash 両方)+ 過去事例まで記載
  - `package.json` に `dev:fresh` 追加(`node -e` でクロスプラットフォームな `out/` 削除 → electron-vite dev -w、外部依存なし)
- 開放されている設計判断:
  - 停止時の進行中データの保存(現状はバッチ単位破棄、部分保存済みは残る)
  - 部分的キャンセル(配信者単位 / クエリ単位)
  - 「取得中」中の cancel 確認ダイアログをカスタムモーダルに(現状は window.confirm、CSS Modules 統一感のため後から検討)
- 影響: CLAUDE.md(冒頭警告 + dev:fresh 解説)、package.json(dev:fresh script)、`src/main/dataCollection/index.ts`(cancelCurrentBatch + nextBatchAt + isBatchActive)、`src/common/types.ts`(IPC 型拡張)、`src/main/index.ts`(IPC ハンドラ)、`src/preload/index.ts`(bridge)、`src/renderer/src/components/DataCollectionSettings.tsx`(UI 整理)
- 実機検証 ✅:`npm run dev:fresh` で port 3003 起動、creators 75 件のまま seed delta なし、新 UI ボタン配置確認
- コミット: `c54ba71`(docs claude.md)、`b95240b`(feat ボタン整理)

## 2026-05-03 08:30 - 配信者リスト 40 → 75 拡張(vspo + neoporte 追加 + 差分マージ + サイクル 1h → 2h)

- 誰が: Claude Code
- 何を: 直前 `16535eb` の 40 人を 75 人に拡張(にじ 15→20 / ホロ 10→15 / ぶいすぽ 0→15 新規 / ネオポルテ 0→5 新規(★ 柊ツルギ含む)/ ストリーマー 15→20)、`CreatorGroup` 型に `'vspo'` / `'neoporte'` 追加。`seedCreatorsIfEmpty` を `seedOrUpdateCreators`(差分マージ)に進化、サイクル間隔 1h → 2h
- 理由: ユーザ精査の最終リスト反映。40 → 75 拡張時に既存 creators.json を全置換すると解決済み channelId とユーザ手動編集が消える事故になるため、差分マージへ。クォータも 75 × 3 = 22.5K/サイクル + 周辺で ~23.75K → 1h 間隔だと 570K/日 > 500K 予算超過のため 2h(285K/日)で余裕を持たせる
- 差分マージのセマンティクス:
  1. 既存 creators.json をロード
  2. SEED_CREATORS のうち既存に同名がある → 触らない(channelId / 順序保持)。ただし既存 group が null なら seed の group を backfill(creators.json + DB 両方、DB は新規 `setCreatorGroupIfNull`)
  3. 既存に無い名前のみ append + DB `upsertCreator`
- 0-hit 警告:creator の全 3 クエリで 0 件なら `logWarn` で「表記揺れ / 脱退 / 改名の可能性」を collection.log に出力。group 名も付記して、流動的な箱(neoporte 等)で誤検出しやすいことを明示
- 開放されている設計判断:
  - ネオポルテメンバー名の最新検証(変動箱なので、データ収集後にユーザが log を見て手修正)
  - 配信者表記揺れの自動吸収
  - グループ別検索クエリのカスタマイズ(現状全 group 同じ 3 クエリ)
  - 1 時間 vs 2 時間以外のサイクル間隔(時間帯で変える、夜だけ多めに走らせる、等)
- 影響: src/main/dataCollection/seedCreators.ts(SEED_CREATORS 75 人 + seedOrUpdateCreators)、creatorList.ts(`CreatorGroup` 拡張)、database.ts(`setCreatorGroupIfNull` 追加)、index.ts(0-hit warn + COLLECTION_INTERVAL_MS 1h → 2h)、main/index.ts(関数名切替)
- 実機検証 ✅:既存 40 件 creators.json で起動 → 35 件追加 + group 保持(file 75 件、group 内訳 nijisanji 20 / hololive 15 / vspo 15 / neoporte 5 / streamer 20、null group 0 件)
- ⚠️ ネオポルテ 5 人は名前そのまま投入。最初のサイクルで 0-hit 警告が出る可能性あり、ユーザは API 管理 → 収集ログ タブで確認 + creators.json を手修正
- コミット: `cde28b0`

## 2026-05-03 07:30 - 配信者 40 人 seed 投入 + 検索クエリ多角化 + channelId 自動解決

- 誰が: Claude Code
- 何を: ユーザ精査の VTuber 25(にじさんじ 15 + ホロライブ 10)+ ストリーマー 15 = 40 人を `seedCreators.ts` に定数化、初回起動時に `creators.json` + DB の `creators` テーブルへ自動投入(冪等、空の時のみ発火)。各配信者に対して切り抜き / 神回 / 名場面の 3 クエリで検索。channelId は初回バッチで `search.list type=channel`(100u/人)で解決して永続化
- 理由: バックグラウンド蓄積の本格運用前段。検索網羅性を上げるため per-creator クエリを 1 → 3 へ多角化(YouTube アルゴリズムは同義句に対しても異なる動画を返す傾向)
- 変更:
  - `src/main/dataCollection/seedCreators.ts`(新規):`SEED_CREATORS` 40 人定数、`seedCreatorsIfEmpty`(空チェック → creators.json save + DB upsert)、`resolveCreatorChannelIds`(channelId 未解決のみ search.list で解決、結果を creators.json + DB へ persist)
  - `src/main/dataCollection/youtubeApi.ts`:`searchChannelByName(name)` 追加(type=channel 検索)
  - `src/main/dataCollection/database.ts`:`creators` に `creator_group TEXT` カラム追加(`'nijisanji' | 'hololive' | 'streamer' | null`)、`migrateSchema()` で `PRAGMA table_info` チェック後 `ALTER TABLE ADD COLUMN`(既存 DB に対して冪等)、`upsertCreator` に optional `group` 引数(INSERT 時のみ反映、UPDATE 時は既存 group 保持で random uploader が seed creator を上書きしない)
  - `src/main/dataCollection/creatorList.ts`:`CreatorEntry.group` 追加、load/save がフィールドを扱う、既存の `creators.add` は `group: null` で挿入(後方互換)
  - `src/main/dataCollection/searchQueries.ts`:`buildPerCreatorQuery` → `buildPerCreatorQueries`(3 クエリ返す)
  - `src/main/dataCollection/index.ts`:バッチ先頭で `resolveCreatorChannelIds()` 呼出(no-op fastpath 込)、creator × 3 クエリループ
  - `src/main/index.ts`:`app.whenReady()` 内で `seedCreatorsIfEmpty()` を `dataCollectionManager.start()` の前に呼ぶ
- 開放されている設計判断:
  - 配信者リストの動的取得 / ランキングからの自動追加
  - 配信者名の表記揺れ吸収(「葛葉」「KUZUHA」「kuzuha」等)
  - クエリパターン拡張(過去 N 日 / 再生数閾値 / order=date 追加 etc.)
  - グループ別(にじさんじ / ホロ / ストリーマー)集計 UI(現状はデータだけ持つ)
- クォータ見積もり: 検索 12K + broad 1.1K + enrich 0.15K = ~13.25K/サイクル、初回のみ +4K(channelId 解決)。50 キー × 10K/日 = 500K 日次予算で十分
- 影響: data-collection サブモジュール 5 ファイル + main/index.ts(seed wiring)。UI / IPC 不変。既存 install では migrateSchema が安全に動く
- ⚠️ 実機検証: ユーザが「有効化する」を押した後の最初のサイクルで multiple creators の動画が DB に入る、を確認
- コミット: `16535eb`

## 2026-05-03 06:30 - データ収集の自動開始を永続フラグで制御(デフォルト無効)

- 誰が: Claude Code
- 何を: `AppConfig` に `dataCollectionEnabled: boolean`(デフォルト `false`)を追加、起動時自動開始の条件に組み込み、UI に永続マスタートグル追加
- 理由: API キー保存周りが本番品質に到達したが、ユーザがこれから「どういう検索クエリで集めるか」戦略を詰めるフェーズに入る。クエリ未確定のまま自動収集が走ると無駄なクォータ消費が始まるため、**明示的な opt-in を要求**する設計に
- レイヤ整理:
  - `dataCollectionEnabled` = **永続マスタースイッチ**(再起動を跨ぐ、`config.json` に保存)
  - `isPaused` / `isRunning` = **セッション内のモード**(有効状態下での一時停止 / 稼働)
- IPC 追加:`dataCollection.isEnabled` / `setEnabled(boolean)`。`setEnabled(true)` は config 保存 + `start()`、`setEnabled(false)` は config 保存 + `pause()`(進行中バッチを即停止)
- UI:`DataCollectionSettings` のステータス行に「自動収集: 🔴 無効 / 🟢 有効」項目、メインボタンを「有効化する / 無効化する」(有効化時は確認ダイアログ)に。「今すぐ実行」は `isEnabled === false` で disabled。セッション内の一時停止 / 再開ボタンは有効状態下のみ表示
- 影響: src/common/config.ts(AppConfig 拡張)、src/common/types.ts(IpcApi 拡張)、src/main/config.ts(load/save 追加)、src/main/index.ts(起動分岐 + IPC ハンドラ)、src/preload/index.ts(bridge 追加)、src/renderer/src/components/DataCollectionSettings.tsx(UI 改修)
- 既存 install 向けにロード時 `false` フォールバック → アップグレード時も即収集が走らない安全な初期値
- コミット: `2dca5bd`

## 2026-05-03 05:30 - YouTube API キー保存バグ 真因特定 + 完治(3 周目)

- 誰が: Claude Code
- 何を: 2 度の修正(`5298725` の上限 50 化、`240dc50` の getKeys + useEffect seed)を経てもユーザ実機で「1 個しか登録できない」状態が続いていた問題を、**ログ駆動デバッグで真因確定 → UX モデル全面刷新**で完治
- 流れ:
  1. **デバッグコミット `e1811d5`**:`[YT-DEBUG]` / `[SS-DEBUG]` / `[IPC-DEBUG]` 接頭辞で全動線(render / useEffect / toggle / add-row / onChange / handleSave / IPC / secureStorage / read-back integrity check)に件数ログを仕込み。挙動は一切変えず push、ユーザに DevTools Console + ターミナル両方のログ採取を依頼
  2. **ユーザがログ提供** → `[YT-DEBUG] add-row button clicked` ログが **1 度も出てない**ことが確定。代わりに `input onChange index: 0 valueLength: 0` → `valueLength: 39` の遷移のみ → ユーザは「+ キーを追加」を押さず、**既存キーが masked 表示された 1 行目をそのまま全消し → 新キー貼り付け → 保存**していた
  3. 真因 = **`240dc50` で seed した既存キーが password input(masked dot 表示)に入るため、ユーザは「これは空欄だな」と認識して上書きしてしまう**。コードは設計通り動いていたが UX が破綻
  4. **修正コミット `b04f64d`**:UI モデル変更
- 修正後の構造:
  - **既存キー**:read-only chip(`AIza••••••••XYZ12` で先頭 6 + 末尾 4 だけ平文表示、中間は dot)+ × ボタンで削除マーク(再押下で取消)。input ではないので **物理的に編集不可**
  - **新規キー**:別セクションの input 行(初期 1 行、+ 新規行を追加で増やせる)
  - 保存時 = `(残った既存) + (新規 trim 非空)` を Set で dedupe → IPC `setKeys`
  - これで「既存を誤って消す」経路がコードレベルで除去される
- ログ駆動デバッグの教訓(memory に保存済):
  - 「コード読みで仮説選択」は失敗を 2 回繰り返した。3 周目で初めて **ログ仕込み(挙動変えず)→ ユーザ実機で採取 → 真因確定 → 修正** の 2 段階分離を実行
  - ユーザの最初の指示「ログ駆動でやってくれ」「defensive 修正 + 動いた気がします報告は NG」を最初から守るべきだった
- クリーンアップコミット `e43f275`:検証成功後、`[SS-DEBUG]` / `[IPC-DEBUG]` 系の verbose ログを撤去。`saveYoutubeApiKeys` の **read-back integrity check** だけは残置(成功時無音、ズレた時のみ console.warn)— 将来の暗号化 / 書き込みリグレッションを静かに監視する防御層
- 影響: src/renderer/src/components/ApiManagementView.{tsx,module.css}、src/main/secureStorage.ts、src/main/index.ts
- 実機検証: ✅ ユーザ確認済み(`b04f64d` 適用後、既存 1 個 → 新規追加 → 保存で 2 個に増えた)
- コミット: `e1811d5`(debug ログ仕込み)→ `b04f64d`(UX 修正)→ `e43f275`(ログ片付け)

## 2026-05-03 04:00 - YouTube API キー複数追加 UI バグ修正(load-on-edit-mode-entry)

- 誰が: Claude Code
- 何を: 直前 `5298725` で `MAX_YT_KEYS=50` に上限を上げたが、ユーザ実機では「1 個しか登録できない」状態。コード読みで真因 = **仮説 B(編集モード展開時に既存 keys を draft にコピーしてない)** と確定。修正:`youtubeApiKeys.getKeys()` IPC を新設(renderer に plaintext 配列を返す)+ `useEffect([editing])` で編集モード ON のたびに既存キーを draft に seed
- 真因の詳細:
  - `YoutubeKeysSection` の `draft` state は `useState<string[]>([''])` で初期化、編集モード再開時に **常に `['']` のままで既存 keys を読み込まない**
  - 1 個保存済み状態で編集モードを開くと **空欄 1 行のみ表示** → ユーザは「あれ、保存されてないのか?」と混乱して 1 個目に新キーを入力 → 保存
  - `handleSave` は draft 全体を `setKeys()` に投げて secureStorage 側で **完全置換** するセマンティクス → 既存 1 個が新 1 個に上書きされて、結果は **常に 1 個**
  - 「+ キーを追加」ボタンを押せば draft 行は増やせるが、その場合も既存 key は draft に存在しないので、save 時に消える
- 修正:
  - `youtubeApiKeys.getKeys()` IPC を新設、main 側は `secureStorage.loadYoutubeApiKeys()` を直返し
  - **renderer に plaintext key を返すのは Gladia / Anthropic と異なる方針**(あれらは renderer に戻さない)。深い理由は multi-key editor の UX に既存キー可視化が必要だから — 個別の key を replace / 追加するために、ユーザが「いま登録されてる N 個」を見れる必要がある。trade-off ドキュメント済み(types.ts コメント)
  - `useEffect([editing])` で編集モード ON 時に `getKeys()` を呼んで draft に seed。空なら `['']` で 1 行から開始
- ログ強化(diagnostic):
  - `[ApiManagement] YT edit toggle: false → true, current keyCount=N`
  - `[ApiManagement] edit mode opened, loaded N existing keys into draft`
  - `[ApiManagement] YT add row: N → N+1`
  - `[ApiManagement] saving N YouTube keys (draft rows: M)`
  - `[ApiManagement] save complete; getKeyCount=N`
  - これでバグレポート時に件数の流れが追える(キー値そのものは絶対ログに出さない)
- 開放されている設計判断:
  - getKeys() の plaintext 返却(Gladia / Anthropic も同様にするか、この区別を維持するか)
  - "save = replace" セマンティクスを "save = append" に変える(現状は replace、編集 UI で対応)
- 影響: src/common/types.ts(`youtubeApiKeys.getKeys` 追加 + UI 用途のコメント)、src/main/index.ts(IPC ハンドラ追加)、src/preload/index.ts、src/renderer/src/components/ApiManagementView.tsx(`useEffect([editing])` で seed + diagnostic logs)
- ⚠️ 実機検証はユーザ環境で必要(5 個保存 → 再起動 → 5 個復元、+ ボタンで行が増える)
- コミット: `240dc50`

## 2026-05-03 03:00 - API 管理画面 3 修正(キー上限 50 / 保存バグ修正 / 収集開始停止)

- 誰が: Claude Code
- 何を: 直前 `662be56` の API 管理画面に対する 3 修正:
  1. **YouTube API キー上限 10 → 50**(`MAX_YT_KEYS = 50`)
  2. **「30 個保存しても全部表示されない」バグの真因特定 + 修正**:UI 側「+ キーを追加」ボタンの disabled 条件が `draft.length >= MAX_YT_KEYS`(=10)で **編集行を 10 行までしか追加できなかった**。secureStorage / IPC / DPAPI 側に容量問題はなく、純粋に UI 入力の上限。`MAX_YT_KEYS` を 50 にする 1 行で完治
  3. **データ収集の開始 / 停止ボタン**:DataCollectionManager の `state` を UI に 3-way で公開(running / paused / idle)、ボタンが「停止」「再開」「開始」を文脈で切り替え
- 検証: `grep` で `MAX_YT_KEYS` の参照を全洗い出して、disabled 条件 + 表示メッセージの 2 箇所が同じ定数を読む構造であることを確認。secureStorage 側は念のため diagnostic log(件数 / JSON 長 / 書き込みバイト数)+ defensive cap(`YT_KEYS_JSON_MAX_BYTES = 100000`、~1500 キー相当)+ Set による dedupe を追加
- 副次:
  - **secureStorage diagnostic logs**:`saveYoutubeApiKeys` / `loadYoutubeApiKeys` で count / JSON 長 / 書き込みバイト数を console に出力(キー値そのものは絶対ログに出さない)。これで「30 個入れたつもりが N 個しか保存されてない」みたいな差異があったら一発で特定可能
  - **handleSave 側にも対応するログ**:`[ApiManagement] saving N YouTube keys (draft rows: M)` + `getKeyCount=` をリロードで確認して整合性検証
  - **per-key クォータバー / multi-key editor 双方を `max-height + overflow-y: auto`** で 50 行レンダリング時の UI 崩れ防止。Save / Add ボタンは scroll 領域の外に出して常に見える位置
- 理由: ユーザは YouTube API キーを 30 個保有しているが、UI 入力の 10 行制限で実際には 10 個しか入らなかった。報告は「30 個保存したのに全部表示されない」だったが、実態は「30 個入れる手段が無かった」。spec の「勘で直さず実機ログで真因確定」を踏襲してログ仕込みも入れたが、コード読み だけで真因(`MAX_YT_KEYS = 10` の disabled 条件)が確定したので合わせて修正
- 開放されている設計判断:
  - キー個別の API 検証(50 個に 50 回 API 叩くの重い、現状は実行時に 401/403 で個別 disable する既存仕様維持)
  - キーのインポート / エクスポート機能
  - 詳細なスケジュール設定(現状 1 時間固定)
- 影響: src/main/secureStorage.ts(diagnostic log + dedupe + 100KB cap)、src/main/dataCollection/index.ts(`getStatsSnapshot` に `isPaused` 追加)、src/common/types.ts(`isPaused` 追加)、src/renderer/src/components/ApiManagementView.{tsx,module.css}(`MAX_YT_KEYS` 50 + handleSave log + per-key 行数表示 + scrollable 行コンテナ)、src/renderer/src/components/DataCollectionSettings.tsx(3-way ステータス表示 + 停止/再開/開始 ボタン)
- ⚠️ 実機検証はユーザ環境で必要(50 キー入力 + 保存 + 再起動で全件復元 / 開始停止ボタン動作)
- コミット: `5298725`

## 2026-05-03 02:00 - API 管理画面をモーダルから全画面フェーズに変更

- 誰が: Claude Code
- 何を: 直前(`ead5db5`)で実装した `ApiManagementDialog`(モーダル)を `ApiManagementView`(全画面ビュー)に置換。`editorStore.phase` に `'api-management'` 値を追加、`previousPhase: RestorablePhase | null` で戻り先を保持、`openApiManagement()` / `closeApiManagement()` 2 アクションで遷移。`App.tsx` は `phase === 'api-management'` のとき early return で完全別画面を return(他フェーズの header / banner も含めて非表示)
  - **戻る動線**: ヘッダ左の「← 戻る」ボタン + Esc キー(input/textarea にフォーカスがある時は無視)
  - **load / clip-select / edit のいずれからでも遷移可能**、戻りはそれぞれ元の phase に復帰。`previousPhase` 保持なので clipSegments / 動画ファイル / 編集状態は維持される(setFile/clearFile が走らない限り消えない)
  - **モーダル時のロジックは全部移植**: タブ切替(API キー / 収集ログ)、Gladia / Anthropic 単一キーの inline 編集モード + 削除 confirm、YouTube multi-key editor、per-key クォータバー(5 秒 polling)、CollectionLogViewer 埋め込み
  - **CSS は別新規ファイル**(`ApiManagementView.module.css`):`<dialog>` の固定サイズ制約を解除、`height: 100vh` + flex column + 内側 `max-width: 1200px` で間延び防止。CollectionLogViewer は parent flex:1/min-height:0 のチェーンで画面高さに追従(虚スクロールが正しい containerHeight を取る)
  - SettingsDialog の「API 管理画面を開く」ボタンも同じ store アクション経由に変更(旧 `setApiMgmtOpen` 廃止)
- 理由: モーダル形式は背景透過 + 小ダイアログで「別画面に切り替わる」感が薄く、ユーザの意図(全画面 swap)に合っとらんかった。既存 3 フェーズと同じパターン(load / clip-select / edit / **api-management**)に統一して認知負荷を減らす + データ蓄積期のログ確認画面として「広い画面いっぱい使える」価値も
- 開放されている設計判断:
  - api-management 時の Settings ダイアログ(現状はマウントされたまま、phase swap で見えなくなる)— 状態クリアが要るなら明示 close
  - 戻りアニメーション(現状はインスタント切替)
- 影響: editorStore.ts(phase + previousPhase + 2 アクション)、App.tsx(early return + 旧 setApiMgmtOpen 削除 + 新 onMenuOpenApiManagement ハンドラ)、ApiManagementView.{tsx,module.css}(新規)、ApiManagementDialog.{tsx,module.css}(削除)
- ⚠️ 実機検証はユーザ環境で必要(全フェーズからの遷移 / Esc / 戻るボタン / データ保持)
- コミット: `662be56`

## 2026-05-03 01:00 - 「API 管理」専用画面の新設(全 API キー統合 + ログビューア)

- 誰が: Claude Code
- 何を: トップメニューに「API 管理」+ `Ctrl+Shift+A` 追加。専用ダイアログ `ApiManagementDialog.tsx` を新設し、Gladia + Anthropic + YouTube(複数)の API キーを **タブ式で統合管理**。同ダイアログの 2 つ目のタブとして `CollectionLogViewer.tsx` を新設、データ収集ログを GUI 上で時系列表示・レベル別フィルタ・エラー赤色強調・5 秒間隔自動更新できる
  - `src/main/dataCollection/logger.ts`(新規):`logInfo` / `logWarn` / `logError` を ISO 8601 `[LEVEL] message` 形式で `userData/data-collection/collection.log` に append、コンソールにもエコー。append は単一 promise chain で sequenced(Windows での torn line 防止)
  - `src/main/dataCollection/logReader.ts`(新規):末尾 N 行読み出し + 正規表現パース。canonical フォーマット以外の legacy line は INFO で吸収
  - `database.ts` に `getQuotaPerKeyToday()` 追加(API 管理 UI のキー別バー表示用)
  - 既存の `console.log/warn` を 6 ファイル分すべて `logger` 経由にリファクタ(`dataCollection/index.ts` / `youtubeApi.ts` / `ytDlpExtractor.ts`)
  - `menu.ts`:トップレベル「API 管理」項目(submenu なし、accelerator `CmdOrCtrl+Shift+A`)
  - IPC:`collectionLog.{read, openInExplorer, getQuotaPerKey}` + `onMenuOpenApiManagement`
  - `ApiManagementDialog.tsx`:タブ式(API キー / 収集ログ)、各 API は **Edit ボタンで inline 展開**(モーダル on モーダル避ける)、削除は `window.confirm` で誤操作防止、YouTube は per-key クォータバー(5 秒 polling)
  - `CollectionLogViewer.tsx`:虚スクロール(ROW_HEIGHT 26 / BUFFER_ROWS 12)、All / INFO / WARN / ERROR フィルタ + 件数バッジ、自動更新トグル、stick-to-bottom(20px 以内なら追従、上にスクロールしたら止まる)、`shell.openPath` でファイルを OS エディタで開く
  - `SettingsDialog.tsx` を簡素化:Gladia / Anthropic キー入力を完全削除、`DataCollectionSettings` の YouTube キー部分も削除(ApiManagementDialog に移植)。代わりに「API 管理画面を開く」ハンドオフボタン
  - `DataCollectionSettings.tsx` は配信者リスト + ステータスパネル + 手動トリガーのみに整理
  - `App.tsx`:`ApiManagementDialog` を新規 render、`onMenuOpenApiManagement` listener、`SettingsDialog` の props 簡素化(`onOpenApiManagement` 1 つのコールバックに集約)
- 理由: API キー数が増えて Settings の中に埋もれてた + データ収集ログを毎回エディタで開くのが面倒。専用画面に集約 + アプリ内で完結する動線。配信を 1 週間放置して蓄積する前段階として、ログを GUI で追える状態に
- 開放されている設計判断:
  - ログのリアルタイム push(現状 5 秒 polling)
  - ログのエクスポート機能(CSV / JSON)
  - ログローテーション(現状は append-only、長期で 100MB 超想定)
  - 自動キーローテーション以上の高度なキー管理
  - 単一キー編集を別モーダルで開く案(現状は inline 展開、画面遷移は減らす方向)
- 影響: src/main/menu.ts(トップレベル項目追加)、src/main/dataCollection/{logger.ts, logReader.ts}(新規)、src/main/dataCollection/{index.ts, youtubeApi.ts, ytDlpExtractor.ts, database.ts}(リファクタ)、src/main/index.ts(IPC + import)、src/preload/index.ts、src/common/types.ts、src/renderer/src/components/{ApiManagementDialog,CollectionLogViewer,SettingsDialog,DataCollectionSettings}.{tsx,module.css}、src/renderer/src/App.tsx
- ⚠️ 実機検証はユーザ環境で必要(メニュー出現確認 / API キー登録 / ログビューアの実データ表示 / ファイルを開くボタン)
- コミット: `ead5db5`

## 2026-05-02 23:30 - 切り抜き動画データ収集パイプライン Phase 1(蓄積基盤)

- 誰が: Claude Code
- 何を: バックグラウンド SQLite 蓄積パイプライン。YouTube Data API(キー最大 10 個ローテーション)+ yt-dlp で「実際に伸びとる切り抜き動画」のメタデータ・サムネ・heatmap 上位 3 ピーク・chapters を蓄積する基盤。Phase 2(分析)/ Phase 3(自動抽出統合)への入力データ生成役
- 構成:
  - **`src/main/dataCollection/database.ts`**(`better-sqlite3` ベース、WAL モード)— `creators` / `videos` / `heatmap_peaks` / `chapters` / `api_quota_log` の 5 テーブル。全 upsert はトランザクション、video 削除時の cascade で peaks/chapters も整合性維持。スキーマは起動時に自動作成
  - **`src/main/secureStorage.ts` 拡張** — `youtubeApiKeys.bin`(JSON 配列を 1 ファイルに DPAPI 暗号化保存)に `saveYoutubeApiKeys` / `loadYoutubeApiKeys` / `clearYoutubeApiKeys` / `hasYoutubeApiKeys` / `countYoutubeApiKeys` を追加。renderer には件数だけ返す(生キーは戻さない)
  - **`src/main/dataCollection/youtubeApi.ts`** — `searchVideos` + `fetchVideoDetails`。`ApiKeyRotator` クラスでクォータ消費を `api_quota_log` に記録しつつラウンドロビン、daily 10K unit 超えたキーは翌日まで mute。403/401 を返したキーは即時 dailyDisabled、5xx/network 系はリトライしない(次バッチで自然回復)。コスト定数:`search.list=100`, `videos.list=1`, `channels.list=1`
  - **`src/main/dataCollection/ytDlpExtractor.ts`** — `--print` で `id/title/channel/channel_id/view_count/like_count/comment_count/duration/upload_date/description/heatmap/chapters` を 1 行 JSON 出力。`pickTopPeaks(heatmap, chapters, 30s spacing)` で value 降順 + 30 秒以内 dedup → 上位 3 個、各ピークの centre 時刻が含まれるチャプターの title を紐付け。`--write-thumbnail --convert-thumbnails jpg` でサムネを `userData/data-collection/thumbnails/<id>.jpg` に保存
  - **`src/main/dataCollection/searchQueries.ts`** — 11 個のブロード検索クエリ(切り抜き / クリップ / 神回 / VTuber / にじさんじ / ホロライブ / マイクラ / APEX 等)、`buildPerCreatorQuery(name)` で「<人物名> 切り抜き」を生成
  - **`src/main/dataCollection/creatorList.ts`** — `userData/data-collection/creators.json` の JSON CRUD。Settings UI からの編集 + 手動編集どちらも可能
  - **`src/main/dataCollection/index.ts`** — `DataCollectionManager` シングルトン。`start()` は no-key なら no-op、API キーありなら 5 秒後に最初のバッチ → 1 時間ごとに自動継続。バッチ内では:per-creator 検索 → broad 検索 → 既存 DB と突き合わせて新規 ID のみ抽出 → `videos.list` で stats 取得 → 各動画 yt-dlp で heatmap/chapters/thumbnail 取得 → DB upsert。MAX 200 動画/バッチ、200 ms 間隔で yt-dlp に優しく
  - **IPC**:`dataCollection.{getStats, triggerNow, pause, resume}` + `youtubeApiKeys.{hasKeys, getKeyCount, setKeys, clear}` + `creators.{list, add, remove}`
  - **Settings UI**:`DataCollectionSettings.tsx`(新規)を `SettingsDialog` の 3 つ目のセクションとして埋め込み。ステータスパネル(動画数 / 配信者数 / 本日のクォータ / 状態 / 最終収集)+ API キー multi-input(最大 10、各 password 入力)+ 配信者リスト(タグ風 chip + Enter で追加 + ✕ で削除)。5 秒間隔で stats を polling
  - **`app.whenReady()`** に `void dataCollectionManager.start()` を追加。キー未設定時はログ 1 行で静かに skip
- 検証: better-sqlite3 を `npx electron-rebuild` で Electron 33 ABI(NODE_MODULE_VERSION 130)に rebuild、`yt-dlp --print %(heatmap)j %(chapters)j` の出力形式を実 URL(Rick Roll の 100 ポイント heatmap)で確認、型チェック + build clean。実 API 呼び出しはサンドボックスから検証不可(API キー未保有)
- 理由: 「YouTube で実際に伸びとる切り抜き」のパターンを学習データとして蓄積し、将来 Phase 2(分析)+ Phase 3(自動抽出統合)で配信者ごとの伸びパターンを反映した抽出をするため。今回はデータ蓄積基盤のみ。1 週間放置で 1 万件規模の蓄積を想定
- 開放されている設計判断:
  - サムネ画像解析(Phase 2)
  - タイトルパターン分析(Phase 2)
  - 自動抽出機能との統合(Phase 3)
  - 配信者の自動グルーピング(現状手動リスト)
  - 伸び率計算(view_count / 経過日数)
  - 既存動画の view_count 再取得ループ(週次)— 現状は collected_at 上書きするだけで履歴なし
- 影響: src/main/dataCollection/* (新規 6 ファイル)、src/main/secureStorage.ts (YouTube キー BYOK 追加)、src/main/index.ts (IPC + auto-start)、src/preload/index.ts、src/common/types.ts (IpcApi 拡張)、src/renderer/src/components/{SettingsDialog,DataCollectionSettings}.tsx、package.json (better-sqlite3 + @types)
- ⚠️ 実機検証はユーザ環境で必要(API キー登録 → 1 時間放置 → DB に件数蓄積されとるか確認)
- コミット: `799eb3d`(本体)+ `c3ab9c5`(試作 URL 変更:O5gI5cIM4Yc に固定、本タスクと並行のユーザ要望)

## 2026-05-02 22:30 - 切り抜き候補の自動抽出(ハイブリッド方式 + 1 ボタン全自動)

- 誰が: Claude Code
- 何を: 「波形見ても切り抜きどこか分からん」というユーザ要望に対し、**ボタン 1 つで Stage 1(アルゴリズム検出)→ Stage 2(AI 精査)→ Stage 4(タイトル生成)** を一気通貫に実行する機能を追加
  - **`src/main/commentAnalysis/peakDetection.ts`(新規)**:rolling-score をすべての window-start 位置で計算 → ローカル極大値検出(±W/2 以内で最大) → score≥0.30 + 動画両端 30 秒バッファでフィルタ → スコア降順で greedy non-overlap(隣接候補は最低 W 離す) → 上位 10 個を返す。スコア計算ロジックは renderer の `rollingScore.ts` と同一(意図的な duplicate、weights が drift したら両方更新)
  - **`src/main/aiSummary.ts` の拡張**:
    - `callAnthropicRaw()` を内部関数として切り出し(既存の `callAnthropic` は薄いラッパに)。raw text を返すので JSON 応答もパース可能
    - `refineCandidatesWithAI(videoKey, candidates, targetCount)`:Stage 2。候補 10 個をプロンプトに含めて Claude Haiku 4.5 に投げ、起承転結 / ネタバレ性 / 反応質を基準にベスト N 個を JSON で返させる。各候補のコメントは **per-author dedup(2件まで)→ 30 件まで均等サンプリング** で前処理。出力は startSec/endSec の ±0.1秒一致でバリデート、フォールバックは「スコア降順上位 N」。キャッシュは `userData/comment-analysis/<videoKey>-extractions.json`(キー = `t${targetCount}-${start}-${end}-${msglen}|...`)
    - `autoExtractClipCandidates(args, onProgress)`:オーケストレータ。Stage 1 → Stage 2 → Stage 4(`generateSegmentTitles` 流用)を順次。各 phase の進捗を `{phase: 'detect'|'refine'|'titles', percent}` で renderer に push
  - **IPC**:`aiSummary.autoExtract` + `onAutoExtractProgress` を追加(`aiSummary.generate` の進捗チャネルとは別、cross-talk 防止)
  - **`ClipSelectView` ヘッダ**:「✨ 自動で切り抜き候補を抽出」ボタン + 件数 select(3/4/5、デフォルト 3)。disabled 条件は `!hasAnthropicApiKey` / `analysisState !== 'ready'` / `clipSegments.length >= 5`
  - **進捗ダイアログ**:モーダル overlay(z-index: 1000)で 3 step バー + 現在 phase ラベル + キャンセルボタン(`aiSummary.cancel()`)。`autoState` と既存の `aiState` を分離
  - **既存の「AI でタイトル生成」ボタン(ClipSegmentsList)は温存**:手動で区間追加した後にタイトルだけ AI に頼む用途で残す価値あり
- 検証: サンドボックスで合成データ(1 時間動画 / 5 個の gaussian peak / 1 つはエッジ端)で smoke test。5 つの peak のうち エッジ端は 30 秒バッファで filter、残り 4 個が score 順にピックされることを確認(±5-10s で synthetic centre と一致)
- 理由: アルゴリズムだけだと「数値の山」止まりで物語性を判定できないので AI 精査と組み合わせ。1 ボタン全自動でユーザの「ここどう?」要望に直結。Stage 2 のキャッシュで 2 回目は API なしで即返り
- 開放されている設計判断:
  - Sonnet/Opus への切り替え UI(コスト見て判断)
  - ユーザカスタムプロンプト
  - 連続実行時の差分追加(現状はクリアしてから実行前提)
  - 抽出区間数の上限拡張(現状 5)
  - Stage 1 と renderer rollingScore の二重実装解消(common/ 配下に共通化)
- 影響: src/common/types.ts(`AutoExtractStartArgs/Progress/Result` 追加 + IpcApi 拡張)、src/main/commentAnalysis/peakDetection.ts(新規)、src/main/aiSummary.ts(`callAnthropicRaw` + `refineCandidatesWithAI` + `autoExtractClipCandidates`)、src/main/index.ts(IPC ハンドラ)、src/preload/index.ts(`aiSummary.autoExtract` + `onAutoExtractProgress`)、src/renderer/src/components/ClipSelectView.{tsx,module.css}(ヘッダボタン + count select + 進捗 modal)
- ⚠️ 実機検証はユーザ側で必要(Anthropic API キー保存 → 実 DL 動画でボタン押下 → 抽出結果の質を主観評価)
- コミット: `a0af61a`(本体)+ `441ed04`(直後修正:波形ホバーラインの cursor 追従)

## 2026-05-02 21:30 - 動画音声不再生バグの **真の** 根本原因を特定・修正(audio fragment 不完全 DL → silent 切断)

- 誰が: Claude Code
- 何を: 既存の `6.mp4` を `ffprobe` で実調査した結果、4cca71f で立てた仮説 A/B(format selector / Opus codec)は **的外れ** だったことが判明。**真の root cause は yt-dlp のデフォルト挙動 `--skip-unavailable-fragments`** で、audio fragment の一部 DL 失敗時に **silently skip して merger に partial audio を渡し**、結果として動画 158.6 分 vs 音声 16.1 分の duration mismatch ファイルが生成されていた
- ffprobe 実測値(`6.mp4`):
  ```
  stream 0: video h264/avc1, duration=9516.00s (158.6 分)
  stream 1: audio aac/mp4a,  duration=963.99s  ( 16.1 分)
  ```
  ユーザが「音声出ない」と感じたのは、テスト時の playhead が 16 分以降にあった(or 終盤付近)せい。最初の 16 分は正常に再生されるはずだが、長尺動画の後ろで silence になっていた
- 修正:
  - **`--abort-on-unavailable-fragment`**: fragment の一つでも DL 失敗したら **silently skip ではなく hard error** として exit。partial audio が merger に渡らないように
  - **`--retries 30 --fragment-retries 30`**: ネットワーク glitch に対して粘る。デフォルト 10 → 30 に
  - **post-DL ffprobe validation**: yt-dlp が exit 0 で終わっても、出力ファイルを `ffprobe -of json` で読んで video / audio duration を比較。差が ±5 秒を超えたら hard error として renderer に投げる(belt-and-braces second line of defence)。`!hasAudio` も同様に reject
  - 4cca71f で入れた format selector 5 段化 + AAC merger postprocessor + audioTracks defensive enable は **そのまま温存**(Opus-in-MP4 ケースの defense in depth として無害)
- 判明した経緯: ユーザが Step 3(`ffprobe`)を私に実行依頼 → サンドボックスから `$APPDATA/jikkyou-cut/Downloads/jikkyou-cut/6.mp4` に到達 → ffprobe で duration mismatch を実測値で発見。4cca71f は **Opus codec という存在しない問題** を直そうとしていた。実機検証(or それに準ずる実測)を経ずに修正をマージしたのが反省点
- **既存 DL ファイルへの注意**: 引き続き再 DL 必須。本修正後の DL であれば、partial DL の場合は alert dialog で報告される(silently truncate しなくなる)
- 開放されている設計判断:
  - PROBE_DURATION_TOLERANCE_SEC = 5 秒のしきい値(短すぎる動画では狭すぎるかも)
  - ffprobe 失敗時の挙動(現状: warn + skip validation で DL 成功扱い)
- 影響: src/main/urlDownload.ts(`--abort-on-unavailable-fragment` + retries 30 + `probeDurations()` + post-DL validation)
- コミット: `e3a60ad`

## 2026-05-02 20:30 - 動画音声不再生バグの根本修正(yt-dlp 出力での音声強制 AAC 化 + audioTracks defensive enable)

- 誰が: Claude Code
- 何を:
  - **`urlDownload.ts` の format selector を 3 段 → 5 段に拡張**: 旧 `avc1+m4a / best-mp4 / anything` の `/anything` 分岐に流れた動画は Opus-in-MP4 になりがちで、Chromium の `<video>` が **video は再生するが audio を silently drop** していた。新 selector は `avc1+m4a` → `avc1+anything` → `anything+anything` → `best-mp4` → `best` の順に降りていき、最初の 3 段のいずれかにヒットすれば後続の merger が必ず動く
  - **`--postprocessor-args 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart'`**: merger が走る経路では音声を **無条件で AAC 192kbps に再エンコード**(視覚上の品質劣化はゼロ、AAC↔AAC の場合も remux→transcode 1 回で十分軽量)。`+faststart` で moov atom を頭に移し、media:// Range 経由の seek も先頭から効くように
  - **`--print before_dl:JCUT_FMT vfmt=... vcodec=... acodec=... ext=...`**: yt-dlp が実際に選んだフォーマット ID を起動時に stdout へ。`acodec=none` が出たら format selector が video-only に落ちた証拠
  - **`VideoPlayer.tsx`** の `onLoadedMetadata` で `v.audioTracks[*].enabled = true` を全 track に適用(ブラウザが alternate-language を default disable する稀なケース対策)
  - **`onLoadedMetadata` + `onCanPlay`** で `webkitAudioDecodedByteCount` / `audioTracks.length` を console に dump。「decode 0 のまま」なら codec 問題、「>0 だが無音」なら出力デバイス問題、と切り分けできる diagnostic
- 理由: `b8eb4b6` で `muted=false` / `volume=0→1` の defensive reset を入れたが直らず、複数の hypothesis を並列に潰した:
  - **本命(仮説 A+B)**: yt-dlp の出力 mp4 に Opus 音声が入っていた可能性。AVC1 + Opus-in-MP4 は Chromium で「video plays, audio mute」になる既知挙動。merger で AAC 強制再エンコしておけば確実に再生可能になる
  - 仮説 C(media:// Range)は mediaProtocol コードを再監査して問題なしと確認、修正対象外
  - 仮説 D(既存 DL ファイルが古い)は事実上必ず該当する。新規 DL のみ修正対象
- **既存 DL ファイルへの注意**: `b8eb4b6` 以前 / この修正以前にダウンロード済みのファイルは音声強制 AAC を経ていない。**再 DL 必須**
- 開放されている設計判断:
  - audioTracks API は HTMLVideoElement の experimental field、Electron 33 (Chromium 130 系) では動くが将来削除のリスクあり。type assertion で扱っているのはそのため
  - 192 kbps の AAC は固定値。設定 UI で品質選択を出してもよい(将来検討)
  - 仮説 C (mediaProtocol) は無実証で「触らない」判断。もし新規 DL でも再現したらここを再検討
- 影響: src/main/urlDownload.ts (format selector + postprocessor + 診断 print)、src/renderer/src/components/VideoPlayer.tsx (audioTracks enable + canplay/loadedmetadata diagnostic logs)
- ⚠️ 実機検証はユーザ環境で必要(私のサンドボックスから ffprobe / DevTools へアクセス不可)
- コミット: `4cca71f`

## 2026-05-02 19:30 - LiveCommentFeed の行密度を再調整(40 → 32 px)

- 誰が: Claude Code
- 何を: `ROW_HEIGHT` 40 → 32、`BUFFER_ROWS` 8 → 10、`.row` の padding 6/12 → 3/10、font-size 13 → 12、line-height 1.4 → 1.3、gap 10 → 8、時刻列 48 → 44 px(font-size 11 px 維持、`width: 44px` 追加で `H:MM:SS` 文字列でも崩れないように pin)
- 理由: Part A で 60 → 40 に下げたが、配信動画(数千件のチャット)を実機で見るとまだ 9 行程度しか入らずスカスカ感。1 画面 ~15 行(約 1.5-2 倍密度)に再調整
- 影響: src/renderer/src/components/LiveCommentFeed.{tsx,module.css}
- コミット: `7538df0`

## 2026-05-02 19:00 - AI タイトル要約(Anthropic Claude Haiku 統合)Phase 2

- 誰が: Claude Code
- 何を:
  - **Anthropic API キー BYOK**: `secureStorage.ts` を Gladia / Anthropic の 2 スロット化(`apiKey.bin` / `anthropicKey.bin`、independently rotatable)。`hasAnthropicSecret` / `saveAnthropicSecret` / `loadAnthropicSecret` / `deleteAnthropicSecret` を追加
  - **`aiSummary.ts`(新規)**: Claude Haiku 4.5(`claude-haiku-4-5`)で各 `ClipSegment` のキャッチータイトルを生成。3 並列 + 429/5xx で 3 回まで 2/4/6 秒バックオフ + per-request 30 秒タイムアウト + AbortController で `cancelAll()`。プロンプトは「15 文字以内のキャッチータイトル」「ネタバレ歓迎」「カギカッコ・絵文字なし」。コメント数 80 件超は均等サンプリング。出力は `cleanTitle()` で「タイトル:」echo・引用符・句点を strip
  - **キャッシュ**: `userData/comment-analysis/<videoKey>-summaries.json`、key は `${startSec}-${endSec}-${messages.length}`(2 桁丸めで sub-frame ドリフト吸収)。同じ境界 2 回目は API 呼ばずに即返す
  - **検証エンドポイント**: `validateAnthropicKey(key)` で 1-token ping(`max_tokens: 5, "Hi"`)。401/403 は明示的にローカライズ、429 は「キー自体は有効な可能性」の注釈付きエラー
  - **Settings UI 拡張**: `SettingsDialog` を Gladia / Anthropic の 2 セクション分け、各セクション独立の 入力 + 保存(検証込み) + 削除 + 状態フィードバック(設定済みバッジ / エラー表示 / 保存成功表示)
  - **ClipSegmentsList の「AI でタイトル生成」ボタン**: 全削除ボタンの隣に新設、Sparkles アイコン。実行中は `生成中… 3/12` の進捗ラベル表示。キー未設定時は disabled + tooltip 案内。エラー時は inline メッセージ
  - **タイトル反映**: `aiSummary.generate` の結果を 1 件ずつ `updateClipSegment(id, { title })` で store に書き込み、即時 UI 反映
- 理由: 切り抜き編集で「区間タイトル付け」は AI に任せた方が速い + ネタバレ的キャッチコピーが切り抜き文化に合う。Haiku は安価(1 動画 30 区間で数円)で品質十分。BYOK で OPS コストはユーザ持ち、`safeStorage` (Windows DPAPI) で暗号化保存、renderer に生キー戻さない
- 開放されている設計判断:
  - 区間追加時の自動生成(現状はボタン押下時のみ)
  - 個別区間の再生成ボタン(区間カード内に再生成アイコン)
  - プロンプトテンプレートのユーザカスタマイズ
  - モデル選択(Sonnet 4.6 / Opus 4.7、現状は Haiku 固定)
  - エラーの per-segment 表示(現状は first-error の global 表示のみ)
- 影響: src/main/secureStorage.ts (2 スロット化)、src/main/aiSummary.ts(新規)、src/main/index.ts (`anthropicApiKey:*` + `aiSummary:*` IPC)、src/preload/index.ts (`hasAnthropicApiKey` 等 + `aiSummary` namespace)、src/common/types.ts (`AiSummary*` 型 + `IpcApi` 拡張)、src/renderer/src/hooks/useSettings.ts (Anthropic accessors)、src/renderer/src/components/SettingsDialog.tsx (2 セクション)、src/renderer/src/components/ClipSegmentsList.{tsx,module.css}(AI ボタン + 進捗)、src/renderer/src/components/ClipSelectView.tsx(オーケストレータ + segments→messages slicing)、src/renderer/src/App.tsx(props 経由)
- コミット: `493192d`

## 2026-05-02 18:30 - ClipSelectView 操作感改善(左クリック即時シーク + ホバー圧縮 + コメント行コンパクト化 + 区間バー右クリックメニュー)

- 誰が: Claude Code
- 何を:
  - **A-1 左クリック即時シーク**: 旧「mousedown → 5px 移動チェック → mouseup でクリック判定 → 発火」の 4 段ゲートを廃止。`mousedown` 時点で **即座に 1 回シーク** + 続く `mousemove` でライブシーク追従。RAF coalesce(`scheduleSeek`)で 60+fps 連続発火を抑制。閾値 5→3 px、`segment-pending` / `right-pending` の 2 種にだけ移動閾値を残す
  - **A-2 ホバーツールチップ圧縮**: 4 行(時刻 / スコア / カテゴリ内訳 / コメント数)を **1 行**(`2:05:20 · スコア 48 · 86コメ`)に。font-size 11px、padding 4/8、半透明黒背景、カーソルから 12/12 px オフセット、150 ms 遅延でホバーフリッカー抑制、画面右端で flip
  - **A-3 LiveCommentFeed コンパクト化**: `ROW_HEIGHT` 60 → 40 px、ユーザ名列削除(時刻 + 本文の 2 列)、行内 1 行 ellipsis、`BUFFER_ROWS` 6→8。author データは `ChatMessage.author` に残るが UI ではレンダリングしない(将来用に保持)
  - **A-4 区間バー右クリックメニュー**: `SegmentContextMenu.{tsx,module.css}`(新規、`position: fixed`)で「タイトル編集」「この区間を削除」を提示。`onSegmentContextMenu` props で graph → ClipSelectView へ伝搬。「タイトル編集」は `editTitleRequestId` 経由で ClipSegmentsList の inline 編集モードを発火 + `scrollIntoView({ block: 'center' })`。メニュー外クリック / Esc でクローズ
- 理由: baef8ad 後の実機検証で「シーク反応遅い・ホバー邪魔・コメント幅でかい」報告。クリック即時性は移動閾値ゲートを完全撤廃、ホバーは情報過多だったので最小限に圧縮、コメント行はユーザ名で 30% 食ってたので削って倍密度に
- 影響: CommentAnalysisGraph.{tsx,module.css}(マウスステートマシン作り直し + tooltipCompact)、LiveCommentFeed.{tsx,module.css}(ROW_HEIGHT 40 + author 列削除)、ClipSegmentsList.tsx(`editTitleRequestId` prop + scroll-into-view)、ClipSelectView.tsx(コンテキストメニュー orchestration)、SegmentContextMenu.{tsx,module.css}(新規)
- コミット: `b849b82`

## 2026-05-02 17:30 - 操作系整理(左右クリック分離) + ピーク詳細廃止 → 常駐ライブコメントビュー

- 誰が: Claude Code(Antigravity から託された仕様の実装)
- 何を:
  - **左クリック / 右ドラッグの分離**: 波形の左クリック単発=シーク、左ドラッグ=ライブシーク(マウスに追従)、右ドラッグ=区間選択 → リリース時に自動で `addClipSegment`、右クリック単発=何もしない(`onContextMenu` で `preventDefault`)。旧「総 5px 閾値で click vs drag を判定」ロジックを「button=0 / button=2 で intent を分けて、それぞれにステートマシン」へ刷新
  - **`PeakDetailPanel` 廃止**: ファイル削除。ピーククリックで開く詳細パネル + 「この区間を編集範囲に設定」ボタン + 「この区間を切り抜きに追加」ボタン + AI 要約スロット + カテゴリ内訳をすべて廃止。`selectedPeak` state、関連の Esc 処理、`onPeakClick` callback も除去
  - **`LiveCommentFeed` 新設**: ClipSelectView 右側に常駐するコメントフィード。動画全体の chat replay を時系列で表示、`currentSec` に追従してオートスクロール(現在位置を viewport 中央)、再生位置 ±5 秒のコメントは強調表示、過去はうっすら、未来はそのまま、現在位置に細い赤の左ボーダー、コメントクリックでそのコメント時刻にシーク
  - **仮想スクロール独自実装**: `react-window` 等の依存追加なし。`ROW_HEIGHT=60px` 固定 + 上下スペーサ div + 可視領域 + `BUFFER_ROWS=6` で 100 行まで描画。数千件のチャットでも常時 ~30 DOM ノードしか出ない
  - **オートスクロール vs 手動スクロール**: `scrollTo({behavior:'auto'})` 直前に `lastProgrammaticScrollTop` を記録、`onScroll` で実 scrollTop と比較して 4px 以内なら無視 / それ以外なら autoScroll OFF。手動 OFF 時は「現在位置に戻る」フローティングボタンで再開
  - **キーワードハイライト**: コメント内の reaction-keyword に薄い色付き下線(背景色は使わず)、SORTED_KEYWORDS で長語先優先
  - **`CommentAnalysis.allMessages: ChatMessage[]` 追加**: バケット集計前の time-sorted 全 chat。renderer で binary search できるよう main の `analyze()` 側で defensive sort してから返す
  - **`MIN_SEGMENT_SEC` を 1 → 5 秒に**: 右ドラッグでうっかり超短い区間が出来ないよう底上げ
  - **ボタン重複の解消**: 「この区間を編集範囲に設定」(`PeakDetailPanel` 内)を完全廃止、`addClipSegment` の呼び出し元は右ドラッグだけに集約
- 理由: 操作系が左クリックに集中して「シークしたいだけなのにパネルが出る」「区間バー上をクリックしてもシークが効かない」等の混乱があった。右パネルは「ピーク区間特化の詳細展開」より「再生位置追従の流しビュー」の方が量産編集に向く(切り抜き作業中、絶えず流れるコメントを見ながら判断する)。ボタン重複は動線分散の元
- 開放されている設計判断:
  - LiveCommentFeed のフィルタ機能(カテゴリ別表示、検索)
  - 区間バー上の AI タイトル表示
  - 仮想スクロールのライブラリ採用(現状は独自実装)
  - 左ドラッグライブシークのフレームレート抑制(`<video>.currentTime` 書き込みを 60 fps から 30 fps へ throttle、現状は無制限)
- 影響: src/common/types.ts (`allMessages` 追加)、src/main/commentAnalysis/scoring.ts (`analyze()` で defensive sort + 返却)、src/renderer/src/components/CommentAnalysisGraph.{tsx,module.css}(マウスステートマシン刷新 + warningToast)、src/renderer/src/components/CommentAnalysisGraph.mock.ts (`allMessages: []`)、src/renderer/src/components/ClipSelectView.{tsx,module.css}(2-column / `selectedPeak` 削除)、src/renderer/src/components/PeakDetailPanel.{tsx,module.css}(削除)、src/renderer/src/components/LiveCommentFeed.{tsx,module.css}(新規)
- コミット: `baef8ad`

## 2026-05-02 16:00 - 複数区間選択 + 感情 9 カテゴリ拡張 + 区間色塗り + アイキャッチ枠

- 誰が: Claude Code(Antigravity から託された仕様の実装)
- 何を:
  - **感情カテゴリ 9 種化**: 既存 5(laugh/surprise/emotion/praise/other)に **death/victory/scream/flag** を追加。ゲーム実況文化(死亡フラグ・クラッチ・GG・察しなど)に踏み込んだ語彙。長語先優先のソート + 正規表現エスケープを `keywords.ts` で済ませる
  - **複数区間選択 (`clipSegments[]`)**: 旧 `clipRange` を撤廃し、最大 20 個の `ClipSegment` 配列に。`addClipSegment` は重複検出 / 上限チェックを返却、ドラッグ範囲選択 + ピーク詳細パネルから追加できる。区間は時刻順に自動ソート
  - **`Eyecatch[]` 自動同期**: 区間が 2 つ以上になると区間間に自動生成。`syncEyecatches(N, current)` で長さ追従、削除時は対応スロットを除去。`skip` フラグで「直結」も選べる
  - **波形の category 色塗り**: 線(stroke)は白固定維持、塗りを `dominantCategory` ごとに分割描画(連続同カテゴリ群を 1 path、隣接時は両端 10% フェードする `linearGradient` で seam 隠し、中央 0.12 透明度)。「グチャグチャ感」再発防止に opacity を強く抑え、白い印象を保持
  - **波形の区間オーバーレイバー**: dominantCategory 色 × `color-mix in srgb 40%` で半透明、番号バッジ + 端ドラッグ resize + 中央ドラッグ move + 隣接区間 clamp + 選択時の削除ボタン
  - **`ClipSegmentsList` 新規**: 動画下にカード一覧、HTML5 drag-and-drop で順序入替、区間タイトル inline 編集(null 時はプレースホルダ)、区間間にアイキャッチ行(text 編集 + skip toggle)、全削除は `window.confirm` で誤操作防止
  - **`PeakDetailPanel`**: 「この区間を編集範囲に設定」→「この区間を切り抜きに追加」に変更。store の add 結果を返り値で受け取り、追加成功 / 重複 / 上限のフィードバックをボタン上で表示(panel は閉じない=連続追加可)
  - **CSS 変数**: `--reaction-death/-victory/-scream/-flag` 4 色追加(暗赤/金/オレンジ/緑)
- 理由: 単区間 `clipRange` ではハイライトコンピレ的編集ができない。10 個以上の区間 + 区間間アイキャッチで「動画ダイジェスト」を編成できる土台が要る。感情拡張はゲーム実況に必須の語彙(死亡 / 勝利 / フラグ)で、視聴者の感情遷移をスコアに反映させる第一歩
- 開放されている設計判断:
  - AI タイトル生成(次タスク、Claude Haiku)
  - アイキャッチの実体動画化(次タスク、FFmpeg で黒画面 + テキスト合成)
  - 編集画面で `clipSegments` を実際に動画範囲絞り込みに使う(現状 `setPhase('edit')` のみで動画レンジは未連動)
  - `ProjectFile` への永続化
  - 自動候補抽出(上位 N ピークを一括追加)
  - スコア重み調整 UI(現状ハードコード)
- 副次効果: keywords.ts のカテゴリ化 / ReactionCategory 型追加が `7f41a02` 時点で uncommitted な WIP 依存だったが、本コミットでようやく一緒に repo に乗る
- 影響: src/common/types.ts (ClipSegment / Eyecatch / ReactionCategory 再 export)、src/common/commentAnalysis/keywords.ts (9 cat / 65+ pattern / sort + escape)、src/main/commentAnalysis/scoring.ts (ZERO 9 cat)、src/renderer/src/lib/rollingScore.ts (9 cat)、src/renderer/src/components/CommentAnalysisGraph.{tsx,module.css}(per-cat fill + 区間バー + drag handlers)、src/renderer/src/components/ClipSegmentsList.{tsx,module.css}(新規)、src/renderer/src/components/ClipSelectView.{tsx,module.css}(統合)、src/renderer/src/components/PeakDetailPanel.tsx(addClipSegment 化)、src/renderer/src/components/CommentAnalysisGraph.mock.ts(9 cat)、src/renderer/src/store/editorStore.ts (clipSegments / eyecatches + actions)、src/renderer/src/styles.css(4 色追加)
- コミット: `dfadf31`(本体)+ `b8eb4b6`(直後修正:波形クリックで即シーク + 音声デフォルトリセット)

## 2026-05-02 14:30 - コメント分析を rolling window スコアに作り直し + W スライダー UI 追加

- 誰が: Claude Code
- 何を: 5 要素(平均コメント密度・平均キーワード・持続率・ピーク強度・視聴者維持率)の rolling window 統合スコアに刷新。W はユーザがスライダーで 30 秒〜5 分の範囲(30 秒ステップ、初期値 2 分)で可変。Stage 1(`bucketize`、main で 1 回)と Stage 2(`computeRollingScores`、renderer で都度)に分解
  - **`src/common/types.ts`**: `RawBucket` 型新設(timeSec / commentCount / keywordHits / categoryHits / messages / viewerCount: number | null)。`ScoreSample` 構造刷新(timeSec / windowSec / density / keyword / continuity / peak / retention / total / dominantCategory / categoryHits[raw 件数] / messageCount)。`CommentAnalysis.samples` を廃止して `buckets: RawBucket[]` を保持
  - **`src/main/commentAnalysis/scoring.ts`**: `bucketize()` を export、`analyze()` が CommentAnalysis(buckets のみ)を返す形に。viewerCount は playboard 失敗時 `null`(以前は `0`)— retention の min/max 計算で「データ無し」と「視聴者ゼロ」を区別
  - **`src/renderer/src/lib/rollingScore.ts`(新規)**: sliding-window で各 sample を計算。重みは `WEIGHTS_WITH_VIEWERS = {density:0.35, keyword:0.20, continuity:0.20, peak:0.10, retention:0.15}`、`WEIGHTS_WITHOUT_VIEWERS = {0.45, 0.25, 0.20, 0.10, 0}`。continuity = 動画全体の中央値以上のバケット割合、peak = window 内 max(commentCount) / 動画全体 max、retention = window 内 min(viewers)/max(viewers)、ウィンドウに viewer サンプル無ければ 0.5 fallback。density / keyword は window 平均値の動画全体最大で正規化
  - **`src/renderer/src/components/WindowSizeSlider.{tsx,module.css}`(新規)**: HTML range スライダー、ラベル整形(`30s/1分/1.5分/2分/...`)、注釈ホバー説明
  - **`src/renderer/src/store/editorStore.ts`**: `analysisWindowSec: number`(初期 120)+ `setAnalysisWindowSec`。setFile / clearFile で初期値にリセット。永続化はせず(プロトタイプ範囲)
  - **`src/renderer/src/components/CommentAnalysisGraph.tsx`**: props に `windowSec` 追加。`samples` を `useMemo` で都度計算。各サンプルの x 座標は window 中央(start + W/2)— 全幅にわたってカーブが伸びるよう調整。tooltip は windowSec を反映、categoryHits は raw 件数表示
  - **`src/renderer/src/components/ClipSelectView.tsx`**: 波形のすぐ上にスライダー配置、windowSec を Graph と PeakDetailPanel に propagate
  - **`src/renderer/src/components/PeakDetailPanel.tsx`**: `analysis` prop 追加、コメント一覧を `[sample.timeSec, sample.timeSec + sample.windowSec)` の bucket から useMemo で集める。「区間設定」ボタンも window 全幅を clipRange へ
  - **`src/renderer/src/components/CommentAnalysisGraph.mock.ts`**: 出力を `samples[]` から `buckets[]` に変更(Stage 1 形状)
- 理由: 旧スコアは「5 秒バケットの瞬間スコア」だけで、「2-5 分続く塊」を表現できなかった。切り抜き作業の本質は「2-5 分の塊を選ぶ」ことなので、rolling window で「W 分続いた盛り上がり」を直接スコア化。Stage 1/2 分離は、スライダー操作時の体感ラグを排除する目的(IPC 往復させない)。視聴者系は「維持率(min/max)」1 軸に絞り、配信全体の右肩上がり/下がりトレンドに引きずられない指標に統一(旧 viewerGrowth は廃止)
- 開放されている設計判断:
  - 視聴者増加率(growth rate)を別軸として復活させるか
  - 重み調整 UI(現状ハードコード)
  - W スライダーの永続化(現状: ファイル切替でデフォルト 2 分にリセット)
  - 自動候補抽出ボタン(上位 N 区間)
- 影響: 上記 7 ファイル + 新規 3 ファイル
- コミット: `7f41a02`

## 2026-05-02 13:30 - コメント分析波線の色をさらに薄く調整(背景レイヤー化)

- 誰が: Claude Code
- 何を: `CommentAnalysisGraph.module.css` で波線 stroke `rgba(255,255,255,0.9)` → `rgba(255,255,255,0.45)`、stroke-width `1.5` → `1.2`、グラデ top `rgba(255,255,255,0.12)` → `rgba(255,255,255,0.06)`(後者は SVG `<stop>` なので `.tsx` 側)。`.graphArea:hover` / `:active` で stroke を `rgba(255,255,255,0.75)` にバンプ + `transition: stroke var(--transition-fast)` で滑らかに(svg 自体は `pointer-events: none` のため、parent の `.graphArea` 経由で hover/drag を捕捉)
- 理由: 今後カテゴリ感情の色味・コメント内容を波形上にレイヤード表示していく計画。波線自体は背景レイヤーとして馴染む控えめさに振ることで、操作中以外は前景情報を邪魔しない。赤い再生位置線は据え置きで、薄い波線とのコントラストで自然に引き立つ
- 影響: `src/renderer/src/components/CommentAnalysisGraph.module.css` + `.tsx`(SVG `<stop>` 1 行)
- コミット: (未定)

## 2026-05-02 11:30 - コメント分析グラフを YouTube ヒートマップ風の波線 UI に再構成
- **誰が**: Antigravity
- **何を**: 
  - 直前のカテゴリ色パッチワーク + ドットマーカー UI を廃止し、白い滑らかな波線 1 本 + 下方向グラデ塗りに変更。
  - カテゴリ情報はツールチップ内のドット表示に退避。
  - SVG 描画を quadratic curves による平滑化ロジックに変更。
- **理由**: 色分けとマーカーにより画面が「グチャグチャ感」を発しており、本来の YouTube Most replayed の控えめで洗練されたデザインから逸脱していた。引き算の設計により、動画再生バーに馴染むモダンな UI を実現した。
- **影響**: `src/renderer/src/components/CommentAnalysisGraph.{tsx,module.css}`, `src/renderer/src/components/ClipSelectView.{tsx,module.css}`
- **コミット**: (実施済み)

## 2026-05-02 11:00 - コメント分析 UI を YouTube Most replayed 風に進化 + カテゴリ色分け + 詳細パネル
- 誰が: Antigravity
- 何を: 
  - キーワード辞書をカテゴリ分け (笑い/驚き/感動/称賛/その他)
  - `ScoreSample` に `dominantCategory` + `categoryHits` + `messages` を追加
  - 波形を SVG 曲線 + カテゴリ色分けに変更 (YouTube Most replayed 風)
  - ピーククリックで `PeakDetailPanel` 展開 (AI 要約スロットはプレースホルダ)
  - `ClipSelectView` の不要テキスト UI を削除
- 理由: スコアグラフが「数値の山」だけでは中身が読み取れず、結局シーク再生で内容を確認する必要があった。視覚的に「ここは笑い区間」「ここは称賛区間」と分かるようにすることで、切り抜き箇所の判断速度を劇的に向上させる。
- 影響: `src/common/commentAnalysis/keywords.ts`, `src/common/types.ts`, `src/main/commentAnalysis/scoring.ts`, `src/renderer/src/components/CommentAnalysisGraph.{tsx,module.css}`, `src/renderer/src/components/PeakDetailPanel.{tsx,module.css}` (新規), `src/renderer/src/components/ClipSelectView.{tsx,module.css}`
- コミット: (実施済み)

## 2026-05-02 12:30 - 緊急修正: ClipSelectView の onDuration/onCurrentTime 未配線が 3 症状の共通根本

- 誰が: Claude Code
- 何を: `ClipSelectView.tsx` の `<VideoPlayer>` に `onDuration={setDuration}` と `onCurrentTime={setCurrentSec}` を追加(App.tsx の edit 相と同じ配線)。3 症状全てが「`editorStore.durationSec` が clip-select 中ずっと null」が共通原因
  - **症状 1(`<video>` コントロール消失)**: video が metadata 取得段階で詰まる場合 Chromium がコントロール非表示 — 副作用的にこう見える(本症状は media:// 失敗等の別要因の可能性も残る、後述ログで切り分け)
  - **症状 2(再生ボタン押すと末尾に飛ぶ)**: VideoPlayer の preview-skip rAF tick が、`cues=[]` + `durationSec=null` → `deriveKeptRegions = []` → `decidePreviewSkip = 'end'` を返し、再生開始の瞬間に `currentTime = duration` + `pause()` を実行。**確実に root cause**
  - **症状 3(コメント分析グラフ真っ黒・波形ゼロ)**: ClipSelectView のグラフは loading/error/no-source 時に `mockAnalysis = generateMockAnalysis(durationSec ?? 0)` を表示するが、`durationSec` が null だと `0` 渡し → mock は samples 0 個を返す → バーが 1 本も描画されない。**確実に root cause**
- 経緯: `1678746` で Antigravity が ClipSelectView を新設したときに `onDuration` 配線が抜けていた。誰も気付かなかったのは、当時のグラフはモックで「durationSec が null でも 1 バケットだけは出る」挙動で、症状が目立たなかったため。`1533d31` で実分析パスを差し込んで mock fallback の `samples: []` 状態が常態化し、グラフが完全に黒く見えるようになって初めて表面化
- 副次対応(ログ駆動デバッグの土台):
  - `mediaProtocol.ts` に **404 Not Found** + **416 Range Not Satisfiable** の警告ログを追加(本症状で video 読み込み失敗が起きていれば即特定できる)
  - `commentAnalysis/index.ts` に start/chat/viewers/scoring 各 phase のログを追加(`[comment-analysis] start url=... duration=...`、`messages=N`、`source=playboard samples=N`、`buckets=N hasViewerStats=bool`)
- 後続検証(ユーザ環境): 本修正で症状 2/3 は完治するはず。症状 1(コントロール消失)が残った場合は新ログ出力(`[mediaProtocol] 404 Not Found:` など)で原因切り分け
- 反省: spec で「Step 1 で取得したログから原因特定」を求められたが、本サンドボックスから renderer DevTools にアクセスできず実機ログ取得不可。コード監査で `setFile`→`durationSec` の経路を追ったところ ClipSelectView の prop 欠落が見つかり、症状 2/3 の挙動が論理的に再構成できた。次回以降は実機ログ取得手段を確保したうえで debug する
- 影響: `src/renderer/src/components/ClipSelectView.tsx`(2 props 追加)、`src/main/mediaProtocol.ts`(警告ログ 2 件)、`src/main/commentAnalysis/index.ts`(進行ログ 4 件)
- コミット: (未定)

## 2026-05-02 11:30 - コメント分析: 実データ取得 + スコア計算ロジック実装

- 誰が: Claude Code
- 何を: モック→実データへの置換。3 要素統合スコア(コメント密度 + 視聴者増加 + キーワード)を実 yt-dlp チャットリプレイ + playboard.co スクレイピング + ハードコード辞書から計算してグラフに供給
  - **`src/main/commentAnalysis/chatReplay.ts`(新規)**: yt-dlp で `--write-subs --sub-langs live_chat`(YT)/ `rechat`(Twitch)+ `--skip-download`。出力 JSONL/JSON をパースして統一中間表現 `ChatMessage` に。`userData/comment-analysis/<videoId>-chat.json` キャッシュ(infinite TTL — チャットは immutable)
  - **`src/main/commentAnalysis/viewerStats.ts`(新規)**: playboard `/en/video/<videoId>` を fetch、`__NEXT_DATA__` / `__NUXT__` / 任意の `<script type="application/json">` の順でハイドレーション JSON を抽出。中身を再帰探索して「`{time, count}` 形状の配列で時系列が単調増加」のパターンを掴む(playboard の path が将来変わってもヒューリスティック検出で残骸吸収)。失敗時は `source: 'unavailable'` で graceful degradation
  - **`src/common/commentAnalysis/keywords.ts`(新規)**: ハードコード辞書(草/wwww/やばい/神/8888/初見 等 30 語)、長語優先で正規表現プリコンパイル
  - **`src/main/commentAnalysis/scoring.ts`(新規)**: 5 秒バケット集計、3 要素正規化(commentDensity / keywordHits は max スケーリング、viewerGrowth は前バケット差分の正の値のみ)、視聴者データ有無で重み切替(あり: 0.5/0.3/0.2、なし: 0.7/0/0.3)
  - **`src/main/commentAnalysis/index.ts`(新規)**: orchestrator。chat→viewers→scoring を順次実行、各 phase で onProgress 発火
  - IPC 統合: `commentAnalysis.{start, cancel, onProgress}` を `IpcApi` に追加、main/preload で wire
  - `editorStore` に `sourceUrl: string | null` + `setSourceUrl` 追加。URL DL 完了時に `setFile()` 後に `setSourceUrl(url)` で promote(setFile が sourceUrl を null 化するので順序必須)
  - `ClipSelectView` 結線: マウント時に `commentAnalysis.start({videoFilePath, sourceUrl, durationSec})` を呼んで分析、loading/ready/error/no-source の 4 状態を切替表示。失敗時はモックデータでフォールバック + ヒント文表示
- 調査メモ: playboard.co は本サンドボックス IP からは 453(地域 block / Cloudflare)で実機検証できず、ハイドレーション形状はヒューリスティック検出に賭けた。ユーザ環境(日本)で動かないケースはログから path をピンポイント修正する想定
- 開放されている設計判断:
  - キーワード辞書のユーザ編集 UI 化
  - スコア重みの UI 調整スライダー
  - 自動候補抽出ボタン(上位 N 区間)
  - 区間複数選択
  - プログレッシブ DL との結合(spike report 参照)
  - ProjectFile への commentAnalysis 永続化
- 影響: `src/common/types.ts`(ChatMessage / ViewerSample / ViewerStats / CommentAnalysis / IpcApi 拡張)、`src/common/commentAnalysis/keywords.ts`(新規)、`src/main/commentAnalysis/*`(4 ファイル新規)、`src/main/index.ts`(IPC 2 件追加)、`src/preload/index.ts`(commentAnalysis namespace expose)、`src/renderer/src/store/editorStore.ts`(sourceUrl + setSourceUrl)、`src/renderer/src/App.tsx`(URL DL 完了後 sourceUrl promote)、`src/renderer/src/components/ClipSelectView.tsx`(モック→実分析、4 状態 UI)
- コミット: (未定)

## 2026-05-02 09:00 - プログレッシブ DL + 並行文字起こしの技術検証(spike)

- 誰が: Claude Code
- 何を: ユーザ要望「DL 完了を待たずに YouTube ライクに編集 + シーク」を実現するための土台調査。本実装はせず、4 論点を実機 + 公式ドキュメントで検証して `docs/PROGRESSIVE_DL_SPIKE_REPORT.md` に結果まとめ
- 検証論点 + 主要結論:
  - **論点 1(yt-dlp シーク追従 DL)**: `--download-sections "*X-Y"` で範囲別 DL → ffmpeg `-c copy` で連結成功(19s 動画で連結後 19.02s)。HLS 経路は YouTube VOD では使えず(全 PROTO=https の DASH のみ)。`--force-keyframes-at-cuts` は再エンコード必須なので外す方針(GOP 境界の数フレームズレを許容)
  - **論点 2(`<video>` buffered)**: 既存 mediaProtocol は growing-file に追従できず ❌ / `MediaSource + ffmpeg fragmented MP4 (`-movflags frag_keyframe+empty_moov+default_base_moof`) feed` ✅ を **推奨**。ffmpeg で fMP4 化が動くことを実機確認 / mediaProtocol 改造の long-poll 案は browser timeout で脆弱
  - **論点 3(Gladia 並行文字起こし)**: `/v2/pre-recorded` は完全 audio 前提 ❌ / `/v2/live` は WebSocket ベース、PCM 8-48kHz、partial+final transcripts incremental ✅ を **推奨**(MVP は pre-recorded のままでも可)
  - **論点 4(プロセス管理)**: 既存 `cancelDownload` は単一プロセス前提で不足。`ProgressiveDLManager` 雛形を設計(primary/secondary DL + audio pump + Gladia WebSocket、Map<id, ChildProcess> で track、cancel/seek/full-DL モード切替)
- 致命的リスク: YouTube 1080p AVC1 は **video+audio 別ストリーム + マージ前提** で merge 前は再生可能ファイルが存在しない → fMP4 リアルタイム変換パイプ必須
- 実装フェーズ提案:
  - **Phase A**(1 週間、UX 80%): 360p 単一 muxed format `18` で先行 preview DL + mediaProtocol を growing-aware に
  - **Phase B**(2 週間、UX 100%): MediaSource + ffmpeg fragmented MP4 pipe で 1080p AVC1 リアルタイム再生
  - **Phase C**(3-5 日): Gladia `/v2/live` WebSocket で並行文字起こし
- ユーザ判断待ちの選択肢: Phase A で段階的か / B で一気に / Gladia は live か pre-recorded chunk か / Twitch VOD 対応のタイミング / 「全部 DL」モード切替時の partial 破棄か継続か
- 影響: `docs/PROGRESSIVE_DL_SPIKE_REPORT.md`(新規)、`src/main/spikes/progressive-dl-spike.ts`(新規、本番未組み込み)
- コミット: (未定)

## 2026-05-02 07:15 - URL DL 進捗 0.0% 固着の本当の原因を実機ログで特定 → `--progress` 追加で解決

- 誰が: Claude Code
- 何を: `2b3ffe6` で `--progress-template` を入れたが、実機では依然として進捗イベントが 1 件も飛ばないバグが残存。生 yt-dlp ログを採取して **真の根本原因を特定**
- 採取した生ログ(`yt-dlp.exe -f "..." -o "..." --merge-output-format mp4 --newline --progress-template "..." --no-playlist --no-warnings --restrict-filenames --print "after_move:filepath" --print "title"`):
  - stdout に **タイトルとファイルパスの 2 行のみ**、`JCUT_PROGRESS` 行は **1 行も無し**
  - stderr も完全に空(EOL なし)
  - DL 自体は成功(exit 0)
- 原因: yt-dlp は `--print` 指定時に **暗黙的に quiet モード** に入り、進捗を含む全てのデフォルト出力を抑制する。`--progress-template` は「テンプレートを使う」設定であり「進捗を出力する」設定ではない。`--progress` フラグ(`Show progress bar, even if in quiet mode`)を明示的に追加する必要があった
- 修正: `src/main/urlDownload.ts` の spawn 引数に `'--progress'` を 1 行追加。再採取で `JCUT_PROGRESS  0.2%  153.62KiB/s 00:02` の形式で 1 ファイル 20 行程度の進捗イベントが stdout に流れることを確認
- 観察された 2 パス挙動: video ストリーム DL(0→100%)→ audio ストリーム DL(0→100%)→ 結合、の順。renderer の進捗バーは 100% まで上がってから 0% に戻り再度 100% まで進む(自分用ツール段階としては許容、merger フェーズの「結合中…」表示は将来検討)
- 検証: `Me_at_the_zoo`(YT 最古の公開動画、19 秒)を実 DL → ffprobe で `h264 / aac` の MP4 を確認、Chromium 互換 OK
- 反省: `2b3ffe6` 時に `--simulate` でフォーマット選択は確認したが、**実 DL の生ログ採取を省いていた** ため進捗抑制バグを見逃した。次回以降は最低 1 ケース実 DL ログを取る方針
- 影響: `src/main/urlDownload.ts`(`'--progress'` 1 行 + コメント)
- コミット: `f754527`

## 2026-05-02 06:50 - URL DL: 進捗 0.0% 固着 + DL 後再生不可の修正(フォーマット限定 + 進捗テンプレート明示化)

- 誰が: Claude Code
- 何を: yt-dlp 起動引数を 2 点強化して 2 件の不具合を同時解決
  - **フォーマットセレクタを Chromium 互換優先に変更**: `bestvideo[ext=mp4][vcodec^=avc1]<heightFilter>+bestaudio[ext=m4a]/best[ext=mp4]<heightFilter>/best<heightFilter>` の三段フォールバック。MP4-AVC1+M4A-AAC を最優先 → MP4 単一ストリーム → 何でも、の優先順位。`--merge-output-format mp4` は既設で結合コンテナを mp4 に強制
  - **進捗テンプレート `--progress-template` を明示化**: `download:JCUT_PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s` を渡し、yt-dlp デフォルト `[download]  45.3% of ...` 行のフラジリティ(`Unknown%` / フラグメント merge 中ドロップ / chunk 分割不安定)を回避。1 行 1 トークンの固定フォーマットを単一正規表現で受ける形に
  - 進捗イベントに **250ms throttle** 追加(renderer の更新負荷低減)
  - 旧 `[download]` 正規表現は **fallback として残置**(yt-dlp ビルド/フェーズ差吸収)
  - `--print after_move:filepath` / `title` 経路は維持、`[download] xxx has already been downloaded` / `[Merger] ...` パスも従来通り捕捉
  - 起動時に `console.log('[url-download] format selector:', format)` を追加してデバッグの起点を残す
- 検証: `yt-dlp.exe --simulate --print "..." -f "..."` で実 URL に対し:
  - "best": format `137+140` = `avc1.640028 | mp4a.40.2 | mp4`(1080p AVC1 + AAC、Chromium ネイティブ)
  - "720": format `136+140` = `avc1.4d401f | mp4a.40.2 | mp4`(720p AVC1 + AAC)
  - いずれも MP4-AVC1-AAC で着地することを確認
- 理由: `1678746` で IPC + DropZone 動線は通ったが、yt-dlp デフォルトが AV1/VP9-mkv/webm 等 Chromium 非ネイティブな最高画質を取得しており、(1) 進捗 stdout のバッファリング/想定外フィールドで 0.0% 固着、(2) DL 後 `<video>` で再生不可、の 2 件が同時発生していた。フォーマット強制 + 進捗テンプレートで両方の根本を一度に潰す
- 影響: `src/main/urlDownload.ts` のみ
- 既存 DL 済みファイル: 再生できない場合は **再 DL 推奨**(本修正は新規 DL にのみ効く)
- 副作用: 4K AV1 / 1440p VP9 など高画質形式は **意図的に切り捨て**(自分用ツール段階の互換性優先方針)。最大 1080p AVC1 にキャップ
- コミット: `2b3ffe6`

## 2026-05-02 00:50 - 寝る前作業: NEXT_SESSION_HANDOFF.md にセッション末状態を凍結

- 誰が: Claude Code
- 何を: 次セッションが即座に再開できるよう、進行中タスクと未確認の判断事項を `NEXT_SESSION_HANDOFF.md` に保存
  - **コピペ用プロンプト**(冒頭): 新セッションで貼ると Claude Code が全状態を把握する形式。読むべきドキュメントの順番、直前の状況サマリ、最初のアクション順、実機動作確認パターン、みのるの作業スタイル、法的注意までワンショット
  - **凍結時刻のリポジトリ状態**(HEAD = `1678746`, origin/main 同期済み, working tree clean)を明記
  - **完了済み機能のマトリクス**(MVP / Gladia / 字幕 Phase A〜B-3 / 話者カラム / DnD / URL DL / コメント分析グラフ / 3 フェーズ構造 / ドキュメント整理)を機能 × コミット × 状態の表で
  - **進行中タスク**(3 フェーズ構造の実機未確認、URL DL バグ修正の実機未確認)を分離して記録 — 次セッション冒頭で実機確認を促すフロー
  - **次にやること**(コメント分析画面 MVP のバックエンド実装 = yt-dlp チャットリプレイ取得 + scorer + clipRange 永続化)を `docs/COMMENT_ANALYSIS_DESIGN.md` への参照付きで
  - **本セッションで確定した重要な決定**(URL DL の prop 契約、URL DL の 1 ステップフロー、3 フェーズ構造の正規化)を再掲
  - **既知の地雷ポイント**(Windows パス escape、ASS BGR、Gladia hint の保証なし、`grid-row: 1 / -1` の implicit row 問題、yt-dlp パス分岐、OneDrive 仮想プレースホルダ等)を一覧化
- 同梱の決定の明示化:
  - **3 フェーズ構造を正規の動線として確定**: load(動画読込) → clip-select(コメント分析グラフで切り抜き範囲ドラッグ選択) → edit(文字起こし・編集・書き出し)。edit ヘッダから clip-select に戻れる。前回の最下部固定 + 単一画面はモック扱いで置き換え済み
- 理由: 長セッションで複数タスクが並行・bundle され、寝起きに状態を再構成する負担が高い。「次セッションが即座に再開できる」形に凍結することで翌朝のロスを最小化。コピペ用プロンプト形式で Claude Code に渡す手順を 1 ステップに圧縮
- 影響: `NEXT_SESSION_HANDOFF.md`(新規)、`DECISIONS.md`(本エントリ追記)
- コミット: (未定)

## 2026-05-02 00:30 - URL DL バグ 2 件修正(両方とも同じ根本原因)

- 誰が: Claude Code
- 何を: DropZone に統合された URL DL の「ダウンロードが始まらない」「URL 入力画面が二重に出る」を解消
  - **根本原因(両バグ共通)**: `DropZone.tsx` の prop 型が `onUrlDownloadRequested: () => void`(URL 引数なし)で、入力欄に貼った URL がローカル state に閉じ込められたまま親に届いていなかった。`App.tsx` の `handleUrlDownloadClick` は URL を受け取らず、TOS 通過後に旧 `UrlDownloadDialog`(URL 入力欄つき)を開いていただけ → DropZone の URL は事実上捨てられ、ユーザは同じ URL を 2 回目のダイアログで入力し直す必要があった
  - **修正**: `onUrlDownloadRequested: (url: string) => void` に変更し、DropZone 内で「ボタンクリック / Enter キー」で `submitUrl()` から URL を渡す。`App.tsx` 側で `pendingUrl` ステートを介して TOS 同意フローと連結 → 直接 `startDownloadFlow(url)` が走るルートに整理
  - **不要化した legacy dialog の削除**: `UrlDownloadDialog.tsx` + `.module.css` を完全削除(`grep -r UrlDownloadDialog src/` で参照箇所が App.tsx だけだったことを確認)。menu.ts にも URL DL 動線はなく、機能リグレッションなし
  - 初回 DL 時に `defaultDownloadDir` が null なら `openDirectoryDialog` で 1 回だけ尋ね、保存して以後省略。画質は `defaultDownloadQuality`(default 'best')をそのまま使用 — 中間ダイアログを介さない 1 ステップフロー
  - エラー処理: yt-dlp ENOENT 等の起動失敗は `child_process.spawn` の `error` イベントから `reject` されて `App.tsx` の `alert(\`ダウンロードに失敗しました: ${msg}\`)` に届く既存ルートで surface 済み(サイレント失敗にはなっていなかった)。ユーザ体感の "サイレント失敗" は実は「URL を捨てて空ダイアログを開いていただけ」だった
- 理由: 1 ステップ動線(URL 貼って → 規約 → 進捗 → DL 完了)を実装したつもりが、prop シグネチャの引数欠落で半端に旧 dialog 経路に逆戻りしていた。型レベルで URL が必須になるよう契約を直すのが正しい修正
- 影響: `src/renderer/src/components/DropZone.tsx`(submitUrl + Enter キー対応)、`src/renderer/src/App.tsx`(`pendingUrl` ステート + `startDownloadFlow` + `handleUrlDownloadRequested` に再構成、legacy dialog の JSX 削除)、`src/renderer/src/components/UrlDownloadDialog.tsx` + `.module.css`(削除)、`HANDOFF.md`(ディレクトリ構成から `UrlDownloadDialog.tsx` 削除)
- コミット: (未定)

## 2026-05-01 23:35 - アプリを 3 フェーズ構造に再編 + コメント分析グラフ簡素化
- 誰が: Antigravity
- 何を: editorStore に phase ステート追加(load / clip-select / edit)、ClipSelectView 新規実装、CommentAnalysisGraph の chrome 削除でヒートマップ風 UI に、edit ヘッダに「切り抜き範囲を選び直す」ボタン追加
- 理由: 「動画読み込み → 切り抜き範囲選択 → 編集」の動線を明示化。前回の最下部固定表示は仮実装で、本来の動線に組み込む段階
- 影響: editorStore.ts (phase / clipRange 追加)、App.tsx (フェーズ分岐)、ClipSelectView.tsx (新規)、CommentAnalysisGraph.tsx (UI 簡素化 + ドラッグ選択対応)、CommentAnalysisGraph.mock.ts (durationSec 受け取り)
- コミット: (未定)

---

## 2026-05-01 23:25 - コメント分析画面 UI MVP 着手(モックデータ先行)
- 誰が: Antigravity
- 何を: CommentAnalysisGraph コンポーネント新設、3 要素統合スコアの可視化、モックデータで動作確認可能な状態に
- 理由: バックエンド(yt-dlp チャットリプレイ取得・スコア計算)着手前に UI 形を固めることで、データ構造の最終確定を逆算できるようにする
- 影響: src/renderer/src/components/CommentAnalysisGraph.{tsx,module.css,mock.ts} 新規。App.tsx に動作確認用の一時組み込み(TODO コメント付き)
- コミット: (未定)

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
