# 切り抜き動画データ収集パイプライン

## ゴール

「YouTube で実際に伸びとる切り抜き動画」のメタデータを、配信者ごとのパターンを学習できる粒度で蓄積する基盤を作る。Phase 2(分析)+ Phase 3(自動抽出統合)への入力データを生成する役割。

## アーキテクチャ概要

```
[アプリ起動]
    │
    ├─ DataCollectionManager.start() を whenReady で呼ぶ
    │   API キー未設定なら no-op
    │
    └─ 5 秒後に最初のバッチ → 1 時間ごとに継続
        │
        ▼
    [collectBatch]
        │
        ├─ Step 1: per-creator 検索 + broad 検索 で動画 ID プール構築
        ├─ Step 2: DB と突き合わせて新規 ID のみフィルタ(既存は skip)
        ├─ Step 3: videos.list で stats 取得(50 ID 単位、1 unit/call)
        ├─ Step 4: 各 ID で yt-dlp 実行 → heatmap + chapters + サムネ
        ├─ Step 5: heatmap から上位 3 ピーク抽出 + chapter title 紐付け
        └─ Step 6: SQLite トランザクションで一括 upsert
```

## SQLite スキーマ

ファイル: `userData/data-collection.db`(WAL モード、`synchronous = NORMAL`)

5 テーブル:

| テーブル | 役割 |
|---|---|
| `creators` | 配信者(配信者名 / channel_id / is_target / `creator_group`(`'nijisanji'\|'hololive'\|'streamer'\|null`)) |
| `videos` | 切り抜き動画のメタデータ + 統計 + サムネパス + raw API レスポンス |
| `heatmap_peaks` | 各動画の上位 3 ピーク(start/end/value/chapter_title) |
| `chapters` | 動画のチャプター(全件、Phase 2 でタイトルパターン分析に使う) |
| `api_quota_log` | キーごとの日次クォータ消費量(`UNIQUE(api_key_index, date)`) |

主要インデックス:
- `idx_videos_view ON videos(view_count DESC)` — Phase 2 で「再生数上位」を即引きできるように
- `idx_videos_creator ON videos(creator_id)` — per-creator 集計用

## 検索クエリ戦略

### Broad(11 クエリ)
切り抜き / クリップ / 神回 / VTuber / にじさんじ / ホロライブ / マイクラ / APEX / ストリートファイター / ゲーム実況 / 面白い場面 — それぞれを `relevance` 順 + 50 件取得。`relevance` を選んだ理由:`viewCount` 単独だと evergreen 巨大クリップが永遠に上位を占めて新規流入が止まる。

### Per-creator(seed 40 人 + ユーザ追加)

`creators.json` に登録された各配信者に対し、3 クエリを発射(`buildPerCreatorQueries`):

```
<人物名> 切り抜き
<人物名> 神回
<人物名> 名場面
```

YouTube のアルゴリズムは同義句に対しても異なる動画を返す傾向があり、1 クエリでは長尾(伝説回 / 名シーン等のラベリング揺れ)を取りこぼすため。3 クエリ × 40 人 = 120 search.list = 12,000 units/サイクル(50 キー × 10K = 500K 日次予算で十分)。

#### Seed リスト(2026-05-03 拡張、75 人)

| グループ | 人数 | 内訳 |
|---|---|---|
| `nijisanji` | 20 | 葛葉 / 叶 / 不破湊 / イブラヒム / 加賀美ハヤト / 壱百満天原サロメ / 笹木咲 / 椎名唯華 / 月ノ美兎 / でびでび・でびる / 渋谷ハジメ / ローレン・イロアス / 健屋花那 / 剣持刀也 / ジョー・力一 / 三枝明那 / レオス・ヴィンセント / ヴォックス・アクマ / ルカ・カネシロ / 西園チグサ |
| `hololive` | 15 | 兎田ぺこら / 宝鐘マリン / 湊あくあ / さくらみこ / 戌神ころね / 猫又おかゆ / 大空スバル / 白上フブキ / 星街すいせい / 沙花叉クロヱ / 角巻わため / 大神ミオ / 不知火フレア / 雪花ラミィ / 桃鈴ねね |
| `vspo` | 15 | 一ノ瀬うるは / 橘ひなの / 英リサ / 藍沢エマ / 八雲べに / 神成きゅぴ / 紫宮るな / 花芽すみれ / 花芽なずな / 兎咲ミミ / 空澄セナ / 小雀とと / 白波らむね / 如月れん / 夢野あかり |
| `neoporte` | 5 | 柊ツルギ(★)/ 叶神あかり / 愛宮みるく / 白雪レイド / 獅子神レオナ |
| `streamer` | 20 | 加藤純一 / もこう / 兄者弟者 / 釈迦 / StylishNoob / SHAKA / ありさか / ボドカ / k4sen / 関優太 / スタヌ / うるか / だるまいずごっど / 渋谷ハル / ta1yo / ぶゅりる / ぎぞく / gorou / Selly / 蛇足 |

`src/main/dataCollection/seedCreators.ts` に literal で持つ。`seedOrUpdateCreators()` が `app.whenReady` で呼ばれ、**差分マージ** で投入:
- 既存名は触らず保持(channelId / 順序保持、null group のみ backfill)
- 新規名のみ append + DB upsertCreator
- ユーザが Settings UI で追加した creators は `group: null`(uncategorised)

ネオポルテは流動的な箱なので、最初のバッチで 0-hit ログ警告が出たらユーザが creators.json を手修正する想定(自動補正はしない)。

#### channelId 自動解決

seed 時点では channelId が null。バッチ先頭で `resolveCreatorChannelIds()` が呼ばれ、null の creator のみ `searchChannelByName(name)`(`search.list type=channel`、100u/人)で解決して `creators.json` + DB に persist。一度解決したら fastpath で skip するので、定常状態のコストは 0。初回バッチのみ +4,000 units(40 人未解決)。

targeting されたバケットの方が値が高いので、バッチの先頭で per-creator → broad の順に走らせる(クォータが先に枯れるなら per-creator 側だけは確実に消費する)。

## API キーローテーション + クォータ管理

`userData/youtubeApiKeys.bin`(DPAPI 暗号化、JSON 配列を 1 ファイルに)に最大 10 個のキーを格納。renderer には件数だけ返す方針(BYOK 既存パターン踏襲)。

`ApiKeyRotator` クラスがキー選択を担当:
1. ラウンドロビンの cursor から開始
2. `api_quota_log` から今日の消費量を読んで、`used + estimatedCost <= 10000` なら採用
3. 全キー枯れ → null を返す → caller(`searchVideos` / `fetchVideoDetails`)が「skip」する
4. 403/401 を返したキーは即時 dailyDisabled set に追加(翌日まで mute)

### コスト
| API | 単価 |
|---|---|
| `search.list` | 100 units |
| `videos.list` | 1 unit / call(最大 50 ID/call) |
| `channels.list` | 1 unit |

**現行(2026-05-03 08:30、50 キー × 75 人想定)**:

| 項目 | 単価 | 件数 | 合計 |
|---|---|---|---|
| per-creator search.list | 100u | 75 × 3 = 225 | 22,500u |
| broad search.list | 100u | 11 | 1,100u |
| videos.list | 1u | ~150 | 150u |
| **1 サイクル** |  |  | **~23.75K** |
| 初回のみ channelId 解決(残 35 人) | 100u | 35 | +3,500u |

サイクル間隔 **2 時間**(`COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1000`)で 12 サイクル/日 × 23.75K = **285K/日**。50 キー × 10K = 500K 日次予算に対し約 57% 消費、403/quota-exceeded リトライや一時的な未解決チャンネルの ad-hoc クエリ用に余裕あり。

1 時間サイクルだと 24 × 23.75K = 570K/日 で予算超過するため、75 人化に合わせて 1h → 2h に調整した。

**履歴(参考)**:
- 初版(10 キー × 50 人 × 1 クエリ):6.1K/サイクル × 16 サイクル = 約 100K/day。
- 多角化(50 キー × 40 人 × 3 クエリ):13.25K/サイクル × 24 サイクル = 318K/day。
- 現行(50 キー × 75 人 × 3 クエリ、2h サイクル):23.75K/サイクル × 12 サイクル = 285K/day。

## yt-dlp 抽出

1 動画 1 回の `yt-dlp --skip-download --print` で全部取る:
- `id`, `title`, `channel`, `channel_id`, `view_count`, `like_count`, `comment_count`, `duration`, `upload_date`, `description`, `heatmap`, `chapters`

サムネは `--write-thumbnail --convert-thumbnails jpg` で `userData/data-collection/thumbnails/<id>.jpg` に保存。

### 上位 3 ピーク選定

`pickTopPeaks(heatmap, chapters, spacingSec=30)`:
1. value 降順ソート
2. greedy non-overlap:既選択ピークの centre から 30 秒以内のものは skip
3. 上位 3 個取得 → 時刻昇順で返す
4. 各ピークの centre が含まれる chapter の `title` を紐付け(なければ null)

heatmap が `NA`(古い動画 / プライベート / ストリームアーカイブ)の動画は peaks 配列が空。chapters のみ保存される。

## DB upsert ロジック

`upsertVideoFull(args)` は単一トランザクションで:
1. `videos` を `INSERT ... ON CONFLICT(id) DO UPDATE`(同じ id なら統計だけ更新、`thumbnail_path` は既存が NULL の時のみ上書き)
2. その動画の `heatmap_peaks` / `chapters` を全削除
3. 新しい peaks / chapters を一括 INSERT

「再収集 → 完全置換」のシンプルなモデル。Phase 2 で「視聴回数の時系列」が必要になったら、`video_stats_history` テーブルを別途追加する想定(現状は `videos.view_count` を上書きするだけ、履歴なし)。

## エラーハンドリング

| 失敗ケース | 挙動 |
|---|---|
| API キー全枯れ | `searchVideos` / `fetchVideoDetails` が空配列を返す → 当該バッチは少ない結果で完了。次の 1 時間後に再試行 |
| yt-dlp 取得失敗(削除済み等) | スキップ + warn ログ。失敗カウンタが 5 件 + 全件スキップだったら 5 分クールダウン |
| heatmap が NA | peaks 配列を空で保存、chapters は別途保存 |
| ネットワークエラー | 単発失敗は warn して次へ。連続失敗なら 5 分クールダウン |
| DB ロック | better-sqlite3 のトランザクションで自動 retry |

## ログフォーマット

`userData/data-collection/collection.log`(append-only):

```
2026-05-02T12:34:56.789Z [INFO]  batch start
2026-05-02T12:35:15.123Z [WARN]  yt-dlp failed: video unavailable (videoId=abc123)
2026-05-02T12:35:30.456Z [ERROR] API quota exceeded for key 3
```

- ISO 8601 UTC タイムスタンプ + `[LEVEL]`(7 文字 padding)+ メッセージ
- `logger.ts` の `logInfo` / `logWarn` / `logError` で出力。コンソールエコーも残る
- 単一 promise chain で append を sequence(Windows での torn line 防止)
- `logReader.ts` が末尾 N 行を読み出してパース、canonical 以外の legacy line は INFO で吸収

## API 管理画面

メニュー「API 管理」(`Ctrl+Shift+A`)→ `ApiManagementDialog`。タブ式で 2 ページ:

### タブ 1: API キー
- **Gladia** / **Anthropic** / **YouTube** の 3 セクション
- 各セクションに `登録済み / 未登録` 表示 + Edit ボタン(inline 展開)+ Delete ボタン(`window.confirm` で誤操作防止)
- YouTube のみ:per-key クォータバー(5 秒間隔 polling)、複数キー入力(最大 10 個)

### タブ 2: 収集ログ
- フィルタボタン(All / INFO / WARN / ERROR)+ 件数バッジ
- 自動更新トグル(5 秒間隔)+ 手動更新ボタン
- 「ファイルを開く」ボタン:`shell.openPath` で OS 既定エディタ
- 仮想スクロール(ROW_HEIGHT 26、BUFFER_ROWS 12)で 5000+ 行でも軽量
- stick-to-bottom 挙動(20px 以内なら新規追記に追従、上にスクロールすると追従停止)

`SettingsDialog` から API キー部分は完全削除。代わりに「API 管理画面を開く」ハンドオフボタンのみ。

## ライフサイクル

- **start**: `app.whenReady()` 内で `dataCollectionManager.start()`。API キー未設定なら no-op
- **pause/resume**: Settings UI のボタンから IPC 経由
- **triggerNow**: 手動でオフサイクル 1 バッチ。既に走っとる時は現行 Promise を返す

## Phase 2 / 3 への接続点

### Phase 2(分析)
- `videos.thumbnail_path` を画像処理ライブラリに渡してサムネ構図解析
- `videos.title` のトークン化 → タイトル語彙頻度
- `heatmap_peaks.chapter_title` の集計 → どんな chapter 名のシーンが上位ピークになりやすいか
- `(view_count, published_at)` から「伸び率 = views / days_since_published」を算出
- 配信者(creators)単位で per-creator パターンを抽出

### Phase 3(統合)
- `aiSummary.autoExtract` の Stage 2 プロンプトに「この配信者の伸びパターン」をコンテキスト注入
- 同じ動画でも配信者が変われば違う候補が浮上する仕組み

## 実装ステータス

- [x] better-sqlite3 + 5 テーブルスキーマ
- [x] secureStorage 拡張(YouTube キー BYOK)
- [x] youtubeApi.ts(search.list / videos.list + キーローテーション)
- [x] ytDlpExtractor.ts(heatmap + chapters + サムネ + 上位 3 ピーク)
- [x] DataCollectionManager(自動 5 秒後起動 + 1 時間ループ)
- [x] IPC + Settings UI(API キー / 配信者リスト / ステータス)
- [ ] ⚠️ 実機検証(API キー登録 → 1 時間放置 → DB 件数確認)
- [ ] Phase 2(分析)
- [ ] Phase 3(自動抽出への統合)
