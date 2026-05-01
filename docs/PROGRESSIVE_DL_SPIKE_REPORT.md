# プログレッシブ DL + 並行文字起こし 技術検証レポート

## 検証環境

- 日付: 2026-05-02
- yt-dlp: 2026.03.17(同梱バイナリ `resources/yt-dlp/yt-dlp.exe`)
- Node: Electron 33 同梱
- Electron: 33
- ffmpeg: 8.1(システム導入済み)
- テスト URL: 短尺 YouTube 公開動画(プラットフォーム = YouTube、長さ 19 秒)+ format リスト確認は同 URL の `-F` 出力

## 論点 1: yt-dlp シーク追従 DL

### A. `--download-sections "*X-Y"` で範囲指定 + 連結

#### 結果: ✅ 動く(連結も lossless 可能)

#### 生ログ抜粋

```
$ yt-dlp ... --download-sections "*0-10" -o "part0-10.%(ext)s" --merge-output-format mp4 ...
C:\Users\Sakan\AppData\Local\Temp\jcut-spike\part0-10.mp4

$ yt-dlp ... --download-sections "*10-19" -o "part10-19.%(ext)s" ...
C:\Users\Sakan\AppData\Local\Temp\jcut-spike\part10-19.mp4

$ ffprobe part0-10.mp4 → duration=10.067 (no force-keyframes)
$ ffprobe part10-19.mp4 → duration=9.000

$ ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4
[aost#0:1/copy] Non-monotonic DTS; ... changing to 441345.
$ ffprobe joined.mp4 → duration=19.023, size=774555
```

#### 結論

- 別プロセス + 別範囲 + 別出力ファイル = 動作する
- ffmpeg `-c copy` で **再エンコードなし** で連結可能(non-monotonic DTS 警告は出るが再生 OK)
- `--force-keyframes-at-cuts` は exact-second cut を保証するが **再エンコード必須**(数秒〜分単位の追加コスト)。プログレッシブ DL では外す方が現実的(GOP 境界に丸め込まれる代わりに高速)
- 弱点: 各 yt-dlp 起動には YouTube format extraction の固定コスト(~3-4 秒)があるので、頻繁にシークされると追従が重い

### B. HLS モード横取り(`--hls-prefer-native`)

#### 結果: ❌ YouTube VOD は HLS を提供しない

#### 生ログ抜粋

```
$ yt-dlp -F https://www.youtube.com/watch?v=...
ID  EXT  RESOLUTION FPS CH | FILESIZE  TBR PROTO | VCODEC  ...
139 m4a  audio only      2 |  ...      ... https | audio only ...
140 m4a  audio only      2 |  ...      ... https | audio only ...
137 mp4  1920x1080  25    |  ...      ... https | avc1 ...
...

# grep -iE "hls|m3u8" → 0 件
# --hls-prefer-native → 効果なし(HLS フォーマットが存在しない)
```

#### 結論

- YouTube **アーカイブ動画**(`/watch?v=...`)は全ての format が DASH(`mp4_dash` / `webm_dash`、PROTO=`https`)
- HLS m3u8 を横取りしてセグメント単位処理するアプローチは **YouTube に対しては不可**
- Twitch VOD は HLS なので将来検討可能(`--hls-prefer-native` が効く)— が、現スコープ外

### C. 二重プロセス + 結合(= 1A の運用形)

#### 結果: ✅ 1A の応用で実装可能

#### 結論

- 1A の検証で連結は動作するので、運用シナリオは:
  - メイン yt-dlp: `--download-sections "*0-"` で先頭から逐次 DL
  - 補助 yt-dlp(seek 時): `--download-sections "*<target>-"` で seek 先以降を別プロセス DL
  - 結合: ユーザがその区間を要求した時に動的に concat、または DL 完了後に最終 concat
- **問題**: メイン yt-dlp の出力ファイルが「途中まで再生可能か」は **論点 2** の制約に従う(下記)

### 推奨アプローチ

**A + C の組み合わせ**(1A の `--download-sections` を「メイン DL = `*0-`、補助 DL = `*seekTarget-`」の二系統で運用)。HLS は YouTube では使えないので除外。`--force-keyframes-at-cuts` は付けない(再エンコードコストが大きいため、GOP 境界の数フレームのズレは許容)。

## 論点 2: `<video>` の buffered 動的拡張

### A. 既存 mediaProtocol.ts 流用

#### 結果: ❌ ファイル拡張に追従しない

mediaProtocol.ts は `fs.stat(filePath).size` を **リクエスト毎に評価** するが、ブラウザは初回 200 OK の `Content-Length` をキャッシュする。yt-dlp が DL を進めてファイルが伸びても `<video>` は気付かず、後半の `Range: bytes=N-` 要求は 416 で蹴られる。

### B. MediaSource API + chunked feed

#### 結果: ✅ 推奨

- Electron Renderer は `MediaSource` を使える(Chromium 同等)
- yt-dlp 出力を ffmpeg に pipe → `-movflags frag_keyframe+empty_moov+default_base_moof` で **fragmented MP4** を生成
- 各 fragment(数秒の `moof+mdat` 単位)を main → renderer に IPC で投げ、renderer は `SourceBuffer.appendBuffer()` で連結
- ffmpeg で `noforce-0-10.mp4` → `frag_keyframe+empty_moov+default_base_moof` 化を実施、`format_name=mov,mp4,m4a,3gp,3g2,mj2` で出力されることを確認(=構造は維持される)
- シーク超過時: 現在のソースバッファをクリア、新しい `-ss <target>` の ffmpeg pipe を起動、バッファを再構築
- 課題: codec 初期化バイト(`avcC` / `mp4a` の `extradata`)を最初に送る必要がある、SourceBuffer は単一 codec のみ対応(audio + video は別バッファ)

### C. 既存 mediaProtocol を改造して growing-file 対応

#### 結果: ⚠️ 動くが脆弱

- `Content-Length` を duration から推定する大きな値で先回り報告
- Range 要求が現在のファイルサイズを超えたら **long-poll で待機**(到達したら返す)
- ブラウザのタイムアウト(数十秒〜分)に当たるリスクあり
- シーク先優先 DL の差し込みが難しい(ファイルが sequential 前提)

### 推奨アプローチ

**B(MediaSource + IPC fragmented MP4 feed)**。エンジニアリングコストは大きいが、ユーザ要望「YouTube みたいなシーク」を真に満たせるのはこれだけ。fMP4 の生成は ffmpeg 1 行で済むことを実機確認済み。

## 論点 3: Gladia 並行文字起こし

### A. `/v2/pre-recorded` の chunked 対応

#### 結果: ❌ 完全な audio_url 前提

公式ドキュメント `https://docs.gladia.io/api-reference/v2/pre-recorded` 確認:
- `audio_url` は **完全な音声/動画ファイルへの URL**
- chunked upload / multipart / streaming は documented されていない
- duration の上限は未明記だが pre-recorded は **完成品向け**

### B. `/v2/live` WebSocket でリアルタイム

#### 結果: ✅ 利用可能

公式ドキュメント `https://docs.gladia.io/api-reference/v2/live` 確認:
- POST `/v2/live` → WebSocket URL + session ID 取得 → WebSocket 接続
- 受け付ける音声: PCM (8/16/24/32-bit)、A-law、μ-law。サンプリング 8000-48000 Hz、最大 8ch
- **Partial transcripts**(option、デフォルト OFF)/ **Final transcripts**(デフォルト ON)
- `endpointing` で utterance 完了の無音検知時間を 0.01-10 秒で設定可能(最大 60 秒で強制完了)

### C. ffmpeg で「現在 DL 済み範囲の音声」を逐次抽出

#### 結果: ⚠️ 動くが制約あり

- non-fragmented MP4 は moov atom が **末尾** にあるので、DL 中の partial mp4 は ffmpeg で読めない
- fragmented MP4 (`-movflags frag_keyframe+empty_moov+default_base_moof`)なら moov 相当が先頭、各 fragment が self-contained → 逐次抽出可能
- audio-only DL(format `140` = `m4a`)は単独でも progressive(`mp4` だが faststart 化済み or fragmented で配信されることが多い)→ 音声だけ先行 DL する戦略はアリ

### 推奨アプローチ

**MVP: B(`/v2/live` WebSocket)を使う**。

理由:
- `/v2/pre-recorded` のチャンク戦略(C 系)は cue タイムスタンプの offset 計算 + upload/poll サイクルのレイテンシで結局リアルタイム感が出ない
- `/v2/live` なら音声が PCM frame で WebSocket に流れた瞬間から partial cue が返る → 真に編集と並行
- 音声経路: yt-dlp の format `140`(m4a)を先行 DL → ffmpeg `-f s16le -ar 16000 -ac 1` で PCM 化 → WebSocket に push
- 既存 `gladia.ts` は `/v2/pre-recorded` 専用なので、`gladiaLive.ts` を新設する形

ただし MVP のスコープ次第:
- 「とりあえず DL → 文字起こし」レベルで満足なら `/v2/pre-recorded` のままで良い(B-strategy chunk 化は不要)
- 「DL 中も文字起こし結果が見える」を本気でやるなら `/v2/live`

## 論点 4: プロセス管理

### 検証

既存 `cancelDownload`:
```ts
export async function cancelDownload(): Promise<void> {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}
```

単一プロセス前提 — 並行 DL の管理には不足。

### 想定アーキテクチャ

```
[Renderer]
  ↓ IPC: progressiveDl.start({ url })
[Main: ProgressiveDLManager]
  ├─ Primary DL Process
  │    yt-dlp --download-sections "*0-" → primary-stream.mp4
  ├─ Secondary DL Process(seek 時のみ)
  │    yt-dlp --download-sections "*<seekTarget>-" → secondary-stream.mp4
  ├─ Fragmented MP4 Pipe
  │    ffmpeg -i primary-stream.mp4 -movflags frag_keyframe+empty_moov+default_base_moof
  │      -f mp4 - → IPC → Renderer MediaSource
  ├─ Audio Pump(/v2/live 採用時)
  │    ffmpeg -i primary-stream.mp4 -f s16le -ar 16000 -ac 1 -
  │      → WebSocket /v2/live
  └─ Process Registry
       Map<processId, { kind, range, child }>
       cancelById / cancelAll / cancelByRange
```

#### 必要な capabilities

- 全プロセスを ID 付きで track(Map<string, ChildProcess>)
- Cancel by ID / cancel all / cancel by URL
- Seek 追従時のオーバーラップ検知:既存 secondary が target を内包していれば再利用、外れていれば kill して新規 spawn
- 各プロセスのエラーは個別に renderer へ surface(1 つ落ちても session 全体は止めない)
- Cleanup: kill 後に `.part` ファイルを sweep する finally ブロック必須

#### 想定エッジケース

- ユーザ連打 seek → secondary を毎回 kill/respawn は重い → 200ms debounce 推奨
- primary が secondary の target に追いついた瞬間 → secondary を kill、ファイル概念を統合
- App quit 時:全プロセス kill + .part 削除を `before-quit` で確実に
- WebSocket(Gladia /v2/live)切断時の reconnect ロジック

## 提案アーキテクチャ(全体像)

```
┌──────── Renderer ────────────────────────────────────────────┐
│ DropZone → URL submit                                         │
│   ↓                                                           │
│ Phase 2 (clip-select) へ即遷移                                │
│   ├─ <video> with MediaSource                                 │
│   │    ├─ SourceBuffer (video, avc1)                          │
│   │    └─ SourceBuffer (audio, mp4a)                          │
│   ├─ CommentAnalysisGraph(既存)                              │
│   └─ "全部一気に DL" ボタン → mode 切替                       │
└──────────────────────────────────────────────────────────────┘
              ↑ IPC: { fragments, transcriptCues }
┌──────── Main: ProgressiveDLManager ──────────────────────────┐
│ State: { url, mode: 'progressive'|'fullDL', primary, secondary, audioPump } │
│                                                               │
│ start(url):                                                   │
│   primary = spawn yt-dlp --download-sections "*0-" -o tmp.mp4 │
│   pipe = spawn ffmpeg -i tmp.mp4 (or -i pipe:0) -movflags frag│
│           → stdout → IPC stream to renderer                   │
│   audioPump = spawn ffmpeg -i tmp.mp4 -f s16le -ar 16000 -    │
│           → WebSocket to /v2/live                             │
│                                                               │
│ onSeek(targetSec):                                            │
│   kill secondary if any                                       │
│   secondary = spawn yt-dlp --download-sections "*targetSec-"  │
│   restart fragmented pipe at targetSec offset                 │
│                                                               │
│ onModeFullDL():                                               │
│   kill primary, kill secondary                                │
│   spawn yt-dlp normal full DL                                 │
│   primary = "all-in-one DL", drop fragmented pipe             │
│                                                               │
│ cancel(): kill all processes, cleanup .part files             │
└──────────────────────────────────────────────────────────────┘
              ↑ Gladia WebSocket
┌──────── External: Gladia /v2/live ───────────────────────────┐
│ Receives PCM frames (16-bit, 16kHz, mono)                    │
│ Emits partial + final cues                                    │
└──────────────────────────────────────────────────────────────┘
```

## 残課題 / リスク

### 致命的リスク

1. **YouTube DL は別ストリーム + マージ前提**(1080p AVC1 では `137`(video) + `140`(audio) を別々に DL してから merge)。merge 前は再生可能ファイルが存在しない。
   - 対策: yt-dlp 出力を ffmpeg にパイプして fragmented MP4 にリアルタイム変換、それを MediaSource で feed。Tee mode 必須(ファイルにも書きつつ stdout にも流す)

2. **YouTube format extraction overhead** は spawn 毎に 3-4 秒固定。頻繁な seek でこれが積み重なる
   - 対策: 一度取得した format URL を cache、または seek を 300ms debounce

3. **MediaSource SourceBuffer の再構築** はシーク時に必要。バッファクリア → codec init → fragment 再投入の流れがエラーに弱い
   - 対策: SourceBuffer を作り直す方が安全(`removeSourceBuffer` + `addSourceBuffer`)

### 中リスク

4. **ffmpeg fragmented MP4 のキー frame 単位** = 数秒 GOP 単位の DL/再生粒度。秒単位の精密シークは初動でカクつく可能性
5. **Gladia /v2/live のコスト** が `/v2/pre-recorded` と異なる可能性(billing model 確認必要)
6. **`/v2/live` が日本語対応十分か** は実機検証必要(API は対応うたうが、partial transcripts の品質は別)
7. **disk usage**: primary stream + fragmented pipe + audio pump で同じデータが 3 系統流れる可能性 → メモリ/ディスク負荷の検証必要

### 低リスク

8. **Twitch VOD は HLS** なので別実装が必要(MVP では YouTube のみ)
9. **AV1/VP9 高画質は引き続き切り捨て**(現在の方針継続)
10. **Cancel race**: yt-dlp kill 直後に `.part` を rm すると Windows でファイルロックエラーが出るケースあり → small retry loop

## 実装フェーズ提案

### Phase A: 「DL 後再生」 → 「DL 中 360p 再生」(最小限の動くもの)

- yt-dlp に `-f 18`(360p 単一 muxed stream)を一時的に併用
- ファイル拡張通知 IPC + mediaProtocol で `Content-Length` を growing-aware に(論点 2C 寄り)
- DL 完了時に高画質版に source 切替
- **コスト感**: 2-4 日(現在の流れに「parallel 360p preview DL」を追加するだけ)
- **得られる UX**: DL 中も 360p で内容確認可能、切り抜き範囲決定はできる

### Phase B: MediaSource パイプ(本命)

- ffmpeg fragmented MP4 pipe + IPC stream + Renderer MediaSource
- ProgressiveDLManager 雛形(primary + secondary、cancel/seek)
- Phase A の 360p preview を撤去
- **コスト感**: 1-2 週間(MediaSource の seek/error handling が泥沼化しがち)
- **得られる UX**: 1080p AVC1 を真の YouTube ライク再生 + シーク追従 DL

### Phase C: Gladia /v2/live 並行文字起こし

- audio pump (ffmpeg PCM) → WebSocket → partial cues IPC → editorStore
- 既存の `gladia.ts` は維持(完了後の post-DL 文字起こしや「全部一気に DL」モード用)
- **コスト感**: 3-5 日(WebSocket 安定運用 + 日本語精度確認)
- **得られる UX**: DL 進行と同時に文字起こしが流れ込む、配信 1 時間目の編集を 2 時間目 DL 中に開始できる

### 推奨段階

- Phase A は **1 週間以内に達成可能** で「DL 完了待ち」体感の 80% を解決(360p で確認 → 全部 DL ボタンで本実装)。**まずはここから着手** を推奨
- Phase B は完成形だが工数大。Phase A で運用しながら設計詰める
- Phase C は Gladia /v2/live の billing/精度を実機検証してから判断

## まとめ(意思決定が必要な選択肢)

ユーザ(みのる)が判断すべき設計選択:

1. **Phase A ライトで進めるか、いきなり Phase B フルで攻めるか**
   - A: 360p preview パッチ → 1 週間、UX 80%
   - B: MediaSource フル実装 → 2 週間、UX 100%
2. **Gladia /v2/live を採用するか、`/v2/pre-recorded` のチャンク化で済ませるか**
   - live: 真の並行、WebSocket 工数
   - pre-recorded chunk: 既存コード再利用、レイテンシ高め
3. **Twitch VOD 対応をどこでやるか**(HLS なので別経路、現状スコープ外)
4. **「全部一気に DL」モード切替時に既存 partial DL を破棄するか継続するか**

## 関連ファイル

- 検証コード: `src/main/spikes/progressive-dl-spike.ts`(本番未組み込み、`process.env.JIKKYOU_SPIKE === '1'` 等のゲートで起動時に走らせる前提)
- 既存 yt-dlp 起動: `src/main/urlDownload.ts`(本検証で変更なし)
- 既存メディアプロトコル: `src/main/mediaProtocol.ts`(本検証で変更なし)
- 既存 Gladia 連携: `src/main/gladia.ts`(本検証で変更なし)
- 関連設計: `docs/COMMENT_ANALYSIS_DESIGN.md`(コメント分析画面)
