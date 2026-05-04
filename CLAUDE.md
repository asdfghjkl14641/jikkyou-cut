# プロジェクト方針(Claude 向け)

## ⚠️ アプリ起動時の絶対ルール(最初に読む)

実機検証 / UI 確認のためにアプリを起動するときは **必ず `npm run dev` を使う**。

| コマンド | 使う時 | 詳細 |
|---|---|---|
| ✅ `npm run dev` | **常にこれ** | `electron-vite dev -w`。watch mode で main / preload / renderer の変更が即反映 |
| ✅ `npm run dev:fresh` | dist キャッシュ疑い時 | `out/` を消してから dev 起動 |
| ❌ `npm run start` | **使わない** | `electron-vite preview`。`out/` 内の **古いビルド成果物を実行** する。コード変更しても反映されない事故が頻発した |
| ❌ `out/main/index.js` 直接実行 | **使わない** | 同上、ビルド成果物を直接掴む |

### dev 起動が成功した目印

ターミナルに以下が出てれば OK:
- `dev server running for the electron renderer process at: http://127.0.0.1:3001/`(または 3002 等)
- `start electron app...`
- main プロセスが上がって Electron ウィンドウが立ち上がる

これらが出ないまま「アプリ動いてる」と判断しない。

### 古い Electron プロセスが残って邪魔する時

開発中に再起動を繰り返すと orphan が残ることがある。Windows での掃除:

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'jikkyou-cut' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

bash でも:
```bash
# Windows: タスクマネージャーから "electron.exe" を全終了でも可
taskkill //F //IM electron.exe  # Git Bash 経由(// は MSYS のエスケープ)
```

### 過去事例

2026-05-03 までに、Claude Code が `npm run start` を呼んで「コード変更が反映されない、なぜ?」とハマるケースが複数回発生した。**`start` は dev 用ではない**。デバッグや実機確認は `dev` 一択。

---

## 概要

ゲーム実況・配信切り抜き特化の動画編集ツール。Electron + React + TypeScript 製。
Vrew のような「テキストを消すと動画もカットされる」編集を、長時間アーカイブに対して **無制限・無料** で提供する。

## 対象ユーザー
ゲーム実況 YouTuber、長時間配信を切り抜く VTuber/ストリーマー。

## 技術スタック

- Electron + electron-vite + React 18 + TypeScript
- 動画処理: システム導入済み FFmpeg 8.1(`--enable-whisper`)を `execa` で呼び出す
- 状態管理: zustand
- UI: 素の CSS Modules のみ。UI ライブラリ(Radix / Tailwind / shadcn など)は **MVP では一切入れない**
- パッケージマネージャ: npm

## ディレクトリ構成

```
src/
  main/      Electron メインプロセス(FFmpeg 起動、ファイル I/O)
  preload/   IPC ブリッジ
  renderer/  React UI
  common/    main/renderer 共有の型・定数
```

## コーディング規約

- TypeScript strict
- コメントは "なぜ" のみ。"何を" は書かない
- 機能追加は MVP スコープに収める。先回り抽象化禁止
- Windows 11 特有のパス区切り(`\\`)は path モジュールで吸収

## MVP スコープ(これだけ作る)

1. 動画読み込み + HTML5 プレビュー
2. Whisper による日本語文字起こし
3. テキスト削除 → 区間削除のリンク(**文(セグメント)単位**)
4. セグメント可視化タイムライン
5. FFmpeg で最終書き出し

## スコープ外(やらない)

- マルチトラック編集 / リアルタイムエフェクト / キーフレーム
- 多言語 UI(日本語のみ)
- コメントヒートマップ(MVP 後)
- バッチ処理
- 単語単位の編集(S5 完了後に再検討)

## MVP の編集粒度制約

編集は ASR(Gemini)が出力した **キュー単位** で行います。1 キューの一部だけを残し残りを消す、といった細かい編集は MVP では不可能です。粒度を細かくしたい場合は:

- ASR のセグメント長(`queue=` パラメータ)を短く調整 — Gemini の場合はプロンプトで指示
- フレーム単位のトリミング機能(MVP 後の改善項目)
- LosslessCut 等で後段加工

を検討します。

## 確定済み設計判断

| 項目 | 決定 |
|---|---|
| Whisper モデル | ユーザが `ggml-base.bin` 等を手動 DL。設定で絶対パス指定。初回起動時に DL リンクとセットアップ手順を画面で案内 |
| 状態管理 | zustand |
| UI ライブラリ | 素の CSS Modules のみ |
| FFmpeg パス | PATH からの自動検索を第一候補、設定で絶対パス指定もできるハイブリッド方式 |
| テキスト編集の粒度 | MVP は文(セグメント)単位のみ |

## ライセンス上の制約

**GPL-2.0-or-later** で配布。LosslessCut(`C:\dev\lossless-cut`、GPL-2.0-or-later)から派生コードを流用するため、
コピーしたファイルにはオリジナルの著作権表記を保持し、上部に出典コメントを付与すること。

## LosslessCut 参考資料

`C:\dev\lossless-cut` にクローン済み。流用候補:

- `src/main/ffmpeg.ts` — `execa` 起動と進捗パース
- `src/main/progress.ts` — `-progress pipe:` のパーサ
- `src/renderer/src/segments.ts` — セグメント純関数群(createSegment, sortSegments, invertSegments)
- `src/renderer/src/hooks/useKeyboard.ts` — キーボードショートカット基盤
- `src/renderer/src/Timeline.tsx` — タイムライン描画(シンプルな部分のみ)

LosslessCut の「smart cut」「html5ify」「@electron/remote」「Radix UI エコシステム」は **不採用**。

## 開発コマンド

```bash
npm run dev        # 実機検証はこれ。watch mode で変更が即反映
npm run dev:fresh  # out/ を消してから dev 起動(キャッシュ疑い時)
npm run build      # 本番ビルド
npm run lint       # ESLint(後追い導入)
npm run test       # Vitest(後追い導入)
```

**`npm run start` は使わない**(古いビルドを実行するだけ — 文書冒頭の警告参照)。

## 完了済み大規模再設計

### 動画 DL 高速化 5 段階(2026-05-03 完了)

長尺配信(10 時間級)の DL が 1-2 時間かかる問題に対して、段階的に
ボトルネックを潰す再設計。完成形のフロー:

```
URL 入力 → 音声 DL(数十秒) → ClipSelectView オープン + embed 再生 +
AI 抽出可能 → 裏で動画 DL → DL 完了で再生位置維持で seamless 切替 →
編集 → 書き出し
```

| 段階 | 内容 | 完了日 |
|---|---|---|
| 1 | yt-dlp `--concurrent-fragments 8` + バイナリ最新化 + ベンチログ | 2026-05-03 |
| 2 | 音声優先 DL + AI 抽出の早期実行(audio-first / video-background) | 2026-05-03 |
| 3 | YouTube/Twitch 埋め込みプレイヤー(DL 完了前から再生) | 2026-05-03 |
| 4 | 編集中のプレイヤー切替(埋め込み ↔ ローカル動画) | 2026-05-03 |
| 5 | Twitch 動作確認 + 微調整 | 2026-05-03 |
| 6a | URL 入力時の並列化(コメント分析 + グローバルパターン preload) | 2026-05-03(Bug 1 進行中) |
| 6b | yt-dlp `--cookies-from-browser` 統合(YouTube bot 検出回避) | 2026-05-03 |
| 6c | cookies.txt ファイル直接指定(優先度 ファイル > ブラウザ) | 2026-05-03 |
| 6d | format selector 緩和 + `--js-runtimes node` 全経路適用 | 2026-05-03 |

詳細は DECISIONS.md(2026-05-03 各エントリ)参照。残課題は TODO.md。

## 進行中の新機能シリーズ:配信者自動録画

Twitch 配信者を登録 → 配信開始を検知 → yt-dlp で自動録画する機能。
最終ゴールは IDEAS.md の「配信アーカイブ → 自動動画化」の第一歩。

| 段階 | 内容 | 状態 |
|---|---|---|
| X1 | Twitch + YouTube 配信者登録 UI(`twitchHelix.ts` / `creatorSearch.ts` / `MonitoredCreatorsView.tsx` / discriminated `MonitoredCreator` 型) | ✅ 2026-05-03(完成版) |
| X2 | 配信検知ポーリング(`streamMonitor/`、1 分毎、Twitch streams.list batch + YouTube RSS + `videos.list?liveStreamingDetails`、配信開始/終了イベント発火、登録チャンネル画面 + フローティング指示子で UI 反映) | ✅ 2026-05-03 |
| X3.5 | タスクトレイ常駐(`tray.ts`、✕ で hide、シングルインスタンス、Windows 自動起動 + `--minimized`、tray live indicator + `streamMonitor.subscribeStatus`) | ✅ 2026-05-04 |
| X3+X4 | 録画(`streamRecorder/`、yt-dlp `--live-from-start` + Streamlink オプション)+ VOD 取り直し(Twitch helix archive / YouTube actualEndTime)+ 録画済み動画 UI + 編集連携 + 規約警告 | ✅ 2026-05-04 — **シリーズ完成** |
| X5 | YouTube ライブ検知精度向上 | 将来 |

X1 で固まった規約:
- Twitch Client ID は AppConfig に平文(公開情報)、Secret は `secureStorage.saveTwitchSecret` で DPAPI 暗号化保存
- Helix 認証は **Client Credentials flow のみ**(read-only 用途で十分、User Token は使わない)
- メモリトークンキャッシュ + fingerprint で credentials 切替検知 + 401 で自動 retry-once
- `MonitoredCreator` は **discriminated union**(`'twitch'` / `'youtube'`)、platform-stable id(`twitchUserId` / `youtubeChannelId`)で dedup。同一人物が両プラに居る場合は別エントリ
- 検索は **Gemini で 名前 → handle/login 推定 → 各プラ API で プロフィール解決** の 2 段階。Gemini は `gemini-2.5-flash` の `generateTextWithRotation`(Files API なし、`responseMimeType='application/json'`)
- 「登録チャンネル」は **メイン画面のメニュー導線(Ctrl+Shift+M)** + **全画面 swap-in phase** で実装。設定ダイアログのタブには **Twitch 認証(Client ID/Secret)のみ** 残置
- 「追加」前は **必ず確認ダイアログ**(`誤登録防止`)、low confidence 時は警告強調

X2 で固まった規約:
- ポーリング間隔は `POLL_INTERVAL_MS = 60_000`(1 分)、`streamMonitor/index.ts` の定数。将来 user-configurable は spec 範囲外
- YouTube は **RSS feed が主役**(0 quota)、`videos.list?part=liveStreamingDetails`(1 quota)で確定。`search.list?eventType=live`(100 quota)は使わない
- Twitch は `helix/streams?user_id=...&user_id=...` を最大 100 ids/req batch で。配信中ユーザのみ data[] に入る = response 自体が live set
- ポーリングのマスタースイッチは `AppConfig.streamMonitorEnabled`(default `false`、永続化、データ収集と同形)。per-creator フィルタは `MonitoredCreator.enabled`、両方 `true` でないと poll 対象外
- 状態は in-memory(再起動で消える、再 poll で再構築)。永続化はしない
- `LiveStreamInfo.url` は Twitch `https://www.twitch.tv/<login>` / YouTube `https://www.youtube.com/watch?v=<videoId>` を保持(段階 X3 の録画 URL に直接使える)

X3.5 で固まった規約:
- **Windows 専用**(`process.platform === 'win32'` ガード)。macOS / Linux は close/tray/loginItem の 3 箇所すべて no-op で従来挙動維持
- アプリの quit 経路は **`actuallyQuit()` 単一**(`isQuitting = true` を立てる)。ファイル → 終了メニュー、トレイ右クリック「終了」、`before-quit` の保険、すべてここを通る
- ✕ ボタンの hide 判定は同期的に `cachedCloseToTray` を見る(boot + `settings:save` で更新)。`loadConfig()` の await を挟むと preventDefault に間に合わない
- **シングルインスタンス**: `requestSingleInstanceLock()` を **モジュールトップレベル** で呼ぶ。`whenReady` 内だとタイミング依存
- 自動起動は Electron `setLoginItemSettings({ openAtLogin, args })`、`startMinimized` 時は `args: ['--minimized']`、process.argv で受け取って boot 直後に hide
- トレイアイコンは `resources/tray-icon.png`(通常)+ `resources/tray-icon-live.png`(配信中)、PowerShell `System.Drawing` で生成したプレースホルダ。`extraResources` で packaged build にも同梱
- `streamMonitor.subscribeStatus(cb)` で in-process listener を Set 管理、IPC self-loop を回避(tray が同じステータスを欲しがるため)

X3+X4 で固まった規約:
- **yt-dlp 主役 / Streamlink フォールバック**(spec の想定の逆転)。理由: yt-dlp は同梱バイナリで確実に動く、Streamlink はユーザ手動配置必須
- 録画は `streamMonitor.subscribeStreamStarted(cb)` / `subscribeStreamEnded(cb)` で in-process トリガ。IPC 経由ではない
- メタデータは disk が真実源(`<recordingDir>/<platform>/<creator>/<recordingId>.json`)、in-memory `active` マップは subprocess 管理用
- 録画 lifecycle:`recording → live-ended → vod-fetching → completed` (or `failed`)。各遷移で `writeMetadata` + IPC `streamRecorder:progress`
- crash recovery は boot 時に `recoverInterruptedRecordings` が stale 'recording' / 'live-ended' / 'vod-fetching' を 'failed' に書き換え
- VOD 再取得は `urlDownload.downloadVideoOnly` を流用しない(output template 制御不可) — `streamRecorder/vodFetch.ts` で yt-dlp 直接 spawn、cookies / format selector は `getCookiesArgs` 経由で流用
- Twitch VOD: `helix/videos?type=archive&first=1` を 5 分バックオフ × 3 試行
- YouTube VOD: `liveStreamingDetails.actualEndTime` ポーリング 5 分バックオフ × 4 試行(最長 20 分)
- 同時録画上限 5、ディスク 10 GB 未満で abort、50 GB 未満で warning
- 「録画済み動画」UI は `MonitoredCreatorsView` 内、「編集を開始」は `closeMonitoredCreators` → `setFile(absPath)` の 2 段階(ファイル drop と完全同経路)
- 規約 disclaimer は初回 `recordingEnabled` ON 時に表示、`recordingDisclaimerAccepted = true` で永続化
- **streamMonitor subscriber は streamMonitor.start() より前に登録すること**(初回 poll で起動前から live だった配信者の started イベントを取り逃がす race を防ぐ、2026-05-04 緊急修正)
- **OS スリープ防止**: `src/main/powerSave.ts` が `powerSaveBlocker.start('prevent-app-suspension')` を ref-counted ラップ。streamRecorder が session start/end で `acquire(recording:<id>)` / `release(recording:<id>)`、`will-quit` で `releaseAll`。`AppConfig.preventSleepDuringRecording`(default true)で gate
- **`[twitch-poll]` debug logs**: `querying user_ids` / `response entry` / `missing` が出る。配信検知されない時はこれで原因切り分け可能(`missing` に user_id があれば stale id か unlisted、`response entry` に出るのに recorder が反応しないなら別の問題)
- **「↻ 再取得」**: 各 Twitch 行の `monitoredCreators:refetchTwitch` で stored login から user_id を取り直す。Twitch アカウント改名 / X1 Gemini 検索の handle 推測ハズレ時の自己修復用
- **`before-quit` shutdown フック**: `streamRecorder.shutdownSync()` が active 録画の subprocess を kill + メタを `writeMetadataSync` で同期書き込み。アプリ終了時の yt-dlp ゾンビ漏れを防ぐ。クラッシュ / 強制 kill では発火しない(boot recovery が `previous app session ended unexpectedly` でフォールバック)
- **`--live-from-start` は YouTube 専用**: yt-dlp の公式仕様。Twitch URL に渡すと「配信開始時点を永遠に探す」無限ループで 0 B になる(2026-05-04 緊急修正、過去 2 回の Twitch 録画失敗の真因)。`recordSession.spawnYtDlp` 内で `info.platform === 'youtube' ? ['--live-from-start'] : []` の条件付き
- **録画にも cookies 統合**: `recordSession` の constructor に `cookiesArgs: string[]` 必須引数。orchestrator が `getCookiesArgs({ platform: info.platform, ... })` で事前構築して渡す。`creatorSearch` / `urlDownload` と同じ priority(プラットフォーム別 > 汎用 > ブラウザ > なし)
- **process tree kill 必須**: yt-dlp の HLS 録画は ffmpeg を子プロセスとして spawn する。`proc.kill()` だけでは ffmpeg が orphan 化して live.mp4 を書き続ける(5/4 に 12 個ゾンビ観察)。`stop()` / `killSync()` 両方で Windows は `taskkill /F /T /PID <pid>` を使う。macOS / Linux は `process.kill()` で OK
- **yt-dlp 早期終了 = 自動再起動**: `proc.on('exit')` で `stopRequested=false` なら `deps.probeIsStillLive()` を呼んで判定。still live + restartCount < 5 → 5 秒クールダウン → `liveFilePath` を `<recordingId>.live.NNN.<ext>` でローテーション → respawn。`liveSegments[]` メタデータに記録(単一セグメント時は省略)
- **probeIsStillLive は orchestrator 注入**: `streamRecorder/index.ts` の `onStreamStarted` でクロージャ作成。Twitch=`getLiveStreams([userId])`、YouTube=`fetchVideoLiveDetails([videoId])`. **probe 失敗時は `true` を返す**(transient API blip で誤って finalise しないため、MAX_RESTARTS=5 が backstop)
- **streamMonitor の ended は 3 連続 missing で発火**: `ENDED_MISS_THRESHOLD=3`、`missingCounts` Map で grace カウント。Twitch API の 1-2 ポール blip では録画停止しない。grace 中は `liveStreams` Map に prior info を carry forward(UI / recorder が早期反応しないように)
- **format selector は platform 別 + `--merge-output-format mp4`**: Twitch は `avc1+m4a` 明示(HLS は元々 H.264/AAC、安全側に倒す)、YouTube は緩和維持(VP9 1080p60 を保つため)。merge-output-format mp4 は全 platform 共通で MP4 強制
- **post-record remux**: `streamRecorder/remux.ts` の `verifyAndRemuxIfNeeded(filePath)` が ffprobe → 必要なら ffmpeg `-c copy -movflags +faststart` で MP4 repack。`onStreamEnded` の `session.stop()` 完了直後 → VOD fetch 前に発火(成長中 MP4 は触らない)。VP9/AV1/Opus は `incompatible` 扱いで `meta.errorMessage` に警告追記、ファイル放置(再エンコードはコスト見合わない)
- **ファイル名から `.live` / `.vod` 二重拡張子は使わない**: ライブ = `<id>.mp4` / `<id>.001.mp4`、VOD = `<id>_vod.mp4`(アンダースコア)。Windows Media Player が `.live.mp4` の `.live` を実拡張子と誤認してエラー 0x80070323 で再生失敗するため。Boot 時に `storage.migrateLegacyExtensions` が旧形式を自動 rename + メタ JSON 同期(idempotent)

### yt-dlp 関連の確定ルール(段階 6 系で固まった)

- **`--js-runtimes node` を必ず付ける**: YouTube の nsig / SABR challenge 解決に Node.js が必要。yt-dlp が PATH 経由で自動検出。Electron 同梱の Node が常に有る前提。urlDownload.ts の 3 関数 + chatReplay.ts の 1 関数、計 4 箇所
- **クッキーは `getCookiesArgs({ cookiesBrowser, cookiesFile })` 一本化**: 直接 args を組み立てない。priority `platform-specific > generic > browser > none`。**汎用 cookies のパスに「youtube」「twitch」が含まれる場合は要求 platform で path-heuristic ガードが発火**(他 platform に YouTube cookies を渡すと 401 になる事故防止、2026-05-04 修正)。中身解析はせず、パスの文字列のみで判定 = ファイル中身を読まない規約と両立
- **クッキーファイル中身は読まない・ログに出さない・コピーしない**: `validateCookiesFile` は `fs.stat` のみ。パスはログ可
- **format selector は `bestvideo<h>+bestaudio / best<h> / best` の 3 段**: avc1 / m4a 制約は撤廃済み、**この方針を維持**(復活させない)。codec / container 制約を入れると JS runtime 不在時の format 解決失敗で「Requested format is not available」を再発させる
- **audio-only DL は platform 別 selector 必須**: Twitch VOD の audio は literal format ID `Audio_Only`(大文字 A、アンダースコア)で公開されているため YouTube 流の `bestaudio[ext=m4a]` 等の codec chain では解決できず exit 1。`urlDownload.buildAudioFormatSelector(platform)` で Twitch=`Audio_Only/bestaudio/best`、YouTube/unknown=`bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio` に分岐。**新しい platform を追加するときは必ずこの helper を経由する**(直接 selector を組み立てない)
- **URL DL は audio + video 真並列**: `startDownloadFlow` で `videoPromise = startVideoOnly(...)` を audio await の **前** に fire する。`downloadVideoOnly` の `sessionId` は optional(省略時は `deriveSessionId(url)` で main 側 derive、URL → sessionId は決定論的なので audio 側と必ず一致)。Twitch のように audio = HLS 全長になる platform で 2x 改善。**audio 失敗時は `cancelVideo()` で in-flight video を能動停止**してプロセス leak 防止
- **comment 取得も同期 tick で fire**: `fetchUrlMetadata(url)`(yt-dlp `--skip-download --print '%(duration)s\n%(title)s'`、1-3 秒)で先行取得した `durationSec` を `commentAnalysis.start({sourceUrl, durationSec})` に渡す。renderer 側 `deriveSessionIdSync(url)` で session id を同期計算 → comment progress events の stale-session check が audio resolve を待たずに通る。`CommentAnalysisStartArgs.videoFilePath` は optional(実態未使用 dead field)
- **Twitch GraphQL chat fetch では `Authorization: OAuth <auth-token>` ヘッダ必須**: cookies の Cookie ヘッダ送出だけだと integrity gateway が page 2 で reject → 1 ページ目しか取れない。`twitchGraphQL.readTwitchAuth` が cookies parse 中に `auth-token` の値を抜き出して `Authorization` ヘッダ用に保持(値は **絶対にログに出さない**、count + 名前のみ)。yt-dlp の twitch.py と同じ規約。**新しい platform の chat fetch を追加するときも cookies の Cookie ヘッダだけに頼らず該当する OAuth/Bearer/Authorization フローがないか調査する**
- **Twitch chat の cache poisoning guard**: `fetchTwitchVodChat` は `{ messages, complete }` を返す。`complete=true` 時のみ `chatReplay.writeCache` が cache に書く。早期 bail(integrity / forbidden / error / rate-limit 諦め / cancelled / cursor 不一致)は `complete=false` で **キャッシュ書かない** = 部分結果でユーザを永久に閉じ込めない
- **4 段進捗 UI**: `UrlDownloadProgressDialog` は audio / video / comment / scoring の 4 行 grid。各行 status は `waiting`(dimmed)/ `active`(青)/ `done`(緑 + ✓)。`buildDialogProgress(...)` ヘルパで既存 IPC progress events から DialogProgress 形に変換。dialog 自体は dumb(IPC awareness なし)

### 新着動画フィード(2026-05-04 から)

`load` phase の DropZone 下に `RecentVideosSection`。**真実源は 2 つ**:
- 自動録画 = `streamRecorder.list()`(メタデータ駆動)
- URL DL = `AppConfig.defaultDownloadDir` のディレクトリスキャン(履歴永続化なし、mtime 判定)

`recentVideos.listRecentVideos(maxAgeHours)` が両方を時系列降順でマージ。`createdAt` は録画 → `meta.startedAt`、DL → `stat.mtime`。VOD があれば録画は VOD ファイル、なければ live capture。**0 件はセクション自体非表示**(空ヘッダだけ残ると不格好)。

クリック動作は `useEditorStore.setFile(filePath)` 経由 = 既存編集フローに合流。録画継続中(`recordingStatus === 'recording'`)は警告ダイアログ。

新着動画セクションは「全部一覧」、登録チャンネル画面の「録画済み動画」は「録画専門」と役割分担。

**サムネ生成の規約**(2026-05-04 サムネ表示バグ修正で固まった):
- `media://` URL は **`media://localhost/${encodeURIComponent(absPath)}`** 一択(`VideoPlayer.toMediaUrl` と同フォーマット)。`media://${path}` は drive letter が host として解釈されて 404 になる
- ffmpeg サムネ生成は `-update 1` 必須(FFmpeg 8 で単一画像出力に必要)
- 成長中ライブ録画は 5 MB 未満は skip(moov atom 未確定領域)
- 0 byte サムネは disk 上で検知次第 unlink + 失敗キャッシュ 5 分 TTL
- 録画 = `<recordingId>.thumb.jpg`(録画フォルダ内)、URL DL = `<filename>.thumb.jpg`(DL ディレクトリ内)

### 配信者検索 = Gemini 主導 + API フォールバック(2026-05-04 から)

**真実源**: `creatorSearch.searchCreators(query)` 一発で取得。renderer は `window.api.creatorSearch.searchAll(query)` を呼ぶ。

**フロー**:
1. `askGemini` → 0 quota の primary
2. Gemini 結果を `fetchTwitchProfile` / `fetchYouTubeProfile` で解決(handle 1 quota)
3. **片方でも空ならその platform だけ API 検索フォールバック**:
   - Twitch: `/helix/search/channels` + 各候補 follower 取得(計 ~6 unit)
   - YouTube: `search.list` (100 quota) + 各候補 `channels.list`(1 × 5 = 5 quota)
4. follower / subscriber 降順で上位 5 件返却

**キャッシュ**: 5 分 TTL の in-memory `Map`(Twitch / YouTube 別個)。連続検索 / 誤クリックの quota 浪費防止。

**データソース UI**:`SearchCard.source` で discriminate、`SourceBadge` コンポーネントが描画
- ✓ Gemini 推測(緑)— 多くは正しいが impostor を返すケースあり、follower で確認
- ⚠ API 検索結果(黄)— Gemini が空。確認ダイアログでも警告強調
- 👤 手動入力(青)— 手動 handle / channelId

**残置**: 旧 `creatorSearch.askGemini` / `fetchTwitchProfile` / `fetchYouTubeProfile` IPC は手動入力フォールバックで使うので削除しない。

**フォロワー / 登録者数 足切りフィルタ**:
- `AppConfig.searchMinFollowers`(default 200_000)、UI で変更可能
- **API fallback のみフィルタ対象**:Gemini 結果と手動入力は閾値無視(spec の意図的緩和)
- **null counts は pass-through**:Twitch app-token で follower 取れない時は罰しない
- 0-hit + `filteredOut > 0` の時、UI に「閾値を下げて再検索」ボタン(`minFollowersOverride` 引数で in-flight override、AppConfig は変更しない)
- `MonitoredCreatorsView` のサーチセクションに `ThresholdWidget`(プリセット + 自由入力)+ `RelaxationHint`(緩和ボタン群)を配置

### API キー保存(2026-05-04 事故対応で固まった規約)

過去事案: 2026-05-04 朝に `geminiApiKeys.bin` が **DPAPI master key 不一致で永久復号不能**(50 個消失)。同時に YouTube は過去の保存バグで「50 個コピペした記憶」が実際は 1 個しか保存されてなかったことも判明。これを受けてハイブリッド保存方式に変更。

- **二重化**: 暗号化 `<userData>/<slot>.bin`(canonical)+ 平文 `~/Documents/jikkyou-cut-backup/api-keys.json`(backup)。両方への書き込みを `secureStorage.saveAt` 系が lockstep で実行
- **保存時の read-back verify**: encrypt → write → read → decrypt → 値一致確認。失敗時は warn ログを残す(削除はしない、平文バックアップが安全網)
- **読み込みフォールバック**: .bin decrypt 失敗時 → 平文バックアップから読み戻す → 新 master key で再暗号化して .bin に書き戻し。ユーザは何もしなくてもキーを失わない
- **エクスポート/インポート**: API 管理画面トップに backup banner と import/export セクション。インポートは差分プレビュー → マージ/置き換え選択。50 個コピペを回避できる
- **平文バックアップの場所選定**: `~/Documents/` を選んだ理由 = userData の外(DPAPI 失敗が両方を巻き添えにしない)/ エクスプローラから見える / アンインストールで消えない / admin 不要 / OneDrive 連携可
- **平文バックアップの SECURITY**: 暗号化されない。banner で警告常時表示。1Password / Bitwarden への追加コピーを推奨
- **救出スクリプト**(緊急時用): `scripts/recover-keys.cjs`。Local State の `os_crypt.encrypted_key` を DPAPI で復号 → master key で .bin を AES-256-GCM 復号。ハイブリッド保存が機能していれば不要、過去事案用

## 重要な実装メモ

### Whisper 呼び出し

FFmpeg 8.1 の whisper は **audio フィルタ**:

```
ffmpeg -i input.mp4 -vn -af "whisper=model=ggml-base.bin:language=ja:destination=out.srt:format=srt" -f null -
```

モデルファイル(`ggml-*.bin`)はユーザに別途 DL してもらい、設定で絶対パス指定。

### コーデック制約

MVP では HTML5 `<video>` がネイティブ再生できる形式(H.264/AAC/MP4、VP9/Opus/WebM)のみサポート。
それ以外は LosslessCut の MediaSource 流し込み実装を参考に後追いで対応。

## 段階的マイルストーン

| Step | 動く状態 |
|---|---|
| **S0** | `npm run dev` で空の Electron ウィンドウが開く |
| **S1** | ファイル選択ダイアログ → `<video>` で再生 |
| **S2** | 30 秒〜1 分のテスト MP4 で文字起こし → 生成 SRT がファイル保存される & renderer に JSON 形式で渡る |
| **S3** | 文字起こし結果をクリックでシーク、行削除でセグメント生成 |
| **S4** | タイムラインに「残す/消す」を色分け表示 |
| **S5** | 書き出しボタン → セグメント連結で MP4 出力 |
