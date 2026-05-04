# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 夜 — 動画 DL 高速化 5 段階再設計 + 段階 6a-6d 完了。**機能は積み上がったが、未解決バグ 3 件 + パフォーマンス問題 1 件あり**。明日の優先順位は明確化済み(本ドキュメント末尾)。

## ⚠️ 次セッションの Claude Code が最初に読むこと

`CLAUDE.md` 冒頭の「アプリ起動時の絶対ルール」を厳守:
- ✅ `npm run dev` / `npm run dev:fresh` を使う
- ❌ `npm run start` 禁止(古いビルド掴む)
- `npm install` 後は `npx @electron/rebuild -f -w better-sqlite3`

dev server 再起動時の orphan 掃除コマンド(Windows):
```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'jikkyou-cut' } |
  ForEach-Object { taskkill /F /T /PID $_.ProcessId }
```

## 🛑 重要:debug ログを削除しないこと

renderer 側に `[comment-debug:app] / [comment-debug:store] / [comment-debug:clip]` が残置中、
main 側に `[comment-debug] / [comment-debug:main]` が残置中。

**明日の Bug 1 再現に必要なため、削除しない**。Bug 1 が真因特定 → 修正 → 動作確認まで終わってから一括撤去する想定(段階 6a の Step 6 をまだ実行していない)。

該当ログの場所:
- `src/renderer/src/App.tsx`(sessionId watcher / startDownloadFlow / commentAnalysis IPC)
- `src/renderer/src/store/editorStore.ts`(setFile / clearFile / enterClipSelectFromUrl / setCommentAnalysisStatus / setDuration)
- `src/renderer/src/components/ClipSelectView.tsx`(mount / re-render snapshot)
- `src/main/commentAnalysis/chatReplay.ts`(全フロー、yt-dlp stdout/stderr 含む)
- `src/main/commentAnalysis/index.ts`(analyzeComments 入口/出口)
- `src/main/index.ts`(commentAnalysis IPC handler)

---

## 今日 1 日の進捗(完了マーク)

### 朝〜午後

- データ収集:per-creator の検索クエリ集中問題(neoporte 5 人だけ高ヒット)対策 — クエリ多角化 + 配信者 40 人 → 75 人 seed 拡張
- AI 抽出パイプライン強化:per-creator JSON → global.json への一本化(M1.5b)、`global.json` パターン採用
- Gemini モデル変更:2.0-flash-exp → 2.5-flash(コスト 1/4 + 文脈理解向上)
- aiSummary キャッシュバグ修正:videoKey の絶対パスをファイル名にそのまま結合してたバグを `videoKeyToFilenameStem(key)` で解消
- WinError 32(file sharing violation)修正:yt-dlp の `<id>.live_chat.json.part-Frag0.part` がセッション間で衝突していた → `chatReplay.ts` の tmpDir に nanoid suffix(`jcut-chat-${id}-${nanoid(8)}`)
- `EmbeddedVideoPlayer` の `setDuration` drift 対策:embed プレイヤーが integer-rounded duration をポーリングで返してくる(audio probe 5740.18s → embed 5741s)→ 既存 valid 値の ±5s 以内なら skip(`editorStore.setDuration` に drift guard 追加)

### 夕方〜夜:動画 DL 高速化 5 段階再設計 + 6a-6d

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | yt-dlp `--concurrent-fragments 8` + バイナリ最新化 + ベンチログ | ✅ |
| 2 | 音声優先 DL + AI 抽出の早期実行(audio-first / video-background) | ✅ |
| 3 | YouTube/Twitch 埋め込みプレイヤー(DL 完了前から再生) | ✅ |
| 4 | 編集中のプレイヤー切替(埋め込み ↔ ローカル動画、再生位置維持) | ✅ |
| 5 | Twitch 動作確認 + 微調整 | ✅ |
| 6a | URL 入力時の並列化(コメント分析 + global patterns を audio DL と並列 fire) | ✅(ただし Bug 1) |
| 6b | yt-dlp `--cookies-from-browser` 統合(YouTube bot 検出回避) | ✅ |
| 6c | cookies.txt ファイル直接指定(ブラウザクッキー全滅環境向け、優先度: ファイル > ブラウザ) | ✅ |
| 6d | format selector 緩和 + `--js-runtimes node` 全経路適用 | ✅ |

詳細は DECISIONS.md 直近 9 エントリ(2026-05-03)を参照。

---

## 🐛 未解決バグ(明日対応)

### Bug 1: YouTube audio-first 経路で `commentAnalysisStatus.kind = 'loading'` が永続化

**症状**:URL 入力(初回 = キャッシュ無し)→ 音声 DL 完了 → ClipSelectView 開く → `コメント (0 件)` が `チャット取得中…` 表示のまま固まる。
2 回目(キャッシュ HIT)は 3531 messages 正常表示。

**再現済み**:
- URL: `https://www.youtube.com/watch?v=T6pxHw4gUzs`
- 該当ログ:今日のチャット履歴後半の DevTools console + ターミナル出力。
- main 側ログでは `[comment-debug] returning to renderer: messages=3531` まで到達している。
- renderer 側で受け取りが落ちている(or store への反映が落ちている)。

**真因仮説**(未確定):
1. App.tsx の commentAnalysis IPC `.then()` が session 一致チェックで drop されている可能性 — ただしログ上 `expectedSession` と `state.sessionId` は一致している(段階 6a の検証時点)
2. `setDuration` の drift guard が悪化させている可能性(EmbeddedVideoPlayer のポーリングが ClipSelectView の useEffect を再起動して in-flight cancel する経路) — 段階 6a で App.tsx に commentAnalysis を hoist した後の挙動を未検証
3. zustand の selective subscription が ready 状態を ClipSelectView に伝えていない可能性

**明日のアクション**:
1. dev server 再起動 → URL 入力 → 再現
2. DevTools console + ターミナルのログを取り直す(debug ログは残置済み)
3. `[comment-debug:app] commentAnalysis result received` の messages.length と `[comment-debug:store] setCommentAnalysisStatus: loading -> ready` の有無を突き合わせ
4. drop / 不到達のどこで切れてるかを確定 → 修正

### Bug 2: Twitch チャット取得 yt-dlp `--sub-langs rechat` が HTTP 404

**症状**:`https://www.twitch.tv/videos/2759886104` でコメント分析を走らせると、`downloadChatJson` の yt-dlp が 404 で終了。Twitch 側の rechat エンドポイント API 仕様変更(deprecated)疑い。

**回避策候補**(未実装):
- Twitch GraphQL `commentReplay` を直接叩く(`gql.twitch.tv/gql` への POST、Client-ID ヘッダ必要)
- chat-downloader CLI を別プロセスで呼ぶ
- yt-dlp 側にパッチ送る(コミュニティ依存、待ち時間長い)

**明日のアクション**:別タスク化(段階 7 候補)。優先度 3。GraphQL 直接実装の spike が必要。

### Bug 3: cookies.txt がプラットフォーム間で混在

**症状**:`getCookiesArgs` がプラットフォーム判定なしに `--cookies <path>` を全 yt-dlp 呼び出しに付与している。YouTube 用 cookies が Twitch リクエストに渡される。
**実害**:現状は無害(Twitch は Cookie ヘッダを単に無視するだけ)。
**整理対象**:`extractVideoId` が platform を返しているので、chatReplay.ts で「YouTube プラットフォームの時だけクッキーを渡す」ように分岐を入れる手はある。優先度低。

---

## 📉 副次:ClipSelectView の不要 re-render 爆発

`EmbeddedVideoPlayer` の `onTimeUpdate` が `setCurrentSec` を ~60 Hz で呼ぶ → ClipSelectView 全体が re-render → 子の `LiveCommentFeed` / `CommentAnalysisGraph` も re-render。
debug ログ `[comment-debug:clip] re-render` がコンソールに大量に出続ける(Bug 1 再現時のログ取得を阻害する程度)。

**対応案**:
- `currentSec` を ClipSelectView の subtree から外す(直接購読する子だけが subscribe する形にリファクタ)
- `useEditorStore(s => s.currentSec, equal)` に narrow するか、useMemo で subtree を切る

明日の優先 4(debug ログ撤去)と同じタイミングで触ると良い。

---

## 📡 回線 throttling 状況

午後の DL ベンチで明らかに遅い時間帯あり(数 MB/s しか出ない)。原因不明(プロバイダ throttling? YouTube 側 rate limit?)。
明日朝、URL 入力 → 速度確認(優先 1)で復旧してれば次の Bug 検証へ進む。1 MB/s 以下なら一旦待機 or 別 URL でテスト。

---

## 🎯 明日のタスク優先順位

| 優先 | 内容 | 完了基準 |
|---|---|---|
| 1 | **回線回復確認** | 任意の YouTube URL で audio DL 速度測定。50 MB/s 以上なら throttling 解除、2 へ。1 MB/s 以下ならテストできない、回線回復まで待機 |
| 2 | **Bug 1 真因確定 + 修正** | URL=T6pxHw4gUzs で再現 → debug ログ突き合わせ → 真因特定 → 修正 → 1 回目 / 2 回目とも正常表示確認 |
| 3 | **Bug 2(Twitch チャット 404)対応の spike** | GraphQL 直接実装の方針判断。Bug 1 解決後 or 別セッション化を判断 |
| 4 | **debug ログ一括撤去** | Bug 1 解決を確認してから。`[comment-debug:*]` を全削除、コミット |

---

## リポジトリ状態(凍結時)

- HEAD: `dda3ff2`(docs: 運用 Runbook 追加 + reseed/Q15-Q17 を全文書反映)— 6a-6d の commit はまだ作っていない
- 6a-6d の変更は **uncommitted**(ユーザの実機検証 + Bug 1 修正後にまとめてコミット予定)
- 段階 1-5 は午後の作業中に commit 済み(履歴は `git log` 参照)

`git status` 推定:
- modified: `src/common/config.ts`, `src/common/types.ts`, `src/main/config.ts`, `src/main/fileDialog.ts`, `src/main/index.ts`, `src/main/urlDownload.ts`, `src/main/commentAnalysis/index.ts`, `src/main/commentAnalysis/chatReplay.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/store/editorStore.ts`, `src/renderer/src/components/SettingsDialog.tsx`, `src/renderer/src/components/ClipSelectView.tsx`(再 render 爆発抑制で軽く触れる可能性)
- modified: `DECISIONS.md`, `TODO.md`, `NEXT_SESSION_HANDOFF.md`, `HANDOFF.md`(本タスクで更新)

---

## みのる(USER)への報告用

- **動画 DL の体感速度を大きく改善**:URL 貼って数秒で ClipSelectView を開ける(音声優先 + 埋め込みプレイヤー)
- **YouTube bot 検出 + 認証必要動画への対応**:設定で「ブラウザクッキー使用」 or 「クッキーファイル指定」を選べるようになった(優先度: ファイル > ブラウザ)
- **format selector の堅牢化**:`--js-runtimes node` 統合で「Requested format is not available」エラーが出にくくなった
- **未解決バグ 3 件 + 副次 1 件は明日対応**(優先度付け済み、再現手順 + 仮説整理済み)
- **debug ログは明日まで残置**(削除しないでくれ、と Claude にも申し送り済み)
