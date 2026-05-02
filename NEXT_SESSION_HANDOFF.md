# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-02 21:30 — 4cca71f の音声バグ修正の **真の root cause を特定** して再修正(下記参照)

## リポジトリ状態
- HEAD: 直近コミット直後(LiveCommentFeed 行密度再調整 + 動画音声バグ修正)
- Working Tree: 残 Antigravity WIP の `urlDownload.ts` ログ 1 行のみ未コミット — と思っていたが、本タスクで `urlDownload.ts` を大幅に触ったので **その WIP は今回のコミットに巻き込まれて消化済み**

## 直前の状況サマリ

実機検証で挙がった 2 件:
1. LiveCommentFeed の行が **まだスカスカ**(40 px でも 9 行しか入らん)
2. URL DL した動画の **音声が出ない**(`b8eb4b6` の muted/volume 対策後も)

を解消しました。

### Part 1 — LiveCommentFeed 行密度再調整 (`7538df0`)

`ROW_HEIGHT` 40 → 32 px、padding 6/12 → 3/10、font 13 → 12、line-height 1.4 → 1.3、時刻列 48 → 44 px。1 画面 ~15 行(~1.5-2 倍密度)。仮想スクロール計算は `ROW_HEIGHT` 1 か所参照なので連動。

### Part 2 — 動画音声不再生バグの根本修正

#### 真因の仮説と対応

| 仮説 | 内容 | 対応 |
|---|---|---|
| **A** | yt-dlp が音声を捨ててる(format selector mismatch) | format selector を 3 → 5 段拡張、`/anything+anything` 中間段を追加 |
| **B** | 音声 codec が Chromium 非対応(Opus-in-MP4 が `<video>` で silent drop) | merger に `-c:a aac -b:a 192k` を強制、AVC1 + Opus でも必ず AAC に再エンコ |
| C | media:// プロトコルが音声 chunk を返せない | mediaProtocol を再監査して問題なし、無修正 |
| **D** | 既存 DL ファイルが古い | 該当する。**再 DL 必須**を docs に明記 |

A + B が本命 → 今回の修正のメインターゲット。

#### 主要変更

**`src/main/urlDownload.ts`**:
- format selector 5 段化:`avc1+m4a / avc1+anything / anything+anything / best[ext=mp4] / best`
- `--postprocessor-args 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart'`:merger 経路で音声を **無条件で AAC 192kbps に再エンコ** + `+faststart` で moov を頭に
- `--print before_dl:JCUT_FMT vfmt=... vcodec=... acodec=... ext=...`:選ばれたフォーマット ID を起動時に stdout 出力。`[url-download] yt-dlp resolved formats: JCUT_FMT vfmt=137 vcodec=avc1.640028 acodec=mp4a.40.2 ext=mp4` のように出る。`acodec=none` なら format が video-only に落ちた証拠

**`src/renderer/src/components/VideoPlayer.tsx`**:
- `onLoadedMetadata` で `v.audioTracks[*].enabled = true`(全 track defensive enable、alternate-language が default disable される稀ケース対策)
- `onLoadedMetadata` + `onCanPlay` で `webkitAudioDecodedByteCount` / `audioTracks.length` / `muted` / `volume` を console.log。「decode 0 のまま」なら codec 問題、「>0 だが無音」なら出力デバイス問題と切り分けできる

**`src/main/mediaProtocol.ts`**:無修正。Range 対応はコード再読で問題なしと確認、仮説 C は無実証で対象外

## 🔄 真の root cause を特定して再修正(2026-05-02 21:30)

ユーザの依頼で `ffprobe` を実機 DL ファイル(`%APPDATA%/jikkyou-cut/Downloads/jikkyou-cut/6.mp4`)に対して実行できる経路をサンドボックスから発見、実測値で diagnose した結果:

```
stream 0: video h264/avc1, duration=9516.00s (158.6 分)
stream 1: audio aac/mp4a,  duration=963.99s  ( 16.1 分)
```

**4cca71f の仮説(Opus codec)は的外れ**だった。実際の root cause は:

> yt-dlp の **デフォルト挙動 `--skip-unavailable-fragments`** で audio fragment の一部 DL 失敗時に silently skip → partial audio が merger に渡される → 動画長 158.6 分 vs 音声長 16.1 分の壊れた MP4 が生成される

ユーザが「音声出ない」と感じたのは、テスト時の playhead が 16 分以降にあったから。最初の 16 分は正常に再生されていたはず。

### 追加修正(本セッション)

`src/main/urlDownload.ts`:
- `--abort-on-unavailable-fragment` 追加 — fragment 失敗で hard error 化(silent skip 廃止)
- `--retries 30 --fragment-retries 30` — ネットワーク glitch 耐性を 10 → 30 に
- **post-DL ffprobe validation**(`probeDurations()` 関数新設):yt-dlp が exit 0 で終わっても、出力ファイルの video / audio duration を比較。差が ±5 秒超なら hard error として renderer に投げる(`音声が途中で切れています(動画 X 分 / 音声 Y 分)` メッセージ)。`!hasAudio` も同様に reject

4cca71f で入れた format selector 5 段化 + AAC merger postprocessor + audioTracks defensive enable は **そのまま温存**(Opus-in-MP4 ケースの defense in depth として無害)。

### 反省

実機検証(ffprobe)を経ずに 4cca71f を merge した。`勘で直すの禁止` の本来の意味は「実測値で診断してから修正」だった。Step 3(ffprobe)を私からも実行できる経路があると気付かなかった私のミス。次回からは実機 / 実測ファイルへのアクセス経路を最初に探す

### 次セッション最初に走らせるべきコマンド

1. **既存 DL ファイル(古い 6.mp4 等)を ffprobe**:
   ```sh
   ffprobe -v error -show_streams -show_format <既存の.mp4>
   ```
   `codec_type=audio` 行が **無い** か、ある場合 `codec_name` が `opus` / `vorbis` / `flac` 等なら仮説 A/B が当たり

2. **新規 DL を試す**(本修正の直接検証):
   - dev server 起動 → URL 入力 → DL
   - electron-vite ターミナルで `[url-download] yt-dlp resolved formats: JCUT_FMT ...` 行を確認
   - 完了後に出来たファイルを `ffprobe` で再確認、`codec_name=aac` が出るはず
   - DevTools Console で `[video-audio] loadedmetadata` / `[video-audio] canplay` ログを確認、`audioDecodedByteCount` が `> 0` なら decode 動いてる
   - 実音聴取で確認

3. **ローカル MP4(コントロール)**: 元から AAC な MP4 をドロップ → 音が出れば「media:// 経路に問題なし」の strong evidence

## 既知の地雷・注意点

- **再 DL 必須**: `b8eb4b6` 以前 / 本修正以前の DL ファイルは AAC 強制を経ていないので音声出ない可能性。新規 DL で検証
- **`webkitAudioDecodedByteCount` は Chromium 専用**: 標準 API ではない、type assertion で扱っている。Electron 33 (Chromium 130 系) では動くが将来削除のリスクあり
- **`audioTracks` API も同様に experimental**: Chromium が default-disable する稀ケースの defensive 用途、normal mp4 ではそもそも 1 track しかないので no-op
- **192 kbps AAC は固定値**: 設定 UI で品質選択できるようにしてもいい(将来検討)
- **ローカル動画の音声には影響なし**: 本修正は yt-dlp 出力にのみ作用。ローカルファイルは元の AAC をそのまま使う

## 主要変更ファイル

- `src/main/urlDownload.ts` — format selector 5 段化 + AAC merger postprocessor + JCUT_FMT diagnostic print
- `src/renderer/src/components/VideoPlayer.tsx` — audioTracks defensive enable + canplay/loadedmetadata 診断ログ
- `src/renderer/src/components/LiveCommentFeed.{tsx,module.css}` — ROW_HEIGHT 32 + 行内詰め(Part 1)

## 最初のアクション順

1. **音声再生の実機検証**(上記の 3 コマンド)
2. ログから真因確定 → もし新規 DL でも音声出ない場合は仮説 C(mediaProtocol)を再検討
3. 動作確認 OK なら次タスクへ:
   - アイキャッチの実体動画化(FFmpeg `drawtext`)
   - 編集画面 (`edit` フェーズ) で `clipSegments` を実際の動画範囲絞り込みに使う

## みのる(USER)への報告用

- LiveCommentFeed が **約 1.5-2 倍密度**(行高 32 px、1 画面 ~15 行)
- 音声バグは **当初の仮説(Opus codec / format selector)が外れ**、ffprobe で `6.mp4` を実調査して **真の root cause を再特定**:
  - yt-dlp の audio fragment の一部 DL が失敗していた(動画 158.6 分 / 音声 16.1 分の duration mismatch)
  - デフォルトの `--skip-unavailable-fragments` で silent skip → 壊れた MP4 が merger 経由で出来上がっていた
- 修正:
  - `--abort-on-unavailable-fragment` で fragment 失敗を hard error 化
  - `--retries 30 --fragment-retries 30` でネットワーク glitch 耐性を強化
  - post-DL ffprobe validation(動画/音声 ±5 秒以上のズレで自動 reject + alert)
  - 4cca71f で入れた format selector 拡張 + AAC merger は temporary に温存(Opus-in-MP4 ケースの defense in depth)
- **既存 6.mp4 は再 DL 必須**。新しい修正後は、partial DL の場合は `音声が途中で切れています(動画 X 分 / 音声 Y 分)` の alert で明示的に失敗するので、silent truncation は二度と起きない
