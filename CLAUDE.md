# プロジェクト方針(Claude 向け)

## ⚠️ アプリ起動時の絶対ルール(最初に読む)

実機検証 / UI 確認のためにアプリを起動するときは **必ず `npm run dev` を使う**。

| コマンド | 使う時 | 詳細 |
|---|---|---|
| ✅ `npm run dev` | **常にこれ** | `electron-vite dev -w`。watch mode で main / preload / renderer の変更が即反映 |
| ✅ `npm run dev:fresh` | dist キャッシュ疑い時 | `out/` を消してから dev 起動 |
| ❌ `npm run start` | **使わない** | `electron-vite preview`。`out/` 内の **古いビルド成果物を実行** する。コード変更しても反映されない事故が頻発した |
| ❌ `out/main/index.js` 直接実行 | **使わない** | 同上、ビルド成果物を直接掴む |

### dev 起動が成功した目印

ターミナルに以下が出てれば OK:
- `dev server running for the electron renderer process at: http://127.0.0.1:3001/`(または 3002 等)
- `start electron app...`
- main プロセスが上がって Electron ウィンドウが立ち上がる

これらが出ないまま「アプリ動いてる」と判断しない。

### 古い Electron プロセスが残って邪魔する時

開発中に再起動を繰り返すと orphan が残ることがある。Windows での掃除:

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'jikkyou-cut' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

bash でも:
```bash
# Windows: タスクマネージャーから "electron.exe" を全終了でも可
taskkill //F //IM electron.exe  # Git Bash 経由(// は MSYS のエスケープ)
```

### 過去事例

2026-05-03 までに、Claude Code が `npm run start` を呼んで「コード変更が反映されない、なぜ?」とハマるケースが複数回発生した。**`start` は dev 用ではない**。デバッグや実機確認は `dev` 一択。

---

## 概要

ゲーム実況・配信切り抜き特化の動画編集ツール。Electron + React + TypeScript 製。
Vrew のような「テキストを消すと動画もカットされる」編集を、長時間アーカイブに対して **無制限・無料** で提供する。

## 対象ユーザー
ゲーム実況 YouTuber、長時間配信を切り抜く VTuber/ストリーマー。

## 技術スタック

- Electron + electron-vite + React 18 + TypeScript
- 動画処理: システム導入済み FFmpeg 8.1(`--enable-whisper`)を `execa` で呼び出す
- 状態管理: zustand
- UI: 素の CSS Modules のみ。UI ライブラリ(Radix / Tailwind / shadcn など)は **MVP では一切入れない**
- パッケージマネージャ: npm

## ディレクトリ構成

```
src/
  main/      Electron メインプロセス(FFmpeg 起動、ファイル I/O)
  preload/   IPC ブリッジ
  renderer/  React UI
  common/    main/renderer 共有の型・定数
```

## コーディング規約

- TypeScript strict
- コメントは "なぜ" のみ。"何を" は書かない
- 機能追加は MVP スコープに収める。先回り抽象化禁止
- Windows 11 特有のパス区切り(`\\`)は path モジュールで吸収

## MVP スコープ(これだけ作る)

1. 動画読み込み + HTML5 プレビュー
2. Whisper による日本語文字起こし
3. テキスト削除 → 区間削除のリンク(**文(セグメント)単位**)
4. セグメント可視化タイムライン
5. FFmpeg で最終書き出し

## スコープ外(やらない)

- マルチトラック編集 / リアルタイムエフェクト / キーフレーム
- 多言語 UI(日本語のみ)
- コメントヒートマップ(MVP 後)
- バッチ処理
- 単語単位の編集(S5 完了後に再検討)

## MVP の編集粒度制約

編集は ASR(Gemini)が出力した **キュー単位** で行います。1 キューの一部だけを残し残りを消す、といった細かい編集は MVP では不可能です。粒度を細かくしたい場合は:

- ASR のセグメント長(`queue=` パラメータ)を短く調整 — Gemini の場合はプロンプトで指示
- フレーム単位のトリミング機能(MVP 後の改善項目)
- LosslessCut 等で後段加工

を検討します。

## 確定済み設計判断

| 項目 | 決定 |
|---|---|
| Whisper モデル | ユーザが `ggml-base.bin` 等を手動 DL。設定で絶対パス指定。初回起動時に DL リンクとセットアップ手順を画面で案内 |
| 状態管理 | zustand |
| UI ライブラリ | 素の CSS Modules のみ |
| FFmpeg パス | PATH からの自動検索を第一候補、設定で絶対パス指定もできるハイブリッド方式 |
| テキスト編集の粒度 | MVP は文(セグメント)単位のみ |

## ライセンス上の制約

**GPL-2.0-or-later** で配布。LosslessCut(`C:\dev\lossless-cut`、GPL-2.0-or-later)から派生コードを流用するため、
コピーしたファイルにはオリジナルの著作権表記を保持し、上部に出典コメントを付与すること。

## LosslessCut 参考資料

`C:\dev\lossless-cut` にクローン済み。流用候補:

- `src/main/ffmpeg.ts` — `execa` 起動と進捗パース
- `src/main/progress.ts` — `-progress pipe:` のパーサ
- `src/renderer/src/segments.ts` — セグメント純関数群(createSegment, sortSegments, invertSegments)
- `src/renderer/src/hooks/useKeyboard.ts` — キーボードショートカット基盤
- `src/renderer/src/Timeline.tsx` — タイムライン描画(シンプルな部分のみ)

LosslessCut の「smart cut」「html5ify」「@electron/remote」「Radix UI エコシステム」は **不採用**。

## 開発コマンド

```bash
npm run dev        # 実機検証はこれ。watch mode で変更が即反映
npm run dev:fresh  # out/ を消してから dev 起動(キャッシュ疑い時)
npm run build      # 本番ビルド
npm run lint       # ESLint(後追い導入)
npm run test       # Vitest(後追い導入)
```

**`npm run start` は使わない**(古いビルドを実行するだけ — 文書冒頭の警告参照)。

## 重要な実装メモ

### Whisper 呼び出し

FFmpeg 8.1 の whisper は **audio フィルタ**:

```
ffmpeg -i input.mp4 -vn -af "whisper=model=ggml-base.bin:language=ja:destination=out.srt:format=srt" -f null -
```

モデルファイル(`ggml-*.bin`)はユーザに別途 DL してもらい、設定で絶対パス指定。

### コーデック制約

MVP では HTML5 `<video>` がネイティブ再生できる形式(H.264/AAC/MP4、VP9/Opus/WebM)のみサポート。
それ以外は LosslessCut の MediaSource 流し込み実装を参考に後追いで対応。

## 段階的マイルストーン

| Step | 動く状態 |
|---|---|
| **S0** | `npm run dev` で空の Electron ウィンドウが開く |
| **S1** | ファイル選択ダイアログ → `<video>` で再生 |
| **S2** | 30 秒〜1 分のテスト MP4 で文字起こし → 生成 SRT がファイル保存される & renderer に JSON 形式で渡る |
| **S3** | 文字起こし結果をクリックでシーク、行削除でセグメント生成 |
| **S4** | タイムラインに「残す/消す」を色分け表示 |
| **S5** | 書き出しボタン → セグメント連結で MP4 出力 |
