# コメント分析画面 (MVP 設計)

## 概要
YouTube や Twitch のアーカイブ動画からチャットリプレイを取得し、コメント密度や視聴者数の変化、特定キーワードの出現頻度を解析して、盛り上がり箇所を可視化する機能。ユーザーはグラフを参考に、効率的に見どころ（切り抜きポイント）を発見できる。

## ステータス
- [x] UI レイヤ (グラフ表示、ツールチップ、シーク連携)
- [x] 3 フェーズ構造 (Load -> Clip Selection -> Edit) への統合
- [x] 区間選択 UI (ドラッグ & ドロップ)
- [x] バックエンド統合 (yt-dlp チャット取得 — YouTube live_chat + Twitch rechat)
- [x] スコア計算ロジック(5 秒バケット + 3 要素重み付き合成)
- [x] playboard.co での視聴者数時系列取得(ヒューリスティックパース)
- [x] ClipSelectView 結線(loading/ready/error/no-source の 4 状態)
- [ ] **次**: ClipSelectView の UI 改修(進捗表示の見た目、フォールバック時のヒント文の見た目等)
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
   - `CommentAnalysisGraph` (ヒートマップ風 UI) をドラッグして、編集したい区間 (`clipRange`) を 1 つ選択。
3. **Phase 3: Edit (編集)**
   - 選択した区間を元に文字起こし・編集を行う。
   - ヘッダからいつでも Phase 2 に戻って範囲を選び直せる。

## データ構造

### ScoreSample
各バケット（例：5秒単位）ごとの解析データ。
```ts
type ScoreSample = {
  timeSec: number;          // サンプル開始時刻
  commentDensity: number;   // コメント密度 (0..1)
  viewerGrowth: number;     // 視聴者数の増加率 (0..1)
  keywordHits: number;      // 特定キーワード出現密度 (0..1)
  total: number;            // 統合スコア (0..1)
};
```

### CommentAnalysis
動画全体の解析結果。
```ts
type CommentAnalysis = {
  videoDurationSec: number;
  bucketSizeSec: number;
  samples: ScoreSample[];
};
```

## スコアモデル (重み付け)
視聴者データの有無で重みを切替(playboard 取得失敗時は 2 要素モードに):

| モード | コメント密度 | 視聴者増加 | キーワードヒット |
|---|---|---|---|
| `playboard` 取得成功 | 0.5 | 0.3 | 0.2 |
| 取得失敗 / Twitch 等 | 0.7 | 0.0 | 0.3 |

正規化:
- `commentDensity` = bucket.commentCount / max(commentCount)
- `keywordHits` = bucket.keywordHitCount / max(keywordHitCount)
- `viewerGrowth` = max(0, bucket.viewerCount - prev.viewerCount) / max(growth)

## 現在のキーワード辞書(`src/common/commentAnalysis/keywords.ts`)

ハードコード 30 語(長語優先・正規表現プリコンパイル済み):
- 拍手・歓声: `88888888` `888888` `8888` `888` `88`
- 笑い: `wwwwwwww` `wwwwww` `wwww` `www` `ww` `草` `笑` `爆笑`
- 驚き / 称賛: `やばすぎ` `ヤバすぎ` `やばい` `ヤバい` `やば` `すごすぎ` `すげー` `すげぇ` `すごい` `すご` `神回` `神プレイ` `神` `うますぎ` `うまい` `うま`
- 感動 / 衝撃: `泣ける` `感動` `えぐい` `ぱねぇ`
- ゲーム実況: `ファインプレー` `ナイス` `クラッチ`
- 配信特有: `初見` `おつ`

## キャッシュ

| データ | パス | TTL |
|---|---|---|
| チャットリプレイ | `userData/comment-analysis/<videoId>-chat.json` | 無制限(チャットは immutable) |
| 視聴者時系列 | `userData/comment-analysis/<videoId>-viewers.json` | 無制限(取得成功時のみ書く) |

## UI 仕様
- **形状**: 5秒単位のデータを細い縦バーで表現。
- **色**: スコアに応じて変化（低: グレー / 中: オレンジ / 高: 赤）。
- **インタラクション**:
  - クリック: その時刻へシーク。
  - ドラッグ: 編集範囲を選択。
  - ホバー: 各要素の内訳をツールチップで表示。
  - 現在位置: 赤い縦線で再生位置を表示。

## 残タスク・検討事項
1. **yt-dlp 統合**: `yt-dlp --get-comments` やチャットリプレイ JSON のパース。
2. **キーワード辞書**: 「草」「かわいい」「!?」などの汎用キーワードと、ゲームタイトルごとのカスタムキーワードの管理。
3. **視聴者数データ**: Twitch は VOD メタデータに含まれるが、YouTube は別途取得方法の検討が必要。
4. **範囲の永続化**: 選択した `clipRange` を `.jcut.json` に保存。
5. **再生範囲の制限**: 編集画面で `clipRange` 外を自動スキップまたは非表示にするロジック。
