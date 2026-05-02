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
| `creators` | 配信者(配信者名 / channel_id / is_target フラグ) |
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

### Per-creator
`creators.json` に登録された各人物名で「<人物名> 切り抜き」を 50 件取得。targeting されたバケットの方が値が高いので、バッチの先頭で per-creator → broad の順に走らせる(クォータが先に枯れるなら per-creator 側だけは確実に消費する)。

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

10 キー × 10K units/day = 100K/day。1 バッチで `search.list` × (per-creator + broad) ≈ (creators.length + 11) × 100 units、`videos.list` ≈ ceil(MAX_VIDEOS/50) × 1 unit。50 配信者 + 11 broad = 6100 units / 200 動画なら 4 unit → 1 バッチ ~6.1K units。1 日 16 バッチ走らせて約 100K units、ちょうどキャップに収まる。

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
