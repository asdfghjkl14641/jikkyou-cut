# データ収集 運用 Runbook

開発者 / ユーザ(みのる)向け。本格運用開始 / トラブル時の対処を網羅。

---

## 開始前チェックリスト

- [ ] アプリは `npm run dev` で起動(`npm run start` は禁止 — 古いビルドが立つ)
- [ ] API 管理画面 → API キータブで YouTube API キー登録(複数推奨、最大 50)
- [ ] 配信者リスト 75 人 確認(API 管理 → データ収集タブ → 「特定配信者リスト」)
- [ ] DB 状態確認:メニュー「**デバッグ → DB 診断(データ収集)**」→ ターミナルログで:
  - Q1 creators total: **75**
  - Q3 by creator_group: nijisanji 20 / hololive 15 / vspo 15 / neoporte 5 / streamer 20(NULL=0 が理想)
  - Q3b NULL group creators: 0 rows
  - Q4 by is_target: `[(1, 75)]` のみ
  - Q10 uploaders total: 任意の値
  - Q14 user_version: **1**
- [ ] バックアップが `userData/data-collection.db.bak.*` に複数残っとるか確認

---

## 開始

1. アプリのメニューから **API 管理** → **データ収集**タブ
2. 「自動収集: 🔴 無効」状態を確認
3. 「**有効化する**」ボタン → 確認ダイアログ → **OK**
4. ステータスが「自動収集: 🟢 有効」 + 5 秒後に「🟢 取得中…」へ遷移
5. **収集ログ**タブで `batch start` → `search per-creator "..."` 等が流れるのを確認

サイクル間隔は **2 時間**(`COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1000`)。1 サイクル ~23.75K unit 想定。50 キー × 500K/日予算で 12 サイクル/日 = 285K(57%)消費。

---

## 監視ポイント

| 指標 | 健全値 | 異常値 / 対処 |
|---|---|---|
| 1 サイクルクォータ消費 | ~25K unit | 50K 超 → broad query 増殖 / per-creator query 4 つ目以上が混入してないか確認 |
| `uploaders` 増加(/サイクル) | +50〜200 | +500 超 → broad search ヒット過多、`searchQueries.ts` 見直し |
| `creators` 件数 | 75 固定 | 増加 = **auto-add 復活バグ**、即「無効化する」 + Q17 で確認 |
| `videos.creator_id NOT NULL` 増加 | per-creator hit のみ徐々に | 急増 = `_collectBatch` の振り分け回帰 |
| ERROR ログ件数 | 0 件 / サイクル | 5 件超 → ログ内容を確認、`Could not dynamically require` 系なら build cache 疑い |
| `Q3b NULL group creators` | 0 rows | 増加 = SEED_CREATORS から漏れた seed creator、reseed が機能してない |

### 監視のトリガー

ユーザは `npm run dev` のターミナルで `[INFO] batch start` ログを目視 + 「収集ログ」タブで WARN/ERROR 件数を見る。週 1 回くらい「DB 診断」を押して件数推移を確認。

---

## トラブル時

### A. クォータ枯渇

**症状**: 全キーが 10K/key の上限到達 → `[WARN] no API key with quota available` がログに連発。

**対処**:
1. 一時的に「**無効化する**」を押して停止
2. 翌日 0 時 PT(JST 16:00 / 17:00 — DST による)以降に再有効化
3. 恒常化するなら `COLLECTION_INTERVAL_MS` を 2h → 3h に延ばす検討

### B. better-sqlite3 ロード失敗

**症状**: `Could not dynamically require ".../better_sqlite3.node"` が batch error として出る。

**対処**:
1. dev サーバ停止 → 残存 electron プロセス kill(`CLAUDE.md` 冒頭参照)
2. `out/` 削除 → `npm run dev:fresh`
3. それでもダメなら `npx @electron/rebuild -f -w better-sqlite3` を実行

### C. creators が 75 を超えてしまった(回帰)

**症状**: `[diag] Q1 creators total: 76+` / `Q17 new creators in last 1h: > 0 ⚠ AUTO-ADD REGRESSION SUSPECTED`

**対処**:
1. 即「**無効化する**」を押す + 「**取得を停止**」で進行中バッチもキャンセル
2. 「DB 診断」で `Q3b NULL group creators` を確認 — 漏れた creator の名前が分かる
3. `_collectBatch` の `upsertCreator` 呼出箇所を grep + コードレビュー(`getCreatorIdByName` 経路だけ残ってるはずだが、変更で壊した可能性)
4. 必要なら手動 SQL で削除:
   ```sql
   DELETE FROM creators WHERE created_at > '<疑わしい時刻>' AND name NOT IN ('<seed 75 名>');
   ```

### D. 特定配信者の動画が全然取れない

**症状**: 「収集ログ」に `creator "..." は全 3 クエリで 0 件 — 表記揺れ / 脱退 / 改名の可能性` の WARN が出る。

**対処**:
1. ユーザが creator name を YouTube で実際に検索(「<人物名> 切り抜き」)してヒット数確認
2. 表記揺れ:`SEED_CREATORS` の name を YouTube ヒット率高い表記に変更 → `seedOrUpdateCreators` の差分マージで反映
3. 脱退/卒業:同じく `SEED_CREATORS` から削除(creators.json 側は手動 or `creators.remove` IPC)
4. ネオポルテ等の流動箱は特に注意 — 元々警告が出やすい群

### E. 新規 video が DB に増えない

**症状**: ステータスは「🟢 取得中…」だが「動画」件数が増えない。

**対処**:
1. 「収集ログ」で `[INFO] candidates=N, new=M` を確認
2. M=0 → DB に既に同じ video が居る、新規収集なし(これは正常、長期運用後によくある)
3. M>0 だが saved=0 → `[ERROR] DB upsert failed` が無いか / yt-dlp 失敗が連発してないか確認

### F. yt-dlp が頻繁に失敗

**症状**: `failures` が `saved` を大きく上回る。

**対処**:
1. yt-dlp バイナリを更新(`resources/yt-dlp/` に最新版を配置)
2. ネットワーク状況確認(レートリミット / 一時的 ban の可能性)

---

## 停止

| 操作 | 用途 |
|---|---|
| 「**取得を停止**」 | 進行中バッチのみキャンセル、自動収集は維持(2h 後に通常通り再開) |
| 「**無効化する**」 | 永続停止、再起動後も止まったまま |

---

## バックアップ / ロールバック

- マイグレーション実行時は `migrations.ts` が自動でバックアップを作成(`data-collection.db.bak.YYMMDDTHHMMSS`)
- 手動バックアップ: dev サーバ停止 + electron プロセス kill 後、`%APPDATA%/jikkyou-cut/data-collection.db` を任意の場所にコピー
- ロールバック手順:
  1. dev サーバ停止 + 全 electron プロセス kill
  2. `data-collection.db` をリネーム(`.broken` 等)で退避
  3. 戻したい `.bak.<timestamp>` を `data-collection.db` にリネーム
  4. `npm run dev` で再起動 → migration が `user_version` を見て必要な分だけ再走

---

## マイグレーション履歴

| version | 日付 | 概要 |
|---|---|---|
| 001 | 2026-05-03 | `creators` から切り抜き投稿者を `uploaders` テーブルに分離(自動 backup + 単一トランザクション) |

実装は `src/main/dataCollection/migrations.ts`。`PRAGMA user_version` で冪等。

---

## 関連ドキュメント

- `docs/DATA_COLLECTION_DESIGN.md` — 設計書(スキーマ / 検索クエリ戦略 / クォータ計算)
- `HANDOFF.md` — プロジェクト全体のハンドオフ
- `DECISIONS.md` — 直近の意思決定ログ
- `CLAUDE.md` — 開発時の絶対ルール(`npm run dev` 必須等)
