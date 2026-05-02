# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-02 23:30 — データ収集パイプライン Phase 1 完成、蓄積期間に入る前

## リポジトリ状態
- HEAD: 直近コミット直後(データ収集 Phase 1)
- Working Tree: clean

## 直前の状況サマリ

ユーザの長期構想「YouTube で実際に伸びとる切り抜き動画から、配信者ごとの伸びパターンを学習して自動抽出を強化したい」に対し、**Phase 1: データ蓄積基盤** を実装。

### 構成

`src/main/dataCollection/` に 6 ファイル新設:

| ファイル | 役割 |
|---|---|
| `database.ts` | better-sqlite3 ベース。WAL モード、5 テーブル(creators/videos/heatmap_peaks/chapters/api_quota_log)、トランザクション upsert |
| `youtubeApi.ts` | search.list + videos.list、キーローテーション、`api_quota_log` で日次クォータ管理 |
| `ytDlpExtractor.ts` | yt-dlp で heatmap + chapters + サムネ取得、`pickTopPeaks(spacing=30s)` で上位 3 ピーク + chapter title 紐付け |
| `searchQueries.ts` | 11 個のブロード検索クエリ + per-creator クエリビルダ |
| `creatorList.ts` | `userData/data-collection/creators.json` の CRUD |
| `index.ts` | DataCollectionManager(自動 5 秒後起動 + 1 時間ループ + manual trigger) |

`secureStorage.ts` に YouTube API キー(複数、BYOK)スロット追加。`userData/youtubeApiKeys.bin` に DPAPI 暗号化保存、最大 10 個。

`SettingsDialog` に 3 つ目のセクション(`DataCollectionSettings.tsx` 新設):
- ステータスパネル(動画数 / 配信者数 / 本日のクォータ / 状態 / 最終収集)— 5 秒間隔で polling
- API キー multi-input(各 password、最大 10 行)+ 「全て保存」「登録済みを全削除」
- 配信者タグ chip 一覧 + Enter で追加 + ✕ で削除
- 「今すぐ実行」「一時停止/再開」ボタン

### IPC 拡張

```ts
dataCollection.{getStats, triggerNow, pause, resume}
youtubeApiKeys.{hasKeys, getKeyCount, setKeys, clear}
creators.{list, add, remove}
```

renderer には件数だけ返し、生キーは戻さない方針(Gladia / Anthropic と同じ)。

### 起動シーケンス

`app.whenReady()` で `void dataCollectionManager.start()`。API キー未設定なら no-op で静かに skip。設定済みなら 5 秒後に最初のバッチ → 1 時間ごとに継続。

### 検証(サンドボックスで取れた範囲)

- ✅ `better-sqlite3` を `npx electron-rebuild -f -w better-sqlite3` で Electron 33 ABI(NODE_MODULE_VERSION 130)に rebuild。Node v24 (ABI 137) からは load 失敗するが、これは rebuild が正しく Electron ABI に向いた証拠
- ✅ `yt-dlp --print %(heatmap)j` の出力形式を Rick Roll URL で確認、`[{start_time, end_time, value}]` 形状(100 ポイント)を確認
- ✅ 型チェック + build 全部 clean
- ❌ 実 API 呼び出しは検証不可(API キー未保有)。1 時間放置 → 件数確認はユーザ環境で必要

## ⚠️ 実機検証が必要

サンドボックスでは API キーがないので、Phase 1 の本懐(1 週間で 1 万件蓄積)は完全に未検証。

### 次セッション最初に走らせるべき検証

1. **`npm install` が再実行された場合は `npx electron-rebuild -f -w better-sqlite3` が必要**(native module のバインディング rebuild)
2. **アプリ起動 → Settings → 切り抜きデータ収集セクションを開く** → API キー欄に Google Cloud Console で発行した YouTube Data API v3 キーを 1〜10 個入力 → 「全て保存」
3. **配信者リスト** に 3 人ほど登録(例: 葛葉 / 壱百満天原サロメ / 不破湊)
4. **「今すぐ実行」ボタンを押す** → ターミナル(`npm run dev` のコンソール)で:
   - `[data-collection] batch start`
   - `[data-collection] candidates=N, new=M`
   - `[data-collection] batch done in Xs — saved=Y, failures=Z`
   が出るか確認
5. **5 分待ってステータスパネルの動画数・クォータ消費を確認**
6. **DB 直接確認**(任意):
   ```sh
   # %APPDATA%/jikkyou-cut/data-collection.db を sqlite3 で開く
   SELECT name, COUNT(v.id) AS n FROM creators c LEFT JOIN videos v ON v.creator_id=c.id GROUP BY c.id ORDER BY n DESC;
   ```
   特定配信者ターゲットが効いてれば、その配信者の件数が多くなる
7. **サムネファイル**:`%APPDATA%/jikkyou-cut/data-collection/thumbnails/<videoId>.jpg` が並んでるはず
8. **1 時間放置** → 動画数が 200 程度増えるか確認(MAX 200/バッチ)

## 主要変更ファイル

### Backend(新規)
- `src/main/dataCollection/database.ts`(308 行)
- `src/main/dataCollection/youtubeApi.ts`(186 行)
- `src/main/dataCollection/ytDlpExtractor.ts`(170 行)
- `src/main/dataCollection/searchQueries.ts`(33 行)
- `src/main/dataCollection/creatorList.ts`(58 行)
- `src/main/dataCollection/index.ts`(216 行)

### Backend(拡張)
- `src/main/secureStorage.ts` — YouTube キー multi-slot
- `src/main/index.ts` — IPC ハンドラ + auto-start
- `src/preload/index.ts` — 3 つの新 namespace

### Frontend
- `src/renderer/src/components/DataCollectionSettings.tsx`(新規、326 行)
- `src/renderer/src/components/SettingsDialog.tsx` — 3 セクション目に組み込み
- `src/common/types.ts` — IpcApi 拡張

### Docs
- `docs/DATA_COLLECTION_DESIGN.md`(新規)
- `IDEAS.md` — Phase 1/2/3 ロードマップを追加
- `DECISIONS.md` / `TODO.md` / `HANDOFF.md` 更新

### Deps
- `better-sqlite3` + `@types/better-sqlite3` 追加
- 33 packages added; native rebuild required

## 既知の地雷・注意点

- **better-sqlite3 ネイティブ build**: `npm install` 後に `npx electron-rebuild -f -w better-sqlite3` を必ず走らせる。これを忘れると `NODE_MODULE_VERSION mismatch` でアプリが落ちる
- **クォータの初期化**: `api_quota_log.UNIQUE(api_key_index, date)` で日付が変わると自動的に新しい行に積まれる。明示的なクリアは不要
- **403 を返したキーが永遠に muted されるわけではない**: dailyDisabled set はメモリ内なのでアプリ再起動で復活する。日付が変わって自然に quota 復活する想定
- **MAX_VIDEOS_PER_BATCH = 200**: 1 時間で 200 動画の処理が間に合わなかったら次の 1 時間と被る可能性があるが、`runOneBatch` は `currentBatch` で重複防止
- **PER_VIDEO_DELAY_MS = 200**: 200 動画 × 200 ms = 40 秒分の sleep。yt-dlp プロセス自体の起動 + メタ取得が 1〜3 秒/動画なので、合計 ~10 分/バッチが目安
- **既存切り抜き動画の `view_count` 追跡**: 現状は `INSERT ON CONFLICT DO UPDATE` で上書きのみ、履歴なし。Phase 2 で `video_stats_history` テーブルを別途用意する想定

## 最初のアクション順

1. **実機検証**(上記)
2. **API キー確保**:Google Cloud Console で YouTube Data API v3 を有効化、API キー 1〜10 個発行
3. **1 週間放置で 1 万件蓄積を目指す** → DB 件数を見ながら必要に応じて配信者リスト調整
4. **Phase 2 着手準備**:蓄積データの傾向を眺めて、サムネ解析 / タイトル分析の方針を決める
5. **次タスク候補**:
   - Phase 2(蓄積データ分析)
   - アイキャッチの実体動画化(FFmpeg)
   - 編集画面 (`edit` フェーズ) で `clipSegments` を実際の動画範囲絞り込みに使う

## みのる(USER)への報告用

- データ収集パイプライン Phase 1 完成、Settings → 切り抜きデータ収集セクションで操作可能
- YouTube Data API キー登録 → 配信者リスト編集 → 自動で 1 時間ごとに収集
- DB は `%APPDATA%/jikkyou-cut/data-collection.db`、サムネは `%APPDATA%/jikkyou-cut/data-collection/thumbnails/`
- まずは API キー登録 → 「今すぐ実行」で初動確認、問題なければ 1 週間放置で 1 万件蓄積を目指す
- Phase 2(分析)/ Phase 3(自動抽出への統合)は別タスク
