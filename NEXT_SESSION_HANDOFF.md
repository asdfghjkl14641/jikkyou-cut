# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 10:30 — better-sqlite3 ネイティブ読み込みエラー調査完了(transient cache 破損、現状自然回復済み)+ 再発防止 external pin。**配信者 325 件問題の診断はこれから**(diag メニュー押下 → 結果待ち)。

## ⚠️ 次セッションの Claude Code が最初に読むこと

`CLAUDE.md` 冒頭の「アプリ起動時の絶対ルール」を厳守。`npm run start` は使わず `npm run dev` を使う。詳細は `CLAUDE.md` 冒頭参照。

`npm install` を新たに実行した場合は `npx @electron/rebuild -f -w better-sqlite3` を必ず叩く(Electron 33 ABI に向けて rebuild)。

## リポジトリ状態
- HEAD: `5160da8`(fix(build): better-sqlite3 + bindings external 明示ピン)
- 直前: `fca786a`(diag(data-collection): DB 診断スクリプト + 一時メニュー)
- docs commit 後 clean

## 直前の状況サマリ

### 今回(緊急対応):better-sqlite3 ロード失敗エラー調査

ユーザ実機の `collection.log` で「`Could not dynamically require "<root>/build/better_sqlite3.node" / @rollup/plugin-commonjs`」エラーが報告され、緊急調査。

**結論**:
- エラーは **2026-05-02 09:29Z〜10:11Z の時間帯に 7 件集中、それ以降は出ていない**(自然回復済み)
- 真因は **一時的な build cache 破損**(`bindings` が bundled された瞬間があり、rollup-commonjs の runtime stub が throw)
- 「動画 347 件 / 配信者 325 件」表示は **エラー停止後の正常 batch run で蓄積されたデータ** = データ自体は健在
- 念のため再発防止に `electron.vite.config.ts` の `main.build.rollupOptions.external` に `better-sqlite3` と `bindings` を明示ピン(`externalizeDepsPlugin` は direct deps のみ → transitive の `bindings` が漏れる可能性を物理的に潰す)

### 残タスク:配信者 325 件問題の診断(`fca786a` の diag メニュー使う)

直前の commit `fca786a` で `diagnose.ts` + 「デバッグ → DB 診断(データ収集)」メニューを投入済み。**ユーザが押すと SQL 実行結果がターミナルに出る**(9 個のクエリで creators テーブル / videos テーブル / クォータの実態確認)。

コード読みでの仮説:`_collectBatch` (index.ts:278) で broad search 由来の各 video の `channelTitle` (= 切り抜き **アップローダー**) を `upsertCreator` で auto INSERT (`is_target=0`、`creator_group=null`)。`getStats.creatorCount` は `SELECT COUNT(*) FROM creators` で全件カウントするので 75 (seed) + 250 (auto-add) = 325 と推定。これを SQL で確認すべし。

## 主要変更ファイル(直近)

### `5160da8`(緊急対応)
- `electron.vite.config.ts` — `main.build.rollupOptions.external` に `better-sqlite3` + `bindings`
- 並行で `out/` クリーン rebuild + `npx @electron/rebuild -f -w better-sqlite3` 実行(node_modules の `.node` 状態確認、rebuild は no-op で既に Electron 33 ABI に向いてた)

### `fca786a`(診断スクリプト)
- `src/main/dataCollection/diagnose.ts`(新規、readonly DB 開いて 9 クエリ実行)
- `src/main/menu.ts`(一時的に「デバッグ」サブメニュー + 「DB 診断(データ収集)」項目)

### `d79e312`(直前)
- `src/renderer/src/components/ApiManagementView.tsx` — 3 番目のタブ「データ収集」追加(DataCollectionSettings をホスト)
- `src/renderer/src/components/SettingsDialog.tsx` — DataCollectionSettings 撤去 + ハンドオフリンク 2 つに

## 動作確認

### ✅ 済
- `npm run dev` clean boot:port 3001 / `creators already populated (75) — no seed delta`
- bundle 内 `import Database from "better-sqlite3"` のみ、bindings 参照 / dynamic require stub なし

### ⏳ ユーザに依頼中
- メニュー「**デバッグ → DB 診断(データ収集)**」を押下 → ターミナル出力をチャットに貼り付け → 配信者 325 件の真因確定

## 既知の地雷・注意点

- **better-sqlite3 のネイティブ rebuild**:`npm install` 後は `npx @electron/rebuild -f -w better-sqlite3` を必ず実行(Electron ABI 不一致防止)。HANDOFF.md セクション 9 に追記済み
- **build cache 破損の再発防止**:`electron.vite.config.ts` の `external` に `better-sqlite3` + `bindings` 明示ピン。`externalizeDepsPlugin` だけに頼らない
- **collection.log の過去エラー**:09:29Z〜10:11Z の 7 件はユーザの記憶に残ってるかもしれんが、現状は問題なし(以後 INFO のみで data 蓄積成功してた)
- **「配信者 325 件」表示の真因はまだ未確定**:仮説は seed 75 + auto-add 250 だが SQL で要確認。修正方針(表示だけ直す or データモデル直す)はユーザ判断待ち
- **デバッグメニューは一時的**:`fca786a` で投入した「デバッグ」サブメニューは原因確定 + 修正完了後に削除予定。残しておくと配布版にも出てしまう

## 次タスク候補

1. **【ユーザ操作】**:メニュー「デバッグ → DB 診断(データ収集)」を押下 → ターミナル出力をチャットに貼り付け
2. 結果を見て「配信者 325 件」の真因確定 → 修正方針提示(2 案):
   - **案 A(表示だけ修正)**:`getStats.creatorCount` を `WHERE is_target = 1` に絞る(= 75 表示)。データモデルはそのまま、auto-add 250 件は内部に保持
   - **案 B(データモデル変更)**:`_collectBatch` で broad search 由来の uploader を `creators` に upsert しない。`channel_id` / `channel_name` は `videos` 内に保持、creators テーブルは seed のみに
3. ユーザ承認後、修正コミット
4. デバッグメニュー + diagnose.ts を撤去
5. **Phase 2(蓄積データ分析)**:そのまま継続

## みのる(USER)への報告用

- 「全バッチで失敗」エラー → **既に直っとる**(09:29Z〜10:11Z の時間帯のみ、以降は正常稼働)
- 真因は **一時的なビルドキャッシュ破損**。原因経路を `electron.vite.config.ts` で明示 external 化して再発防止済み
- 「動画 347 件 / 配信者 325 件」のデータは **生き残っとる**(エラー停止後の batch で蓄積された分)
- **次の一手**:メニュー「**デバッグ → DB 診断(データ収集)**」を押して、ターミナルに出る診断ログを貼り付け
- 押すと creators テーブルの内訳(seed 由来 vs auto-add 由来)が見える → 「配信者 325 件」の真因確定 → 修正方針 2 案 提示 → ユーザ判断
