# コメント分析画面 (MVP 設計)

## 概要
YouTube や Twitch のアーカイブ動画からチャットリプレイを取得し、コメント密度や視聴者数の変化、特定キーワードの出現頻度を解析して、盛り上がり箇所を可視化する機能。ユーザーはグラフを参考に、効率的に見どころ(切り抜きポイント)を発見できる。

スコアの基本単位は「**ウィンドウ幅 W で何分続く塊として盛り上がっているか**」。ユーザはグラフ上のスライダーで W=30 秒〜5 分を可変にでき、波形はその瞬間の量ではなく「W 分にわたって持続した盛り上がり」を直接表す。

## ステータス
- [x] UI レイヤ (グラフ表示、ツールチップ、シーク連携)
- [x] 3 フェーズ構造 (Load -> Clip Selection -> Edit) への統合
- [x] 区間選択 UI (ドラッグ & ドロップ)
- [x] バックエンド統合 (yt-dlp チャット取得)
- [x] スコア計算ロジック(瞬間スコア・初期実装)
- [x] YouTube Most replayed 風 UI + カテゴリ色分け + 詳細パネル
- [x] playboard.co での視聴者数時系列取得(ヒューリスティックパース)
- [x] ClipSelectView 結線(loading/ready/error/no-source の 4 状態)
- [x] **rolling window スコア + W スライダー UI**(5 要素・Stage 1/2 分離)
- [ ] AI 要約スロット実装 (Claude Haiku)
- [ ] 自動候補抽出ボタン(上位 N 区間)
- [ ] 区間複数選択
- [ ] キーワード辞書のユーザ編集 UI
- [ ] スコア重み調整スライダー
- [ ] 編集画面での範囲絞り込み反映

## アプリケーションフロー (3-Phase)

1. **Phase 1: Load (動画読み込み)**
   - `DropZone` でファイル選択または URL 入力。
2. **Phase 2: Clip Selection (範囲選択)**
   - `ClipSelectView` で動画をプレビュー。
   - `WindowSizeSlider` で rolling window 幅 W を調整(30 秒〜5 分)。
   - `CommentAnalysisGraph` をドラッグして、編集したい区間 (`clipRange`) を 1 つ選択。
3. **Phase 3: Edit (編集)**
   - 選択した区間を元に文字起こし・編集を行う。
   - ヘッダからいつでも Phase 2 に戻って範囲を選び直せる。

## データ構造

### RawBucket (Stage 1 出力)
W 非依存のバケット単位の生集計。main で 1 回作って renderer に渡す。
```ts
type RawBucket = {
  timeSec: number;                              // バケット開始時刻
  commentCount: number;                          // バケット内のコメント数
  keywordHits: number;                           // 反応キーワードヒット総数
  categoryHits: Record<ReactionCategory, number>;// カテゴリ別 raw 件数
  messages: ChatMessage[];                       // バケット内コメント
  viewerCount: number | null;                    // 視聴者数(playboard 失敗時 null)
};
```

### ScoreSample (Stage 2 出力)
W ごとの rolling window スコア。renderer で W スライダー変更のたびに再計算。
```ts
type ScoreSample = {
  timeSec: number;          // ウィンドウ start 時刻
  windowSec: number;        // どの W で計算されたか
  density: number;          // 平均コメ密度(window-avg max で正規化済み 0..1)
  keyword: number;          // 平均キーワード(同上 0..1)
  continuity: number;       // 持続率(中央値以上のバケット割合 0..1)
  peak: number;             // ピーク強度(window 内 max / 動画全体 max 0..1)
  retention: number;        // 視聴者維持率(window 内 min/max 0..1、サンプル無しは 0.5)
  total: number;            // 5 要素の重み付き合成 0..1
  dominantCategory: ReactionCategory | null;
  categoryHits: Record<ReactionCategory, number>;  // window 内合計(raw 件数)
  messageCount: number;                            // window 内コメント数
};
```

### CommentAnalysis
```ts
type CommentAnalysis = {
  videoDurationSec: number;
  bucketSizeSec: number;
  buckets: RawBucket[];      // Stage 1 結果
  hasViewerStats: boolean;   // playboard 取得成否(重み切替に使用)
  chatMessageCount: number;
  generatedAt: string;
};
```

## スコアモデル(rolling window 数式)

```
切り抜きスコア(t, W) =
   wD × 平均コメント密度(t..t+W)
 + wK × 平均キーワードヒット(t..t+W)
 + wC × 持続率(t..t+W)
 + wP × ピーク強度(t..t+W)
 + wR × 視聴者維持率(t..t+W)
```

### 重み

playboard 取得成功時:
| 要素 | 重み |
|---|---|
| 平均コメント密度 | 0.35 |
| 平均キーワードヒット | 0.20 |
| 持続率 | 0.20 |
| ピーク強度 | 0.10 |
| 視聴者維持率 | 0.15 |

playboard 取得失敗時(`viewers.source === 'unavailable'`):
| 要素 | 重み |
|---|---|
| 平均コメント密度 | 0.45 (+0.10) |
| 平均キーワードヒット | 0.25 (+0.05) |
| 持続率 | 0.20 |
| ピーク強度 | 0.10 |
| 視聴者維持率 | 0.00 |

### 各要素の定義

| 要素 | 計算式 | 正規化 |
|---|---|---|
| **平均コメント密度** | `sum(commentCount in window) / W` | 動画全体の window 平均最大値で 0..1 |
| **平均キーワードヒット** | `sum(keywordHits in window) / W` | 動画全体の window 平均最大値で 0..1 |
| **持続率** | window 内のバケットのうち `commentCount >= 動画全体の中央値` の割合 | そのまま 0..1(割合) |
| **ピーク強度** | `max(commentCount in window) / 動画全体の max(commentCount)` | そのまま 0..1 |
| **視聴者維持率** | `min(viewers in window) / max(viewers in window)` | そのまま 0..1。window 内に viewer サンプル無い場合は **0.5 fallback** |

#### 視聴者維持率の補足
- 「**ウィンドウ内で何 % の視聴者が残っていたか**」を表す
- 1.0 に近い = 視聴者がほぼ抜けてない = 引きが強い
- 配信全体の右肩上がり/下がりトレンドに引きずられない指標
- 0.5 fallback はサンプル sparseness 対策(0 にすると total が不当に滑落する)

### なぜ「増加率(growth)」でなく「維持率」を選んだか
旧スコアでは前バケットとの差分の正の値(`viewerGrowth`)を使っていたが:
- 配信開始直後の指数的な視聴者増加に過剰に引きずられる
- 配信終盤の自然減衰でスコアが沈黙する
- 「window 内で人が抜けたか残ったか」は「window 内で人が増えたか」より切り抜き判断に直結する

## ウィンドウ可変設計

### バケットサイズ
**5 秒バケット維持**(720 バケット = 1 時間動画)。rolling 計算のコストは O(buckets * bucketsPerWindow) で 17,280 ops 程度、サブミリ秒。スライダー操作は体感即時。

### W スライダー(`WindowSizeSlider`)
- 範囲: 30 秒 〜 300 秒(5 分)
- ステップ: 30 秒
- 初期値: 120 秒(2 分)
- 永続化: なし(プロトタイプ範囲、ファイル切替でリセット)

### Stage 1 / Stage 2 分離

| Stage | 場所 | コスト | 入力 | 出力 |
|---|---|---|---|---|
| 1: bucketize | main(IPC 越し 1 回) | チャット取得 + playboard 取得 + bucket 集計 | url + duration | `CommentAnalysis { buckets[] }` |
| 2: computeRollingScores | renderer(W 変更ごと) | sliding window 集計 + 正規化 | buckets + W + hasViewerStats | `ScoreSample[]` |

**意図**: スライダー操作で IPC 往復を起こさない。Stage 2 は renderer 側で完結するので、W を動かしても波形再描画はメインスレッドの一拍ぶんで終わる。

## 現在のキーワード辞書(`src/common/commentAnalysis/keywords.ts`)

ハードコード、長語優先・正規表現プリコンパイル済み。カテゴリ別:
- 笑い(laugh): `wwwwwwww` `wwwwww` `wwww` `www` `ww` `草` `笑` `爆笑`
- 驚き(surprise): `やばすぎ` `ヤバすぎ` `やばい` `ヤバい` `やば` `えぐい`
- 感動(emotion): `泣ける` `感動`
- 称賛(praise): `すごすぎ` `すげー` `すげぇ` `すごい` `すご` `神回` `神プレイ` `神` `うますぎ` `うまい` `うま` `ナイス` `ファインプレー` `クラッチ` `88888888` `888888` `8888` `888` `88`
- その他(other): `初見` `おつ`

## キャッシュ

| データ | パス | TTL |
|---|---|---|
| チャットリプレイ | `userData/comment-analysis/<videoId>-chat.json` | 無制限(チャットは immutable) |
| 視聴者時系列 | `userData/comment-analysis/<videoId>-viewers.json` | 無制限(取得成功時のみ書く) |

## UI 仕様 (YouTube Most replayed 風)

- **波形**: 滑らかな白い曲線 1 本(`stroke-width: 1.2`, `rgba(255, 255, 255, 0.45)`)。`hover` / `active` 時に `rgba(255, 255, 255, 0.75)` までバンプ
- **塗り**: 波線の下に薄い白のグラデーション(`rgba(255,255,255,0.06)` から透明へ)
- **マーカー**: 常時表示のドットマーカーは廃止
- **W スライダー**: 波形のすぐ上に配置(`WindowSizeSlider`)。ラベル「ウィンドウ: 2 分」+ レンジバー +「ピーク検出粒度を調整」の小注釈
- **インタラクション**:
  - **ホバー**: 該当位置に細い縦線。ツールチップに `[start, start+W]` の時刻範囲・スコア・カテゴリ別 raw 件数・コメント数
  - **クリック**: total >= 0.5 のサンプルでは詳細パネル展開、それ以外はシーク
  - **ドラッグ**: 範囲選択(薄い白のオーバーレイ)
  - **W 変更**: 波形がリアルタイム再描画(IPC なし、サブミリ秒)
- **波形の x 座標**: 各サンプルは window 中央(`start + W/2`)を x に取る。これにより波形が時間軸の左に寄らず、画面端にも適切に伸びる

## カテゴリ分類
リアクションを以下の 4 カテゴリ + その他に分類。波形には直接表示せず、ツールチップおよび詳細パネルでのみ可視化する:
- **笑い (laugh)**: 黄色 (`--reaction-laugh`)
- **驚き (surprise)**: 赤色 (`--reaction-surprise`)
- **感動 (emotion)**: 紫色 (`--reaction-emotion`)
- **称賛 (praise)**: 青色 (`--reaction-praise`)
- **その他 (other)**: グレー (`--reaction-other`)

## 詳細パネル(`PeakDetailPanel`)
ピーククリックで展開。表示内容:
- AI 要約(プレースホルダ、Claude Haiku で次タスク)
- カテゴリ内訳(window 内 raw 件数)
- コメント一覧(`[sample.timeSec, sample.timeSec + sample.windowSec)` の bucket から `useMemo` で集める)
- 「この区間を編集範囲に設定」ボタン → `clipRange = { start: sample.timeSec, end: sample.timeSec + sample.windowSec }` で edit フェーズへ

## AI 要約スロット (次タスク)
- **エンジン**: Anthropic Claude Haiku 想定
- **入力**: 該当 window のコメント一覧
- **出力**: 「〇〇のシーンで笑いが起きています」といった簡潔な要約
- **キャッシュ**: ピークごとに一括生成し、セッション内でキャッシュ

## 残タスク・検討事項
1. **AI 要約**(上記)
2. **キーワード辞書**: ユーザ編集 UI、ゲームタイトルごとのカスタムキーワード
3. **スコア重み調整 UI**: 現状ハードコード
4. **W スライダーの永続化**: 現状未対応(`.jcut.json` 保存対象外)
5. **自動候補抽出**: 上位 N 区間を自動でリスト化
6. **区間複数選択**: 現状 1 区間のみ
7. **編集画面での範囲絞り込み**: clipRange 外を非表示 / 自動スキップ
