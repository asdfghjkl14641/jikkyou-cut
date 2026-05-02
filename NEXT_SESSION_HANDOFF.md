# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 11:30 — uploaders テーブル分離 + creators 純化(migration 001)完了。データモデル整備済み。**データ収集の有効化はユーザの操作待ち**。

## ⚠️ 次セッションの Claude Code が最初に読むこと

`CLAUDE.md` 冒頭の「アプリ起動時の絶対ルール」を厳守:
- ✅ `npm run dev` / `npm run dev:fresh` を使う
- ❌ `npm run start` は禁止(古いビルドを実行する)
- `npm install` 後は `npx @electron/rebuild -f -w better-sqlite3` を必ず叩く

## リポジトリ状態
- HEAD: `280ad6c`(feat(data-collection): uploaders テーブル分離 + creators 純化)
- 直前: `03960ef`(docs: better-sqlite3 ロード失敗の調査結果)
- docs commit 後 clean

## 直前の状況サマリ

直前タスクの DB 診断で creators が「seed 75 + 切り抜き投稿者 250 = 325」と確定していた件を、**データモデル分離で根本修正**。

### 新スキーマ(2 テーブル分離)

| テーブル | 内容 | 件数 |
|---|---|---|
| `creators` | seed 配信者のみ(`is_target=1`)+ `creator_group` で分類 | 75 |
| `uploaders`(NEW) | 切り抜き動画の投稿チャンネル(channel_id / video_count キャッシュ) | 252 |
| `videos.creator_id` | per-creator 検索由来の動画のみ非 null | 3 |
| `videos.uploader_id`(NEW 列) | 全動画に紐付け | 347 |

### Migration 001 の挙動

`src/main/dataCollection/migrations.ts` の `runMigrations()` を `app.whenReady` から `seedOrUpdateCreators` の前に呼ぶ。

- `PRAGMA user_version` で冪等性管理(target=1)
- 実行前:WAL checkpoint(TRUNCATE) → タイムスタンプ付き .bak 作成
- 単一トランザクションで:
  1. uploaders + indexes 作成 + videos.uploader_id 列追加
  2. videos.channel_name の DISTINCT を uploaders へ一括投入
  3. is_target=0 creators で videos に出てこない孤児も移送
  4. videos.uploader_id を channel_name JOIN で backfill
  5. videos.creator_id を NULL(is_target=0 由来分)
  6. is_target=0 creators を DELETE
  7. uploaders.video_count を再集計

### 収集ロジック修正

`_collectBatch`(index.ts):
- broad-search 由来の `upsertCreator(channelTitle, ...)` 経路を **撤廃**
- 各 video について `upsertUploader(channelId, channelName)` で uploader 登録 + `bumpUploaderVideoCount` で video_count 加算
- per-creator hint ありの video のみ `getCreatorIdByName` で creator_id 解決(broad は creator_id = NULL)

### UI 表示

`DataCollectionSettings` のステータスパネル:
```
動画                  : 347
配信者(seed)        :  75
切り抜きチャンネル    : 252
本日のクォータ        : 33,000 / 500,000
自動収集              : 🔴 無効  [有効化する]
状態                  : ⏸ 待機中
```

### 実機検証結果(Python sqlite3 で直接確認)

```
user_version: 1
creators total: 75
creators by is_target: [(1, 75)]    ← 全て is_target=1
creators by group: hololive=15, neoporte=5, nijisanji=19, streamer=19, vspo=15, NULL=2
uploaders total: 252                 ← 全て channel_id 解決済み
videos uploader_id NOT NULL: 347     ← 全動画 OK
videos creator_id NOT NULL: 3        ← per-creator 由来のみ
videos total: 347                    ← データ消失なし
```

バックアップ:
- `data-collection.db.bak.20260502T123359`(migration 自動生成、UTC ts)
- `data-collection.db.bak.20260502T212737`(着手前の手動 backup、JST ts)

## 主要変更ファイル(直近 = `280ad6c`)

- `src/main/dataCollection/migrations.ts`(新規、`runMigrations()` + migration 001)
- `src/main/dataCollection/database.ts`(`upsertUploader` / `bumpUploaderVideoCount` / `getCreatorIdByName` 追加、`VideoUpsert.uploader_id` 列、`getStats` 拡張)
- `src/main/dataCollection/index.ts`(`_collectBatch` の broad-search auto-add を撤廃、uploader 登録に切替)
- `src/main/dataCollection/diagnose.ts`(Q10-Q14 追加 — uploaders / video link / user_version)
- `src/main/index.ts`(`runMigrations()` を `app.whenReady` の seed step 前に呼ぶ)
- `src/common/types.ts`(`uploaderCount` を IPC 戻り値に追加)
- `src/renderer/src/components/DataCollectionSettings.tsx`(「配信者(seed)」/「切り抜きチャンネル」表示)

## 既知の地雷・注意点

- **`creators` の NULL group 2 件**:`creator_group` が NULL の creator が 2 つ存在(本来 nijisanji 20 / streamer 20 のはずが 19 / 19 + NULL 2)。原因不明、別タスクで調査 — Settings UI の手動 add 由来か、name の表記揺れで seed match に失敗してる可能性。Phase 2 集計には影響なし(group filter で is_target=1 → 73 + uncategorised 2 として扱える)
- **migration の rollback**:現状はコードでは戻せない。`.bak.<timestamp>` を `.db` にリネームで手動復元可。dev サーバを止めてからやる必要あり
- **デバッグメニュー残置**:`fca786a` で投入した「デバッグ → DB 診断」は引き続き利用可能。Phase 2 着手後に撤去予定
- **uploader と creator のクロス参照**:配信者本人がアップロードした切り抜きの場合、creator も uploader も同じ人。現状はそれぞれ独立行で持つ(`creators.channel_id` と `uploaders.channel_id` が一致するケースは Phase 2 でクロス分析時に検出)
- **per-creator 由来の動画が 3 件と少ない**:今までの batch run で per-creator search 経由で取れた video が 3 件しかない、という意味。これは **元 DB の状態**で、broad search 経由が大半だったため。今後 batch を回せば per-creator 由来も増える

## 次タスク候補

1. **【ユーザ操作】**:アプリ起動 → Settings → 切り抜きデータ収集 → 「**有効化する**」を押す → 1 週間放置
2. 1 サイクル後に「DB 診断」を再度実行して、**新規収集分が uploaders に正しく入るか**確認(broad-search 由来なのに creators に入る回帰がないこと)
3. `creators` の NULL group 2 件の調査(seed 名を確認 + Settings UI で group 補完するか、自動 backfill するか)
4. **Phase 2(蓄積データ分析)**:
   - グループ別(にじさんじ / ホロ / vspo / neoporte / ストリーマー)再生数分布
   - 上位 uploader が伸ばす動画の特徴(タイトルパターン / サムネ)
   - per-creator × per-uploader のクロス分析
5. デバッグメニュー + diagnose.ts の最終撤去(Phase 2 着手後)

## みのる(USER)への報告用

- データモデル分離 ✅
  - 配信者(seed): **75 人**(なくならず保持)
  - 切り抜きチャンネル: **252 個**(新テーブルへ自動移送)
  - 動画: **347 件**(全部 uploader 紐付け済み、データ消失なし)
- バックアップ自動生成 + 手動 backup 両方確保
- UI に「切り抜きチャンネル」表示追加(配信者 75 と分離して見える)
- **次の一手**:Settings → 切り抜きデータ収集 → 「**有効化する**」を押して 1 週間放置 → Phase 2 着手判断
