# TODO

進行中タスク・残タスク・完了済みタスクの一覧。`HANDOFF.md` の「未実装/将来候補」セクションをタスク化し、本ファイルで進捗を追う。

---

## 🚧 進行中

(進行中タスクなし。字幕機能 Phase A は 3 分担すべて完了)

---

## 📋 未着手(優先度順)

### High

- **503 自動リトライ(Gladia 含む)** — API 側の高負荷時の指数バックオフ。Gemini 期に問題化、Gladia でも同型のリスクあり。`gladia.ts` の `submitJob` / `pollResult` でラップ
- **Gladia API 実機検証** — フィールド名(`audio_url` / `result_url` / `utterances`)等が想定通りかを実物で確認、必要に応じて defensive parsing を強化
- **配布バイナリ作成** — electron-builder で `.exe` パッケージング。署名・自動更新は別途検討
- **未対応コーデック動画への対応** — H.265 / mkv 等を MediaSource 経由で再生可能に(LosslessCut の compatPlayer.ts 参考)

### Medium

- **波形表示** — Timeline に音声波形をオーバーレイ。編集ポイントの判断補助
- **ズーム機能** — 長時間動画の特定区間を細かく編集できるよう、Timeline の横スクロール + 倍率変更
- **スクラブ(ドラッグでシーク)** — Timeline つまみドラッグでリアルタイム動画シーク
- **空状態(empty state)のデザイン磨き** — DropZone・キュー一覧未生成時のヒント / イラスト
- **ローディング・トランジションの洗練** — フェーズ切替アニメーション、ボタン押下フィードバック

### Low

- **単語単位編集** — 1 キュー内の特定単語だけ削除(Gladia の word-level timestamps があれば実装可能)
- **話者分離 UI 拡張** — 話者ごとの色分け / 話者フィルタ(「話者1のキューだけ表示」)
- **キャラ名自動補完** — TranscriptionContextForm でゲーム名から候補表示
- **設定永続化拡張** — `previewMode` / FFmpeg パス / 出力品質などをユーザ設定に
- **ダーク/ライトテーマ切替** — 現状ダーク固定、`prefers-color-scheme` 連動 + 設定切替
- **音声フェードイン/アウト** — プレビュー再生時のスキップでの瞬断対策
- **コメントヒートマップ** — YouTube ライブのコメント密度を Timeline 上に重畳(MVP スコープ外と明示済み)
- 🟡 **検討中: キュー個別のスタイル変更** — 行ごとに異なるプリセット選択やカスタムスタイルを適用できるようにする

---

## ✅ 完了済み(直近)

- **2026-05-01** FFmpeg 字幕焼き込みを書き出しに統合 — `src/common/subtitle.ts`(`buildAss` / `convertTimecode` / `hexToAss` / `formatAssTime` 純関数)、`src/main/export.ts` の `prepareSubtitles()` でアクティブスタイル解決 + opt-in cue チェック + `temp/jcut-subs-*.ass` 生成 + `subtitles=path:fontsdir=path` フィルタを `[concatv]subtitles=...[outv]` でチェーン。Windows パスは `\` → `/`、`:` → `\\:` で escape。フォント未インストール時等は静かに字幕なしフォールバック。`videoWidth/Height` を `loadedmetadata` で store にキャプチャして ASS の `PlayResX/Y` に渡す。**Phase A はこれで完成**
- **2026-05-01** 字幕設定 UI 実装 — `SubtitleSettingsDialog` と `FontManagerDialog` を作成。プリセット選択、カスタムスタイル作成、動的プレビュー、フォント DL 機能、キュー一覧の字幕 ON/OFF トグルを実装(Antigravity 担当)
- **2026-05-01** 字幕機能 Phase A 基盤 — `SubtitleStyle` / `SubtitleSettings` / `InstalledFont` / `AvailableFont` 等の型、`src/main/fonts.ts`(Google Fonts 厳選 12 個カタログ + DL + 一覧 + 削除)、`src/main/subtitleSettings.ts`(`userData/subtitle-settings.json` の load/save + 組み込みプリセット 5 種)、IPC ハンドラ + preload exposure を実装。`TranscriptCue.showSubtitle: boolean` 追加 + 旧 jcut.json 後方互換マイグレーション
- **2026-04-30** 再生中ハイライト(▶+赤バー)もギャップ対応に統一 — `findCueIndexForScroll` を `findCueIndexForCurrent` にリネームし、ハイライト判定セレクタからも同じ関数を呼ぶように変更。スクロールとハイライトが同一の「現在キュー」観念で動作 → ギャップ中・冒頭・末尾でも常にどこかに ▶ が出る
- **2026-04-30** シーク時のキュー一覧自動スクロール(現状不安定 → 解決) — `findCueIndexForCurrent` で **キュー間ギャップ位置** にシークしても直前のキューにスクロール、冒頭・末尾の無音位置でも先頭/末尾キューへフォールバック。再生中追従は撤廃して seek 起点の片方向プッシュ(`seekNonce`)に再設計
- **2026-04-29** 文字起こしエンジンを Gemini → Gladia に全面置換 — `@google/genai` 削除、`gladia.ts` 新設、話者分離 + custom_vocabulary 対応、`TranscriptCue.speaker` 追加
- **2026-04-29** UI 全面リデザイン — ダークテーマ + lucide-react + レイアウト再構成 + OperationsDialog 追加(Antigravity 担当)
- **2026-04-28** プレビュー再生機能(削除区間の自動スキップ) — `decidePreviewSkip` 純関数 + ExportPreview のトグル
- **2026-04-27** MVP 完成 + `v0.1.0-mvp` タグ — S5 で FFmpeg trim+concat の動画書き出し実装
- **2026-04-27** HANDOFF.md 作成 — Antigravity 引き継ぎ用の総合ドキュメント
- **2026-04-26** Gladia の前段としてのローカル Whisper → Gemini 2.5 Flash 移行(S2g)
