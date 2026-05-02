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
- [x] **複数区間選択 + 感情 9 カテゴリ + 区間色塗り + アイキャッチ枠**(`clipSegments[]` 最大 20、`eyecatches[]` 自動同期、波形に dominantCategory 別の薄い色塗り)
- [x] **操作系整理 + 常駐ライブコメントビュー**(波形 左=シーク / 右ドラッグ=区間、PeakDetailPanel 廃止、LiveCommentFeed 常駐 + 独自仮想スクロール)
- [x] **操作感改善 + 区間バー右クリックメニュー**(左クリック即時シーク / ホバー圧縮 / コメント行コンパクト化 / SegmentContextMenu)
- [x] **AI タイトル要約**(Anthropic Claude Haiku 4.5、BYOK、3 並列 + キャッシュ、ClipSegmentsList の生成ボタン)
- [x] **切り抜き候補の自動抽出**(ハイブリッド方式 + 1 ボタン全自動。アルゴリズム peak 検出 → AI 精査 → タイトル生成)
- [ ] アイキャッチの実体動画化(FFmpeg)
- [ ] 自動候補抽出ボタン(上位 N 区間)
- [ ] キーワード辞書のユーザ編集 UI
- [ ] スコア重み調整スライダー
- [ ] 編集画面での `clipSegments` 適用(動画範囲絞り込み)
- [ ] `ProjectFile` への `clipSegments` / `eyecatches` 永続化

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
- **塗り**: dominantCategory 別の薄い色塗り(両端 10% フェード gradient)+ 全体ベースの白いグラデーション(`rgba(255,255,255,0.06)`)
- **W スライダー**: 波形のすぐ上に配置(`WindowSizeSlider`)。ラベル「ウィンドウ: 2 分」+ レンジバー +「ピーク検出粒度を調整」の小注釈

### 操作系(左右クリック分離)
| 操作 | 動作 |
|---|---|
| **左クリック単発** | その時刻にシーク(再生位置移動) |
| **左ドラッグ** | ライブシーク(マウス位置に追従) |
| **右クリック+ドラッグ** | 切り抜き範囲を選択 → リリース時に **自動で `addClipSegment`**(最低 5 秒、既存区間と重複時は警告 toast) |
| **右クリック単発** | 何もしない(`onContextMenu` で `preventDefault`、コンテキストメニュー抑制) |
| **波形上の hover** | 細い縦線 + ツールチップに `[start, start+W]` 時刻 / スコア / カテゴリ別 raw 件数 / コメント数 |
| **W スライダー** | 波形がリアルタイム再描画(IPC なし、サブミリ秒) |

### 区間バーへのインタラクション(波形上の半透明バー)
- **左クリック単発(バー上)** → そこへシーク + バーを select(Delete キーで削除可)
- **バー中央ドラッグ** → 移動(隣接区間と clamp)
- **バー端 6px ドラッグ** → resize(隣接区間と clamp、最低 5 秒)

- **波形の x 座標**: 各サンプルは window 中央(`start + W/2`)を x に取る。これにより波形が時間軸の左に寄らず、画面端にも適切に伸びる

## カテゴリ分類(9 種)
リアクションを以下の 8 カテゴリ + その他に分類。波形には dominantCategory ごとの薄い色味(opacity 0.12 中央、両端 10% フェード)が乗る + ツールチップ / 詳細パネルでも raw 件数を表示:

| カテゴリ | キー | 色変数 | 用途 |
|---|---|---|---|
| 笑い | `laugh` | `--reaction-laugh` 黄色 | wwww / 草 / 笑 / 爆笑 |
| 驚き | `surprise` | `--reaction-surprise` 赤 | やばい / えぐい / ヤバすぎ |
| 感動 | `emotion` | `--reaction-emotion` 紫 | 泣ける / 感動 |
| 称賛 | `praise` | `--reaction-praise` 青 | 神 / すごい / うまい / 8888 |
| **死亡 / 失敗** | `death` | `--reaction-death` 暗赤 | 死んだ / 詰んだ / 事故 / ミス / やらかした(ゲーム実況) |
| **勝利 / 成功** | `victory` | `--reaction-victory` 金 | 勝った / 完勝 / クラッチ / GG / ナイス |
| **叫び / 大声** | `scream` | `--reaction-scream` オレンジ | あああ / ぎゃあ / うわあ / ぴえん |
| **フラグ / 察し** | `flag` | `--reaction-flag` 緑 | 死亡フラグ / 終わったな / これは死ぬ / 察し |
| その他 | `other` | `--reaction-other` グレー | 初見 / おつ |

死亡 / 勝利 / 叫び / フラグの 4 カテゴリはゲーム実況文化に踏み込んで追加(2026-05-02)。視聴者が「察する」「死亡フラグを立てる」のような感情遷移を捉えるための語彙。

### キーワードマッチ方針
- **長語先優先のソート**: `'死亡フラグ'` を `'死'` より先に判定するため `pattern.length` 降順でソートしてから走査
- **count-all 方針**: 1 つのコメントで複数キーワードがヒットした場合は **全部カウント**(`'死亡フラグ立った'` → flag x2(`死亡フラグ`+`フラグ`)+ death x1(`死亡`))。dominant は最終的に最も件数の多いカテゴリ
- **正規表現エスケープ**: `keywords.ts` の `escapeRegex` で全パターンを安全化

## 右パネル: ライブコメントビュー(`LiveCommentFeed`)

**廃止**: 旧 `PeakDetailPanel`(ピーククリックで開く詳細パネル + 「この区間を編集範囲に設定」ボタン + AI 要約スロット + カテゴリ内訳)は完全削除。動線が左クリックに集中して「シークしたいだけなのにパネルが出る」問題と、ボタン重複(「設定」「追加」「編集」)が動線分散の元になっていた。

**新設**: ClipSelectView 右側に **常駐表示** されるコメントフィード。動画全体の chat replay を時系列で並べ、`editorStore.currentSec` を購読して再生位置に追従する。

### データソース
- `CommentAnalysis.allMessages: ChatMessage[]`(`analyze()` 内で defensive sort してから返却)。バケット集計とは別ビューで、メッセージオブジェクト自体は同じ参照(重複コピーなし)。
- 数千件想定でキャッシュサイズは ~500KB 程度、`userData/comment-analysis/<id>-chat.json` と同一 TTL(チャットは immutable)。

### 仮想スクロール(独自実装)
- `ROW_HEIGHT = 60px` 固定
- 上下スペーサ div で総高さ(`messages.length * ROW_HEIGHT`)を確保
- 可視領域 +/- `BUFFER_ROWS=6` 行だけレンダリング
- 数千件でも常時 ~30 DOM ノード

### オートスクロール
- `currentSec` 変更時、現在時刻に該当する index(`findFirstAtOrAfter` 二分探索)を viewport 中央へ `scrollTo({behavior:'auto'})`
- 手動スクロール検知: `lastProgrammaticScrollTop` を記録、`onScroll` で実 scrollTop と 4px 以内なら無視 / それ以外なら autoScroll OFF
- 手動 OFF 時は「現在位置に戻る」フローティングボタンで再開、ヘッダのチェックボックスでも切り替え可

### 行のスタイル
- **現在 (`|currentSec - timeSec| <= 5`)**: 背景強調 + 左ボーダー赤(`var(--accent-danger)`)
- **過去 (`< currentSec - 5`)**: opacity 0.55
- **未来 (`> currentSec + 5`)**: opacity 0.85
- コメントクリック → そのコメント時刻にシーク

### キーワードハイライト
コメント本文のリアクションキーワードに薄い色付き下線(背景色は使わず、行密度高い場面でも読みやすい)。`SORTED_KEYWORDS`(長語先優先)で順次 split / replace。

### ヘッダ
```
[💬 コメント (1234件)]                       [☐ 自動スクロール]
```

## AI 要約スロット (次タスク)
- **エンジン**: Anthropic Claude Haiku 想定
- **入力**: 該当 window のコメント一覧
- **出力**: 「〇〇のシーンで笑いが起きています」といった簡潔な要約
- **キャッシュ**: ピークごとに一括生成し、セッション内でキャッシュ

## AI タイトル要約 — 実装版

### モデル
**Claude Haiku 4.5**(`claude-haiku-4-5`)。Anthropic Console の BYOK モデル。1 動画 30 区間で数円のコスト感、品質は切り抜きタイトルとして十分(ネタバレ歓迎の方針が Haiku の「短く決め打ち」傾向と相性良し)。

### プロンプト
```
あなたはゲーム実況・配信切り抜きの編集者です。
以下のコメント群を見て、この区間で何が起きたかを **15 文字以内のキャッチーなタイトル** で表現してください。

ルール:
- 1 行のみ、改行なし、ピリオドや句点なし
- 視聴者が「見たい」と思える表現
- ネタバレ歓迎(切り抜きタイトルなので)
- カギカッコや絵文字は使わない

コメント:
14:32 笑いすぎたかな
14:33 草www
...

タイトル:
```

期待出力例: `クラッチ展開で大盛り上がり`。`cleanTitle()` で「タイトル:」echo・引用符・句点を strip、30 文字超は truncate。

### 並列度・リトライ
- **3 並列**(`runParallel(items, 3, ...)`):20 区間でも 7 ラウンド程度で完了、Anthropic のレートには余裕
- **3 回まで指数バックオフ**:429 / 5xx に対して 2 / 4 / 6 秒。401 / 403 は即時失敗(キー無効を fast-fail)
- **per-request 30 秒タイムアウト**:`AbortSignal.timeout(30_000)` を `cancelAll()` の AbortController と `AbortSignal.any()` で結合
- コメント数 80 件超は均等サンプリング(`stride = total/80`)で先頭〜末尾の流れを保つ

### キャッシュ
`userData/comment-analysis/<videoKey>-summaries.json` に segment-key → `{ title, generatedAt }`。key は `${startSec.toFixed(2)}-${endSec.toFixed(2)}-${messages.length}` で sub-frame ドリフトを丸めた識別子。境界が同じなら 2 回目は API 呼ばずキャッシュから即返す。

### 検証エンドポイント
`validateAnthropicKey(key)` は `max_tokens: 5, "Hi"` の 1-token ping。Settings の「保存」ボタンが押された時に実 API へのアクセス可否を確認、失敗なら保存しない(キー保存後に毎回認証エラーが出るのを防ぐ)。

### UI 動線
- `Settings → Anthropic APIキー(AI タイトル生成用)` セクションでキー登録。Gladia とは別スロット
- ClipSegmentsList ヘッダの「AI でタイトル生成」ボタン(Sparkles アイコン)で全区間一括生成
- 実行中は `生成中… 3/12` ラベル、完了後は各カードの `title` フィールドに反映
- キー未設定時はボタン disabled + tooltip「設定画面で Anthropic API キーを登録してください」
- ネット切断 / 401 / 429 等のエラーは inline 赤メッセージで表示

## 切り抜き候補の自動抽出(ハイブリッド方式)

**ゴール**: ボタン 1 つで「この動画の見どころ 3-5 個」を抽出。アルゴリズム単独だと「数値の山」止まりで物語性が判定できない、AI 単独だと全コメントを投げるとコスト爆発 → **アルゴリズムで 10 個に絞り込み → AI で 3-5 個に精査** のハイブリッド。

### Stage 1: アルゴリズム peak 検出(`src/main/commentAnalysis/peakDetection.ts`)

```
1. rolling-score を全 window-start 位置で計算
   (renderer の computeRollingScores と同じ math、duplicate)
2. ローカル極大値検出(±W/2 以内で最大)
3. 候補フィルタ:
   - totalScore >= 0.30
   - 動画両端 30 秒バッファ(配信導入 / 締めを避ける)
   - 隣接候補は最低 W 離す(スコア降順 greedy non-overlap)
4. 上位 10 個を返す
```

各候補には window 内の全 `ChatMessage[]` を結合した `messages` を持たせ、Stage 2 の AI prompt に流す。

### Stage 2: AI 精査(`refineCandidatesWithAI`)

候補 10 個をプロンプトに含めて Claude Haiku 4.5 に投げる。

**選定基準**:
1. 起承転結がある(展開が完結)
2. ネタバレ的キャッチコピーがつけやすい(物語性)
3. 視聴者反応の質(感情の起伏)
4. 配信文脈に依存しない(独立性)

**避けるべき**: 配信導入 / 雑談繋ぎ / 反応が少ないが盛り上がりに見える区間 / 同じパターンの繰り返し

**コメントサンプリング(per 候補)**:
- per-author dedup(2 件まで、同一ユーザの spam 連投対策)
- 30 件まで均等サンプリング(`stride = total / 30`)で start / middle / end を均等カバー

**出力**: JSON のみ
```json
[
  {"startSec": 1500, "endSec": 1620, "reason": "...", "predictedTitle": "..."}
]
```

**バリデーション**: パース後に startSec/endSec を ±0.1 秒で候補リストとマッチング。マッチしない項目はドロップ(モデルが timestamp を hallucinate するケース対策)。

**フォールバック**: パース失敗 / API エラー / 0 件成功時は **スコア降順 上位 N** を採用、warning を渡す。

### Stage 4: タイトル生成

既存の `generateSegmentTitles` を再利用。Stage 2 の `predictedTitle` は draft / fallback、Stage 4 が「正式」タイトル。renderer は Stage 4 結果を優先、空なら predictedTitle、それも空なら null(プレースホルダ表示)。

### キャッシュ戦略

- **Stage 2 結果**: `userData/comment-analysis/<videoKey>-extractions.json`、key = `t${targetCount}-${startSec}-${endSec}-${msgLen}|...`
- 同じ候補プールで targetCount 違いは別キャッシュ
- Stage 4 結果は既存の `<videoKey>-summaries.json` に乗る

### UI

ClipSelectView ヘッダ:
```
[3個 ▼] [✨ 自動で切り抜き候補を抽出]
```

- 件数 select(3/4/5、デフォルト 3)
- ボタン disabled 条件:
  - !hasAnthropicApiKey
  - analysisState !== 'ready'
  - clipSegments.length >= 5

進捗 modal(z-index: 1000):3 step バー + 現在 phase ラベル + キャンセルボタン(`aiSummary.cancel()`)

### 開放されている設計判断
- Sonnet/Opus への切り替え UI(コスト見て判断)
- ユーザカスタムプロンプト
- 連続実行時の差分追加(現状はクリアしてから実行前提)
- 抽出区間数の上限拡張(現状 5)
- Stage 1 と renderer rollingScore の二重実装解消(common/ に共通化検討)

## 残タスク・検討事項
1. **キーワード辞書**: ユーザ編集 UI、ゲームタイトルごとのカスタムキーワード
2. **スコア重み調整 UI**: 現状ハードコード
3. **W スライダーの永続化**: 現状未対応(`.jcut.json` 保存対象外)
4. **自動候補抽出**: 上位 N 区間を自動でリスト化
5. **編集画面での範囲絞り込み**: clipSegments 外を非表示 / 自動スキップ
6. **AI タイトル自動実行**: 区間追加時に勝手に生成(現状はユーザ明示のみ)
7. **モデル選択**: Sonnet 4.6 / Opus 4.7 オプション
