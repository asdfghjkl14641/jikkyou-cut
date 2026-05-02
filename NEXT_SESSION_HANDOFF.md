# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 06:30 — データ収集に永続マスタースイッチ追加(デフォルト無効)、ユーザは検索クエリ戦略を詰めるフェーズへ

## リポジトリ状態
- HEAD: `2dca5bd`(feat(data-collection): 自動収集に永続マスタースイッチを追加)
- 直後に docs コミット予定(本ファイル + DECISIONS.md + TODO.md + HANDOFF.md)
- Working Tree: docs commit 後 clean

## 直前の状況サマリ

API キー保存周りが本番品質に到達(`b04f64d` + `e43f275`)した直後、ユーザが**「これから検索クエリ戦略を詰めるフェーズに入るので、それまで自動収集を止めたい」**と要望。クォータ消費を防ぐため、データ収集に**永続マスタースイッチ**を追加した。

### 追加した設計レイヤ

| 軸 | 名前 | 永続性 | 役割 |
|---|---|---|---|
| 永続マスタースイッチ | `AppConfig.dataCollectionEnabled` | ✅ 再起動跨ぐ(`config.json`) | デフォルト `false`。アプリ起動時の自動開始 / 有効化時の `start()` 呼出をガード |
| セッション内モード | `dataCollectionManager.state` (`'idle' \| 'running' \| 'paused'`) | ❌ メモリのみ | 有効状態下で動作中 / 一時停止を制御 |

「永続的な ON/OFF」と「セッション内の一時停止」を別レイヤにしたのが要点。

### 修正

- `src/common/config.ts` — `AppConfig` に `dataCollectionEnabled: boolean`(default `false`)
- `src/main/config.ts` — load/save 双方で field を扱う、既存 install フォールバック付き
- `src/main/index.ts`:
  - `app.whenReady()` の `dataCollectionManager.start()` を `cfg.dataCollectionEnabled === true` でガード
  - IPC `dataCollection:isEnabled` / `setEnabled(boolean)` 新設(後者は config 保存 + start/pause)
  - `dataCollection:getStats` の戻り値に `isEnabled` を追加(UI 反映用)
- `src/common/types.ts` — `IpcApi.dataCollection` 拡張
- `src/preload/index.ts` — bridge 追加
- `src/renderer/src/components/DataCollectionSettings.tsx`:
  - `Stats` 型に `isEnabled` 追加
  - ステータス行に「自動収集: 🔴 無効 / 🟢 有効」項目を追加
  - 状態行のロジック更新(`isEnabled === false` 時は「⚫ 停止中(自動収集無効)」)
  - メインボタンを「有効化する / 無効化する」(永続トグル、有効化時は `window.confirm` で意図確認)
  - 「今すぐ実行」ボタンは `isEnabled === false` で disabled、ツールチップ案内
  - セッション内一時停止 / 再開ボタンは `isEnabled && (isRunning || isPaused)` のとき表示

### 動作

- **デフォルト**:🔴 無効 / 起動時 `[data-collection] auto-start skipped (dataCollectionEnabled=false)` ログ / 何も走らない
- **「有効化する」を押す**:確認ダイアログ → OK → 🟢 有効 / `start()` 呼出(API キー無ければ no-op) / 5 秒後にバッチ
- **「無効化する」を押す**:即座に `pause()`(進行中バッチ停止)+ config に `false` 保存 / 再起動後も自動開始しない
- **再起動**:config の `dataCollectionEnabled` を読んで挙動が決まる

## 動作確認(実機 — ユーザに依頼予定)

1. **デフォルト状態**:アプリ初回起動 → 「自動収集: 🔴 無効」表示、収集走らんこと
2. **有効化トグル**:確認ダイアログ → OK → 🟢 有効、収集開始ログ
3. **無効化トグル**:🔴 無効、進行中バッチ停止
4. **再起動後の永続化**:有効化したまま再起動 → 自動開始する / 無効化したまま再起動 → 自動開始しない
5. **「今すぐ実行」**:無効状態では disabled、有効状態では押せる

## 主要変更ファイル(直近 = `2dca5bd`)

- `src/common/config.ts`、`src/common/types.ts`
- `src/main/config.ts`、`src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/DataCollectionSettings.tsx`

## 既知の地雷・注意点

- **`saveYoutubeApiKeys` の read-back integrity check** は引き続き残置(成功時無音、ズレた時のみ `console.warn`)— 防御層
- **既存 install では `dataCollectionEnabled` field が無い** → ロード時 `false` フォールバック → アップグレード時も即収集が走らない安全な初期値
- **永続マスタースイッチを ON にしても API キーが無ければ何も起きない**:`dataCollectionManager.start()` 内の `hasYoutubeApiKeys()` チェックが残っているため。UI には「未起動(API キー未登録)」を見せる

## 次タスク候補(ユーザ進行中 + 次セッション候補)

1. **【ユーザ側】検索クエリ戦略を詰める** — 別タスクで指示が来る
2. データ収集の検索クエリを変更したいタイミングで `BROAD_QUERIES` (`src/main/dataCollection/searchQueries.ts`) を更新
3. クエリ戦略確定 → ユーザが「有効化する」を押して 1 週間放置 → 蓄積データを Phase 2 で分析
4. 並行候補:アイキャッチの実体動画化(FFmpeg)、編集画面で `clipSegments` を実際の動画範囲絞り込みに使う

## みのる(USER)への報告用

- データ収集に **永続マスタースイッチ** 追加 ✅
- API キー保存と独立した「**有効化する / 無効化する**」ボタンが「切り抜きデータ収集」セクションに出現
- デフォルトは 🔴 無効 / 「今すぐ実行」も無効状態では押せない
- 検索クエリ戦略が決まったら **手動で「有効化する」を押す** 運用
- 確認ダイアログでクォータ消費が始まることを明示する
