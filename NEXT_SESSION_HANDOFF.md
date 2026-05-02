# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 12:00 — データ収集の最終クリーンアップ(NULL group 解消 + reseed 自動化)+ 運用 Runbook 整備完了。**本格運用開始の準備が完全に整った**。あとはユーザの「有効化する」操作待ち。

## ⚠️ 次セッションの Claude Code が最初に読むこと

`CLAUDE.md` 冒頭の「アプリ起動時の絶対ルール」を厳守:
- ✅ `npm run dev` / `npm run dev:fresh` を使う
- ❌ `npm run start` 禁止(古いビルド掴む)
- `npm install` 後は `npx @electron/rebuild -f -w better-sqlite3`

## リポジトリ状態
- HEAD: `cd30fda`(fix(data-collection): NULL group の seed creator を毎起動 reseed で正常化)
- 直前: `604465d`(docs: uploaders 分離 migration 001 反映)
- docs commit 後 clean

## 直前の状況サマリ

直前タスクで完了した uploaders 分離(migration 001)後の **3 件の最終クリーンアップ**:

### 修正 1: NULL group 2 件を reseed で恒久解決

**真因**:per-creator hit 経路で旧式 3 引数 `upsertCreator(name, channelId, isTarget)` が group 引数なしで INSERT したケース(creators.json は 75 ある状態で DB 行が無い時に発生)。今は uploaders 分離後で 3 引数経路は撤廃済みだが、**過去のデータに 2 件残ってた**:

| name | 期待 group | 実際 |
|---|---|---|
| ぶゅりる | streamer | NULL |
| 剣持刀也 | nijisanji | NULL |

**解決**:`seedCreators.ts` に `reseedGroupsForExistingCreators()` 追加、`seedOrUpdateCreators` の早期 return を撤去して **毎起動必ず reseed を実行**。SEED_CREATORS を source-of-truth として `UPDATE creators SET creator_group=? WHERE name=? AND (creator_group IS NULL OR creator_group != ?) AND is_target=1` を全 75 件に対して実行。冪等(既に sync 済みなら no-op)。

実機 hot-reload で実際に 2 件 update された記録が collection.log に残ってる:
```
2026-05-02T13:05:57Z [INFO] reseed group: "剣持刀也" → nijisanji
2026-05-02T13:05:57Z [INFO] reseed group: "ぶゅりる" → streamer
2026-05-02T13:05:57Z [INFO] reseed: corrected creator_group on 2 existing creator(s)
```

post-state(Python で確認):
```
null_group: 0
by_group: {nijisanji: 20, hololive: 15, vspo: 15, neoporte: 5, streamer: 20}
```

全 75 件 group 整合済み ✅。

### 修正 2: diagnose Q3b + Q15-Q17 拡張

| ID | 内容 |
|---|---|
| Q3b | NULL group の creator 名一覧(reseed 後は 0 件想定) |
| Q15 | 直近 1h 以内に追加された videos の振り分け(creator_id / uploader_id 個別 count) |
| Q16 | 直近 1h で新規追加された uploaders 件数 |
| Q17 | 直近 1h で新規追加された creators 件数(0 期待、>0 で `⚠ AUTO-ADD REGRESSION SUSPECTED`) |

**ユーザが「1 回だけ取得」を押した後、デバッグメニュー → DB 診断 を押せば一目で auto-add 回帰検出可能**。

### 修正 3: 運用 Runbook (`docs/DATA_COLLECTION_OPS.md`)

新規ファイル。本格運用開始前 / トラブル時の対処を網羅:
- 開始前チェックリスト(キー登録 / 配信者 75 / DB 診断結果 / バックアップ)
- 開始手順
- 監視ポイント表(指標と健全 / 異常値の判別)
- トラブル対処 6 種(クォータ枯渇 / better-sqlite3 / creators 増加 / 配信者ヒットなし / 新規 0 件 / yt-dlp 失敗)
- バックアップ / ロールバック手順
- マイグレーション履歴

## 主要変更ファイル(直近 = `cd30fda`)

- `src/main/dataCollection/seedCreators.ts` — `reseedGroupsForExistingCreators()` 追加、`seedOrUpdateCreators` の早期 return 撤去
- `src/main/dataCollection/diagnose.ts` — Q3b + Q15-Q17 追加
- `docs/DATA_COLLECTION_OPS.md`(新規)

## 動作確認(実機ベース)

### ✅ 済
- 全 75 件 group 整合(Python で確認、null=0)
- reseed の冪等性(2 回目以降は no-op、ログに何も出ない)
- migrate 001 + reseed 連携(seedOrUpdateCreators の最後で reseed 実行)
- TypeCheck + build clean
- dev サーバ起動成功(`bn389ctzj`、port 3001)

### ⏳ ユーザに依頼中
- メニュー「**デバッグ → DB 診断(データ収集)**」を押下 → 全 14+ クエリの結果を確認
- API 管理 → データ収集タブ → 「**1 回だけ取得**」を押す → 1 サイクル走らせる
- 完了後にもう一度「DB 診断」 → Q15(videos with uploader > 0、with creator はゼロ近辺)+ Q16(>0)+ Q17(=0)を確認
- 問題なければ「**有効化する**」で本格運用開始

## 既知の地雷・注意点

- **uploaders 分離 + reseed の組み合わせ**:`_collectBatch` は uploader / creator 振り分けが分離済み + 起動時 reseed が integrity を維持。auto-add 回帰の経路は物理的に閉じてる
- **reseed の頻度**:現状毎起動。SEED_CREATORS 75 件 × UPDATE 1 文 = 75 回の prepared statement 実行。SQLite では数 ms。問題なし
- **Q17 ⚠ 警告**:1 サイクル後に「DB 診断」を押した時点で creators が増えてれば即 ⚠ が出る。出たら `_collectBatch` のリグレッションを疑う
- **デバッグメニュー残置**:Phase 2 着手後 / 安定運用確認後に撤去予定。Runbook にも記載
- **過去の手動バックアップ**:`data-collection.db.bak.20260502T123359` (migration 自動)+ `data-collection.db.bak.20260502T212737` (タスク開始前手動)を保持

## 次タスク候補

1. **【ユーザ操作 1】**:アプリ → API 管理 → デバッグ → DB 診断 押下 → ターミナル出力チェック(Q3b NULL group=0 / Q14 user_version=1 が確認できれば OK)
2. **【ユーザ操作 2】**:API 管理 → データ収集 → 「1 回だけ取得」→ 完了待ち → もう一度 DB 診断 → Q15-Q17 で振り分け正常 + Q17=0 確認
3. **【ユーザ操作 3】**:問題なければ「有効化する」で本格運用開始 → 1 週間放置
4. 1 週間後:Phase 2(蓄積データ分析)着手判断
5. 安定運用が確認できたら デバッグメニュー + diagnose.ts を撤去

## みのる(USER)への報告用

- **NULL group 2 件解消** ✅(ぶゅりる→streamer、剣持刀也→nijisanji)
- 全 **75 人 group 整合済み**(にじ 20 / ホロ 15 / ぶいすぽ 15 / ネオポルテ 5 / ストリーマー 20)
- **毎起動 reseed** で SEED_CREATORS を source-of-truth として DB を自動整合(冪等、no-op fastpath)
- **diagnose Q15-Q17 で auto-add 回帰の自動検出** が可能に(Q17=0 期待、>0 で警告)
- **運用 Runbook** を `docs/DATA_COLLECTION_OPS.md` に整備(チェックリスト / 監視 / トラブル対処)
- **次の一手**:アプリ → デバッグ → DB 診断 押下で全項目確認 → 「1 回だけ取得」で動作テスト → 問題なければ「**有効化する**」で本格運用開始
