# 次セッションへの引き継ぎ (NEXT_SESSION_HANDOFF)

## 凍結時刻
2026-05-03 01:00 — 「API 管理」専用画面 + 収集ログビューア完成、データ蓄積期間に入る前

## リポジトリ状態
- HEAD: 直近コミット直後
- Working Tree: clean

## 直前の状況サマリ

API キー数(Gladia + Anthropic + YouTube×複数)が増えて Settings 内に埋もれてた問題と、データ収集ログを毎回エディタで開く面倒さを、**「API 管理」専用画面**を新設して解消。データ収集を 1 週間放置する前段階の整備。

### 構成

#### メニュー追加
- トップレベル「**API 管理**」(submenu なしの単一項目)+ `Ctrl+Shift+A`
- ファイル / 操作 の隣に並ぶ

#### `ApiManagementDialog`(タブ式)

**タブ 1: API キー**(縦 3 セクション):
- **Gladia(文字起こし)**:登録済み / 未登録バッジ + Edit(inline 展開)+ Delete(confirm)
- **Anthropic(AI タイトル要約)**:同上
- **YouTube Data API**:複数キー(最大 10)+ per-key クォータバー(5 秒 polling、`/ 10000 unit` ベース)+ multi-input editor

**タブ 2: 収集ログ**(`CollectionLogViewer` 別コンポーネント):
- フィルタ:All / INFO / WARN / ERROR + 件数バッジ
- 自動更新トグル(5 秒)+ 手動更新ボタン + ファイルを開くボタン(`shell.openPath`)
- 仮想スクロール(ROW_HEIGHT 26 / BUFFER_ROWS 12)
- WARN は黄色背景、ERROR は赤色背景
- stick-to-bottom(20px 以内なら新規追記に追従)

#### ログ基盤刷新

`src/main/dataCollection/logger.ts`(新規):
- `logInfo` / `logWarn` / `logError` を export
- フォーマット:`2026-05-02T12:34:56.789Z [INFO]  message`
- `userData/data-collection/collection.log` に append + コンソールエコー
- 単一 promise chain で sequenced append(Windows torn-line 対策)

`src/main/dataCollection/logReader.ts`(新規):
- 末尾 N 行(デフォルト 5000)読み出し + 正規表現パース
- canonical フォーマット以外の legacy line は INFO で吸収

既存の `console.log/warn` を 6 ファイル分すべて `logger` 経由にリファクタ。

#### IPC 拡張

```ts
collectionLog.{read, openInExplorer, getQuotaPerKey}
onMenuOpenApiManagement
```

#### Settings 整理

- `SettingsDialog`:Gladia / Anthropic / YouTube キー入力を **完全削除**、「API 管理画面を開く」ハンドオフボタンのみ
- `DataCollectionSettings`:配信者リスト + ステータスパネル + 手動トリガーのみに整理(YouTube キー部分は ApiManagementDialog に移植)

### サンドボックスで取れた検証

- ✅ 型チェック + build 全部 clean
- ❌ 実際にメニュー出現 / Ctrl+Shift+A / API 管理画面の操作はユーザ環境で必要

## ⚠️ 実機検証が必要

サンドボックスでは GUI を起動できないので以下は未検証:
1. メニューバーに「API 管理」が出現するか
2. `Ctrl+Shift+A` でダイアログが開くか
3. タブ切替 / API キー編集モード / 削除 confirm が動くか
4. CollectionLogViewer が既存ログ(canonical + legacy 混在)を読むか
5. 「ファイルを開く」ボタンが OS 既定エディタで開くか
6. WARN / ERROR の色付けが見えるか
7. YouTube クォータバーがリアルタイム更新(5 秒間隔)するか

## 主要変更ファイル

### Backend
- `src/main/menu.ts` — トップレベル「API 管理」項目 + `CmdOrCtrl+Shift+A`
- `src/main/dataCollection/logger.ts`(新規)
- `src/main/dataCollection/logReader.ts`(新規)
- `src/main/dataCollection/database.ts` — `getQuotaPerKeyToday()` 追加
- `src/main/dataCollection/{index,youtubeApi,ytDlpExtractor}.ts` — console.log を logger へリファクタ
- `src/main/index.ts` — `collectionLog:*` IPC ハンドラ
- `src/preload/index.ts` — `collectionLog` namespace + `onMenuOpenApiManagement`
- `src/common/types.ts` — IpcApi 拡張

### Frontend
- `src/renderer/src/components/ApiManagementDialog.{tsx,module.css}`(新規)
- `src/renderer/src/components/CollectionLogViewer.{tsx,module.css}`(新規)
- `src/renderer/src/components/SettingsDialog.tsx` — API キー部分完全削除、ハンドオフリンクのみ
- `src/renderer/src/components/DataCollectionSettings.tsx` — YouTube キー部分削除、配信者リスト + 状態のみに整理
- `src/renderer/src/App.tsx` — ApiManagementDialog render + listener wire

## 既知の地雷・注意点

- **collection.log のローテーションなし**: append-only。10K records × ~10 lines/record = 100K lines = ~10MB 程度。1 ヶ月で数十 MB 想定。許容範囲だが、Phase 2 着手前にローテーション仕掛けてもいい
- **スクロール stick-to-bottom**: 20px しきい値。極端に遅い PC で polling と user scroll が重なると挙動が怪しい可能性
- **legacy ログ行のタイムスタンプは空文字**: `formatTime('')` が `'--:--:--'` を返すように対応済み
- **Settings ダイアログを開いてからハンドオフ**: 「API 管理画面を開く」を押すと Settings は閉じて API 管理が開く。ユーザの感覚に合わせた動線
- **per-key クォータバー**: `keyCount > 0` の時だけ表示。0 個登録の段階では出ない

## 最初のアクション順

1. **実機検証**(上記 7 項目)
2. **API キー登録**:Gladia / Anthropic / YouTube(複数)を ApiManagementDialog 経由で
3. **データ収集を 1 週間放置で 1 万件蓄積**
4. **ログを CollectionLogViewer で時々確認** — エラー赤色が頻発してたら原因特定
5. **次タスク候補**:
   - Phase 2(蓄積データ分析)
   - アイキャッチの実体動画化(FFmpeg)
   - 編集画面 (`edit` フェーズ) で `clipSegments` を実際の動画範囲絞り込みに使う

## みのる(USER)への報告用

- メニューバーに **「API 管理」** が並びました(Ctrl+Shift+A)
- API キー登録は全部この画面に集約 — Gladia / Anthropic / YouTube 全部
- YouTube キーは **per-key クォータバー** 付き(5 秒間隔で更新)
- 「収集ログ」タブで **データ収集ログを GUI で時系列表示**(WARN 黄色 / ERROR 赤色)
- 「ファイルを開く」で OS のテキストエディタにジャンプ可能
- Settings 画面はシンプル化、API キー欄は消えてハンドオフリンクのみ
- データ蓄積を 1 週間放置する前提が整いました
