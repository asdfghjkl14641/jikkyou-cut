# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 08:30 — 配信者リスト 75 人化(vspo + neoporte 追加 + 差分マージ)+ サイクル間隔 1h → 2h。**データ収集の有効化はユーザの操作待ち**。

## リポジトリ状態
- HEAD: `cde28b0`(feat(data-collection): seed リスト 40 → 75 拡張)
- 直後に docs コミット予定
- Working Tree: docs commit 後 clean

## 直前の状況サマリ

ユーザ精査の **配信者 75 人最終リスト**(にじ 20 + ホロ 15 + ぶいすぽ 15 新規 + ネオポルテ 5 新規 + ストリーマー 20)を seed 化し、既存 40 人 creators.json に **差分マージ** で 35 人を追加。`CreatorGroup` 型に `'vspo'` / `'neoporte'` を追加、サイクル間隔をクォータ予算に合わせて 1 時間 → 2 時間に調整。

実装は完了したが**データ収集はまだ動いていない**(`dataCollectionEnabled === false` のまま)。ユーザが API 管理画面 / Settings → 切り抜きデータ収集 で **「有効化する」を押す** 操作待ち。

### 差分マージのセマンティクス(`seedOrUpdateCreators`)

旧 `seedCreatorsIfEmpty` は creators.json が空の時だけ全投入する設計だったため、40 → 75 拡張時にユーザの手動編集や解決済み channelId が消える事故になり得た。今回それを差分マージへ進化:

1. 既存 creators.json をロード
2. SEED_CREATORS のうち既存に同名がある → 触らない(channelId / 順序保持)。**ただし既存 group が null なら seed の group を backfill**(creators.json + DB 両方、DB 側は新規 `setCreatorGroupIfNull`)
3. 既存に無い名前のみ append + DB `upsertCreator`

### グループ別人数(75 人)

| `creator_group` | 人数 |
|---|---|
| `nijisanji` | 20 |
| `hololive` | 15 |
| `vspo` | 15 |
| `neoporte` | 5(★ 柊ツルギ含む) |
| `streamer` | 20 |
| **合計** | **75** |

null group: 0 件(全 seed エントリに group タグ付き)

### クォータ見積もり(50 キー × 75 人)

| 項目 | 単価 | 件数 | 合計 |
|---|---|---|---|
| per-creator search.list | 100u | 75 × 3 = 225 | 22,500u |
| broad search.list | 100u | 11 | 1,100u |
| videos.list | 1u | ~150 | 150u |
| **1 サイクル** |  |  | **~23.75K** |
| 初回 channelId 解決(残 35 人) | 100u | 35 | +3,500u |

**サイクル間隔 2 時間**:12 サイクル/日 × 23.75K = **285K/日**(500K 予算の 57%、余裕あり)。

1 時間ごとだと 570K/日で予算超過するため `COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1000` に変更。

### 0-hit 警告(neoporte 等の流動箱対策)

creator の全 3 クエリ(切り抜き / 神回 / 名場面)で 0 件なら `logWarn` で `creator "○○" は全 3 クエリで 0 件 — 表記揺れ / 脱退 / 改名の可能性。creators.json を見直してください (group=neoporte)` を collection.log に出力。ユーザは API 管理 → 収集ログ タブで確認 + `creators.json` を手修正する想定(自動補正はしない)。

ネオポルテメンバーは spec のままで投入(柊ツルギ / 叶神あかり / 愛宮みるく / 白雪レイド / 獅子神レオナ)。**最初のバッチで警告が出たら名前を修正する作業がユーザ側に残る**。

## 主要変更ファイル(直近 = `cde28b0`)

- `src/main/dataCollection/seedCreators.ts` — `SEED_CREATORS` 75 人 + `seedOrUpdateCreators` (差分マージ)
- `src/main/dataCollection/creatorList.ts` — `CreatorGroup` に `'vspo'` / `'neoporte'` 追加
- `src/main/dataCollection/database.ts` — `setCreatorGroupIfNull` 追加
- `src/main/dataCollection/index.ts` — 0-hit warn + `COLLECTION_INTERVAL_MS` 1h → 2h
- `src/main/index.ts` — 関数名 `seedCreatorsIfEmpty` → `seedOrUpdateCreators` 切替

UI / IPC は無変更。

## 動作確認(実機 — 一部済 / 残はユーザ操作待ち)

- ✅ **既存 40 人 creators.json で起動 → 35 件追加 + group 保持**:`creators already populated (75) — no seed delta`(ホットリロードで先に行ったため、新セッションでは delta 0 で確認)。`creators.json` を Node で直読みして **75 件、group 内訳 nijisanji 20 / hololive 15 / vspo 15 / neoporte 5 / streamer 20、null group 0 件** を確認
- ⏳ **「有効化する」押下 → 最初のバッチ**:ユーザ操作待ち。`channelId` 解決(残 35 人 × 100u = 3.5K)→ per-creator × 3 クエリ → broad → enrich → upsert
- ⏳ **ネオポルテ 0-hit 警告**:最初のバッチ走らせて collection.log を見ないと判明しない。出たらユーザが creators.json 手修正

## 既知の地雷・注意点

- **ネオポルテメンバー**:流動的な箱。spec のメンバー名で投入したが、最初のバッチで `creator "○○" は全 3 クエリで 0 件` 警告が出る可能性あり。出たらユーザが「修正提案」を確認しつつ creators.json を手修正
- **「セッション内 pause / resume」の意味**:`isPaused` / `isRunning` はセッション内モード(再起動で消える)。永続的な ON/OFF は `dataCollectionEnabled` フラグの方
- **ホットリロードと seed の関係**:Vite + electron-vite は main プロセスの再ビルド時にプロセスを再起動する。今回検証では既に前回の dev サーバが 40 → 75 のマージを完了させていた。新規 install では本セッションで `seed delta: +35 new creators` ログが出る想定
- **0-hit 警告は「全 3 クエリで 0」の時のみ**:1 件でも引っかかれば警告は出ない。とはいえ 1 / 50 とかだと表記揺れの兆候だが、現状はそこまで厳しくはチェックしてない。必要なら threshold を上げる(spec の "≥ 2" など)

## 次タスク候補

1. **【ユーザ操作】**:API 管理画面 → 切り抜きデータ収集 → 「有効化する」を押す → 1 週間放置
2. データ蓄積中に CollectionLogViewer で時々確認 — 特にネオポルテメンバーの 0-hit 警告
3. 警告出た creators.json を手修正(ユーザ判断で正しい名前へ。ネオポルテは公式 X / YouTube 検索で最新メンバー名を確認)
4. **Phase 2(蓄積データ分析)**:グループ別の再生数分布 / per-creator 伸び率時系列(`video_stats_history` テーブル新設検討)/ サムネ + タイトルパターン抽出
5. **Phase 3(統合)**:`aiSummary.autoExtract` の Stage 2 プロンプトに「この配信者の伸びパターン」をコンテキスト注入

## みのる(USER)への報告用

- 配信者リスト **75 人** で完成 ✅(にじ 20 / ホロ 15 / ぶいすぽ 15 / ネオポルテ 5 / ストリーマー 20)
- 旧 40 人は **そのまま保持**(channelId / 順序が消えてない)、新規 35 人を追加するだけの差分マージで安全に拡張
- サイクル間隔は **2 時間**(クォータ予算 500K に対し 285K/日で余裕)
- ネオポルテメンバーは spec のまま投入。最初のバッチで 0-hit 警告が出る場合あり、API 管理 → 収集ログ タブで確認しつつ `creators.json` を手修正する想定
- **次の一手**:API 管理画面 → 切り抜きデータ収集 → 「**有効化する**」ボタン → 1 週間放置で 1 万件規模を目指す
