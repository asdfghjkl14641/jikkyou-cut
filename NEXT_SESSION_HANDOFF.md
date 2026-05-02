# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 07:30 — 配信者 40 人 seed 投入 + 検索クエリ多角化 + channelId 自動解決完了。**データ収集の有効化はユーザの操作待ち**。

## リポジトリ状態
- HEAD: `16535eb`(feat(data-collection): 配信者 40 人 seed 投入 + 検索クエリ多角化 + channelId 自動解決)
- 直後に docs コミット予定(本ファイル + DECISIONS.md + TODO.md + HANDOFF.md + DATA_COLLECTION_DESIGN.md)
- Working Tree: docs commit 後 clean

## 直前の状況サマリ

ユーザ精査の **配信者 40 人**(VTuber 25 + ストリーマー 15)を seed 化し、初回起動時に `creators.json` + DB へ自動投入する仕組みを実装した。検索クエリも 1 → 3 へ多角化、channelId は初回バッチで自動解決して永続化。

実装は完了したが**データ収集はまだ動いていない**。ユーザが API 管理 / Settings 画面で **「有効化する」を押す** 操作が必要(`dataCollectionEnabled` フラグ、デフォルト `false` を尊重)。

### 追加した設計レイヤ

| 名前 | 役割 |
|---|---|
| `SEED_CREATORS` | `seedCreators.ts` 内の literal 40 人定数。`group` フィールドで `'nijisanji'\|'hololive'\|'streamer'` にタグ付け |
| `seedCreatorsIfEmpty()` | `app.whenReady` で 1 回呼ぶ。`creators.json` が空の時のみ投入(冪等)。同時に DB の `creators` テーブルへ `upsertCreator(name, null, true, group)` |
| `resolveCreatorChannelIds()` | バッチ先頭で呼ばれる。`channelId === null` の creator のみ `search.list type=channel`(100u/人)で解決して `creators.json` + DB に persist。一度解決したら fastpath で skip |
| `buildPerCreatorQueries(name)` | `[<name> 切り抜き, <name> 神回, <name> 名場面]` を返す。manager は creator × 3 クエリループ |
| `creator_group` カラム | `creators` テーブルに追加(`migrateSchema()` で `PRAGMA table_info` チェック後 `ALTER TABLE ADD COLUMN`、既存 DB に冪等)。Phase 2 のグループ別集計用 |

### クォータ見積もり(50 キー想定、500K 日次)

| 項目 | 単価 | 件数 | 合計 |
|---|---|---|---|
| per-creator search.list | 100u | 40 × 3 = 120 | 12,000u |
| broad search.list | 100u | 11 | 1,100u |
| videos.list | 1u | ~150 | 150u |
| **1 サイクル** |  |  | **~13.25K** |
| 初回のみ channelId 解決 | 100u | 40 | +4,000u |

1 時間ごと 24 サイクル/日 = 318K → 500K 予算で余裕。

### 上書き安全性

`upsertCreator(name, channelId, isTarget, group?)` の挙動:
- INSERT: 全フィールド書く
- UPDATE: `channel_id = COALESCE(?, channel_id)`、`is_target` 上書き、**`creator_group` は触らない**

→ random clip uploader の per-video upsert で seed creator の group が消えることはない。

### app.whenReady() の起動順序

```
1. nativeTheme.themeSource = 'dark'
2. handleMediaProtocol()
3. buildMenu(...)
4. registerIpcHandlers()
5. createWindow()
6. seedCreatorsIfEmpty()  ← NEW (空の時のみ 40 人投入)
7. dataCollectionManager.start()  ← dataCollectionEnabled === true なら
```

### バッチの先頭順序

```
1. resolveCreatorChannelIds()  ← NEW (channelId 未解決のみ search.list 100u/人)
2. per-creator search × 3 クエリ
3. broad search × 11 クエリ
4. videoExists で dedup
5. fetchVideoDetails (videos.list)
6. yt-dlp で heatmap / chapters / サムネ
7. upsertVideoFull
```

## 主要変更ファイル(直近 = `16535eb`)

- `src/main/dataCollection/seedCreators.ts`(新規、40 人 + helpers)
- `src/main/dataCollection/database.ts`(creator_group カラム + migration + upsertCreator group 引数)
- `src/main/dataCollection/creatorList.ts`(CreatorEntry.group 追加)
- `src/main/dataCollection/searchQueries.ts`(buildPerCreatorQueries 3 クエリ化)
- `src/main/dataCollection/youtubeApi.ts`(searchChannelByName 追加)
- `src/main/dataCollection/index.ts`(manager: resolveChannelIds + 多角化ループ)
- `src/main/index.ts`(seed wiring)

UI / IPC は無変更 — 既存の `creators.add` / `list` / `remove` は後方互換で動く。

## 動作確認(ユーザ実機 — 操作待ち)

1. **空 creators.json で起動** → 起動時に `[data-collection] seeding creators.json with 40 entries` ログ → API 管理画面の配信者リスト UI に 40 人並ぶ
2. **既に creators.json がある状態で再起動** → `[data-collection] creators already populated (N) — skipping seed` ログで skip
3. **「有効化する」ボタン押下** → 5 秒後にバッチ開始 → `[data-collection] resolved channelId for ...` × 40 → `[data-collection] search per-creator "葛葉 切り抜き" → N items` 等が順次流れる
4. **2 回目以降のバッチ** → channelId 解決は no-op fastpath、search のみ走る

## 既知の地雷・注意点

- **既存 install で creators.json に手動データがある場合**:seed は **発火しない**(冪等)。group タグも付かない。Phase 2 集計で「未分類」として現れる前提で OK
- **channel 検索の精度**:`searchChannelByName` は first hit を返すヒューリスティック。同名 channel が複数ある場合は誤マッチ可能性。ログで「resolved channelId for ...」を見ながら、明らかに違うものはユーザが手動で `creators.json` を編集する想定
- **クエリ追加でクォータ誤算**:現状は 13.25K/サイクル想定。クエリを 4 つ目以上に増やしたい時は `searchQueries.ts` の `buildPerCreatorQueries` だけ触れば OK、見積も `DATA_COLLECTION_DESIGN.md` のテーブルを更新
- **`upsertCreator` の group 引数**:default が `null`。INSERT 時のみ反映、UPDATE 時は touch しない。これを破ると random uploader が seed creator を上書きする回帰になるので注意

## 次タスク候補

1. **【ユーザ操作】**:API 管理画面 → 切り抜きデータ収集 → 「有効化する」を押す → 1 週間放置
2. データ蓄積中に CollectionLogViewer で時々確認(ERROR 赤色頻発なら原因特定)
3. **Phase 2(蓄積データ分析)**:
   - グループ別(にじさんじ / ホロ / ストリーマー)再生数分布
   - サムネ + タイトルパターン抽出
   - per-creator の伸び率時系列(現状は最新 view_count しか持ってないので `video_stats_history` テーブル新設を検討)
4. **Phase 3(統合)**:`aiSummary.autoExtract` の Stage 2 プロンプトに「この配信者の伸びパターン」をコンテキスト注入

## みのる(USER)への報告用

- 配信者 **40 人**(にじさんじ 15 / ホロライブ 10 / ストリーマー 15)を seed 投入完了 ✅
- per-creator クエリを「切り抜き / 神回 / 名場面」の **3 角化**
- channelId は初回バッチで自動解決(40 × 100u = 4K のみ、以降 0)
- 1 サイクル ~13.25K、50 キー × 500K 日次予算で余裕
- グループ別タグ(`creator_group`)を DB に保持、Phase 2 でグループ比較に使える
- **次の一手**:API 管理画面 → 切り抜きデータ収集 → 「**有効化する**」ボタン → 1 週間放置で 1 万件規模を目指す
