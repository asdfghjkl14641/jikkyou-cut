import { useEffect, useRef, useState } from 'react';
import { X, KeyRound, Database, Download, FolderOpen, Trash2 } from 'lucide-react';
import styles from './SettingsDialog.module.css';
import { useSettings } from '../hooks/useSettings';
import type { YtdlpCookiesBrowser } from '../../../common/config';
import TwitchAuthTab from './TwitchAuthTab';

type TabId = 'general' | 'download' | 'twitch-auth';

const COOKIE_BROWSER_OPTIONS: Array<{
  value: YtdlpCookiesBrowser;
  label: string;
  recommended?: boolean;
}> = [
  { value: 'none', label: '使用しない' },
  { value: 'edge', label: 'Edge', recommended: true },
  { value: 'chrome', label: 'Chrome' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'brave', label: 'Brave' },
];

// Trimmed-down Settings dialog. As of the API-management refactor +
// the data-collection tab move (2026-05-03), this dialog is now
// effectively a thin shell that points users at the API management
// screen for everything related to API keys, data collection
// controls, and the creator targeting list. Kept around so users who
// reach for "Settings" out of habit still find a way in.

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenApiManagement: () => void;
};

type CookieField = 'ytdlpCookiesFile' | 'ytdlpCookiesFileYoutube' | 'ytdlpCookiesFileTwitch';

// Single row of: small caption + (path display | file-pick button | clear button).
// Module-scope so we don't re-allocate on every render. Module-scope JSX
// is fine; React only checks identity on top-level components.
function renderCookieRow(opts: {
  field: CookieField;
  label: string;
  value: string | null;
  missing: boolean;
  view: ReturnType<typeof useSettings>['view'];
  onPick: (field: CookieField) => void | Promise<void>;
  onClear: (field: CookieField) => void;
}) {
  const { field, label, value, missing, view, onPick, onClear } = opts;
  return (
    <div key={field} style={{ marginTop: 10 }}>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            flex: '1 1 240px',
            minWidth: 0,
            padding: '6px 10px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(0, 0, 0, 0.2)',
            fontSize: 'var(--font-size-xs)',
            fontFamily: 'var(--font-mono)',
            color: value ? 'var(--text-primary)' : 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            // Direction trick: keep the filename visible when the
            // path is too long to fit. ltr re-applied to the inner
            // text would corrupt the rendering of CJK chars; we
            // accept the leading "..." as a tradeoff.
            direction: 'rtl',
            textAlign: 'left',
          }}
          title={value ?? '未指定'}
        >
          {value ?? '未指定'}
        </span>
        <button
          type="button"
          className={styles.saveButton}
          onClick={() => onPick(field)}
          disabled={!view}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
        >
          <FolderOpen size={14} />
          ファイル選択
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={() => onClear(field)}
          disabled={!view || !value}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
        >
          <Trash2 size={14} />
          クリア
        </button>
      </div>
      {missing && value && (
        <div className={styles.error} style={{ marginTop: 6 }}>
          指定されたクッキーファイルが見つかりません(または空です)。
        </div>
      )}
    </div>
  );
}

export default function SettingsDialog({ open, onClose, onOpenApiManagement }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const { view, save } = useSettings();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const cookiesBrowser: YtdlpCookiesBrowser =
    view?.config.ytdlpCookiesBrowser ?? 'none';
  const cookiesFile: string | null = view?.config.ytdlpCookiesFile ?? null;
  const cookiesFileYoutube: string | null = view?.config.ytdlpCookiesFileYoutube ?? null;
  const cookiesFileTwitch: string | null = view?.config.ytdlpCookiesFileTwitch ?? null;
  // Per-slot missing flag. Re-checked on dialog open + after a fresh
  // selection. Keyed by field name so the same UI can render 3 slots.
  const [missingMap, setMissingMap] = useState<Record<CookieField, boolean>>({
    ytdlpCookiesFile: false,
    ytdlpCookiesFileYoutube: false,
    ytdlpCookiesFileTwitch: false,
  });

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  // Re-validate all 3 slots whenever the dialog opens with non-null
  // values. The user might have moved or deleted any of the files
  // since they last saved.
  useEffect(() => {
    if (!open) {
      setMissingMap({
        ytdlpCookiesFile: false,
        ytdlpCookiesFileYoutube: false,
        ytdlpCookiesFileTwitch: false,
      });
      return;
    }
    let alive = true;
    const slots: Array<[CookieField, string | null]> = [
      ['ytdlpCookiesFile', cookiesFile],
      ['ytdlpCookiesFileYoutube', cookiesFileYoutube],
      ['ytdlpCookiesFileTwitch', cookiesFileTwitch],
    ];
    void Promise.all(
      slots.map(async ([key, p]) =>
        p ? [key, await window.api.validateCookiesFile(p)] as const : [key, null] as const,
      ),
    ).then((results) => {
      if (!alive) return;
      const next = { ytdlpCookiesFile: false, ytdlpCookiesFileYoutube: false, ytdlpCookiesFileTwitch: false };
      for (const [key, res] of results) {
        next[key] = res != null && (!res.exists || res.sizeBytes === 0);
      }
      setMissingMap(next);
    });
    return () => {
      alive = false;
    };
  }, [open, cookiesFile, cookiesFileYoutube, cookiesFileTwitch]);

  const handleCookieBrowserChange = (next: YtdlpCookiesBrowser) => {
    // Fire-and-forget — useSettings.save updates its own copy of the
    // config view on success, and there's no in-flight DL we'd want
    // to retry on persistence failure (the next URL submission rereads
    // config from disk anyway).
    void save({ ytdlpCookiesBrowser: next });
  };

  const handlePickCookiesFile = async (field: CookieField) => {
    const picked = await window.api.openCookiesFileDialog();
    if (!picked) return;
    const v = await window.api.validateCookiesFile(picked);
    await save({ [field]: picked });
    setMissingMap((m) => ({ ...m, [field]: !v.exists || v.sizeBytes === 0 }));
    const warnings: string[] = [];
    if (!v.exists) warnings.push('ファイルが見つかりません。');
    else if (v.sizeBytes === 0) warnings.push('ファイルが空です。');
    if (v.exists && v.extension !== 'txt' && v.extension !== '') {
      warnings.push(`拡張子が .txt ではありません(.${v.extension})。`);
    }
    if (warnings.length > 0) {
      alert(`クッキーファイルの確認:\n${warnings.join('\n')}\n\n設定は保存しましたが、bot 検出時にエラーになる可能性があります。`);
    }
  };

  const handleClearCookiesFile = (field: CookieField) => {
    void save({ [field]: null });
    setMissingMap((m) => ({ ...m, [field]: false }));
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>設定</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="閉じる"
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* 段階 X1: tab strip. 3 tabs in horizontal scrolling row.
          The order is "general first" so users opening the dialog land
          on the API hand-off they'll most often want; cookie/creator
          tabs are deeper-config that the user navigates to deliberately. */}
      <div className={styles.tabStrip} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={`${styles.tabButton} ${activeTab === 'general' ? styles.tabButtonActive : ''}`}
          onClick={() => setActiveTab('general')}
        >
          一般
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'download'}
          className={`${styles.tabButton} ${activeTab === 'download' ? styles.tabButtonActive : ''}`}
          onClick={() => setActiveTab('download')}
        >
          動画ダウンロード
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'twitch-auth'}
          className={`${styles.tabButton} ${activeTab === 'twitch-auth' ? styles.tabButtonActive : ''}`}
          onClick={() => setActiveTab('twitch-auth')}
        >
          Twitch 認証
        </button>
      </div>

      <div className={styles.body}>
        {activeTab === 'twitch-auth' && <TwitchAuthTab />}

        {activeTab === 'download' && (
          <>
        {/* Browser-cookie integration for yt-dlp. YouTube's anti-bot
            heuristics increasingly block anonymous yt-dlp traffic with
            "Sign in to confirm you're not a bot"; forwarding cookies
            from a logged-in browser bypasses that.

            This setting also unlocks age-restricted / members-only DLs
            for accounts that have those entitlements. Edge is flagged
            as recommended because it's pre-installed on Windows 11
            and yt-dlp's Chromium-edge cookie extractor is stable. */}
        <div className={styles.section}>
          <label
            className={styles.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Download size={14} />
            動画ダウンロード — ブラウザクッキー使用
          </label>
          <div
            role="radiogroup"
            aria-label="ブラウザクッキー使用"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}
          >
            {COOKIE_BROWSER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-sm)',
                }}
              >
                <input
                  type="radio"
                  name="ytdlpCookiesBrowser"
                  value={opt.value}
                  checked={cookiesBrowser === opt.value}
                  onChange={() => handleCookieBrowserChange(opt.value)}
                  disabled={!view}
                />
                <span>{opt.label}</span>
                {opt.recommended && (
                  <span
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--accent-primary)',
                    }}
                  >
                    ← 推奨
                  </span>
                )}
              </label>
            ))}
          </div>
          <div className={styles.help}>
            YouTube が bot 検出で「Sign in to confirm」エラーを出す場合、お使いのブラウザで YouTube にログインした上でこの設定を有効にしてください。これによりログイン状態の認証が yt-dlp に渡されます。
            <br />
            <br />
            <strong>注意:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: '1.2em' }}>
              <li>ブラウザでログアウトすると無効になります</li>
              <li>メンバー限定・年齢制限動画もこの設定で取得可能になります</li>
              <li>ブラウザ起動中にクッキーロックでエラーになる場合あり(その場合はブラウザを閉じてから再試行)</li>
            </ul>
          </div>

          {/* Manual cookies.txt picker. Takes precedence over the
              browser-cookies radio group above when set — see
              urlDownload.getCookiesArgs. We label that priority
              explicitly because the browser flow can fail silently
              (Windows DPAPI changes / Chrome process lock) and the
              user needs to know the file path is the more reliable
              fallback. */}
          <div style={{ marginTop: 16 }}>
            <label
              className={styles.label}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              またはクッキーファイル
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--accent-primary)',
                  fontWeight: 'normal',
                }}
              >
                (優先度: 高、プラットフォーム別 → 汎用 → ブラウザ)
              </span>
            </label>

            {renderCookieRow({
              field: 'ytdlpCookiesFile',
              label: '汎用(両プラットフォーム)',
              value: cookiesFile,
              missing: missingMap.ytdlpCookiesFile,
              view,
              onPick: handlePickCookiesFile,
              onClear: handleClearCookiesFile,
            })}
            {renderCookieRow({
              field: 'ytdlpCookiesFileYoutube',
              label: 'YouTube 専用(汎用より優先)',
              value: cookiesFileYoutube,
              missing: missingMap.ytdlpCookiesFileYoutube,
              view,
              onPick: handlePickCookiesFile,
              onClear: handleClearCookiesFile,
            })}
            {renderCookieRow({
              field: 'ytdlpCookiesFileTwitch',
              label: 'Twitch 専用(汎用より優先)',
              value: cookiesFileTwitch,
              missing: missingMap.ytdlpCookiesFileTwitch,
              view,
              onPick: handlePickCookiesFile,
              onClear: handleClearCookiesFile,
            })}

            <div className={styles.help}>
              ブラウザクッキー使用が動かない場合(Windows DPAPI 問題など)、ファイル指定が最も確実です。Chrome 拡張「Get cookies.txt LOCALLY」等で export して指定してください。
              <br />
              プラットフォーム別ファイルを指定すると、URL に応じて自動的に適切なクッキーが使われます(YouTube URL → YouTube 専用、Twitch URL → Twitch 専用)。指定が無ければ汎用にフォールバック。
              <br />
              <br />
              <strong>※ クッキーファイルは認証情報を含みます。第三者と共有しないでください。</strong>
            </div>
          </div>
        </div>

        {/* 段階 X3+X4 — auto-record settings. Lives in the download
            tab because recording reuses the yt-dlp pipeline + cookies
            machinery the rest of the tab configures. */}
        <RecordingSettingsSection view={view} save={save} />
          </>
        )}

        {activeTab === 'general' && (
          <>
        {/* Single hand-off section. Both API keys and data-collection
            controls (有効化 / 1 回だけ取得 / 取得を停止 / 配信者リスト)
            now live in the API 管理 screen. The Settings dialog is
            mostly a discoverability fallback. */}
        <div className={styles.section}>
          <label className={styles.label}>API キー / データ収集の設定</label>
          <div className={styles.help} style={{ marginTop: 0, marginBottom: 8 }}>
            Gladia / Anthropic / YouTube の API キー、データ収集の開始 / 停止、配信者リストはすべて「API 管理」画面に集約されています(メニュー → API 管理、または Ctrl+Shift+A)。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => {
                onClose();
                onOpenApiManagement();
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <KeyRound size={14} />
              API キー画面を開く
            </button>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => {
                onClose();
                onOpenApiManagement();
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="API 管理画面の「データ収集」タブで開始 / 停止できます"
            >
              <Database size={14} />
              データ収集画面を開く
            </button>
          </div>
        </div>

        <div className={styles.section}>
          <label className={styles.label}>配信者の自動録画(段階 X1-X2)</label>
          <div className={styles.help} style={{ marginTop: 0 }}>
            Twitch / YouTube 配信者を登録 → 1 分間隔で配信検知。録画機能は段階 X3 で実装予定。
            <br />
            登録は <strong>メニュー → 登録チャンネル(Ctrl+Shift+M)</strong> から、Twitch 認証は本ダイアログの「Twitch 認証」タブから設定します。
          </div>
        </div>

        {/* 段階 X3.5 — task-tray + auto-launch. Windows-only; the
            checkboxes still render on macOS / Linux but the underlying
            handlers no-op there (Electron's loginItemSettings is a
            stub on Linux, and our close-to-tray is platform-guarded
            in main). */}
        <div className={styles.section}>
          <label className={styles.label}>タスクトレイ</label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <input
              type="checkbox"
              checked={view?.config.closeToTray ?? true}
              onChange={(e) => void save({ closeToTray: e.target.checked })}
              disabled={!view}
            />
            ウィンドウを閉じてもタスクトレイに常駐する
          </label>
          <div className={styles.help}>
            OFF にすると ✕ ボタンでアプリが完全終了します。配信検知 / 録画機能は終了します。
          </div>
        </div>

        <div className={styles.section}>
          <label className={styles.label}>PC 起動時</label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <input
              type="checkbox"
              checked={view?.config.startOnBoot ?? false}
              onChange={(e) => void save({ startOnBoot: e.target.checked })}
              disabled={!view}
            />
            PC 起動時に jikkyou-cut を自動起動する
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
              marginTop: 6,
              opacity: view?.config.startOnBoot ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={view?.config.startMinimized ?? false}
              onChange={(e) => void save({ startMinimized: e.target.checked })}
              disabled={!view || !view.config.startOnBoot}
            />
            自動起動時にウィンドウを表示せず、タスクトレイに最小化する
          </label>
          <div className={styles.help}>
            自動起動 + タスクトレイ最小化を組み合わせると、PC 起動からずっと配信監視が動く設定になります。
          </div>
        </div>
          </>
        )}
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onClose}
        >
          閉じる
        </button>
      </div>
    </dialog>
  );
}

// 段階 X3+X4 — auto-record settings + disclaimer dialog. Extracted
// into its own component so SettingsDialog itself doesn't bloat.
// The disclaimer fires the first time the user flips
// `recordingEnabled` ON — once acknowledged, AppConfig.recording
// DisclaimerAccepted stays true forever.
type SettingsView = NonNullable<ReturnType<typeof useSettings>['view']>;

function RecordingSettingsSection(props: {
  view: SettingsView | null;
  save: (partial: Parameters<ReturnType<typeof useSettings>['save']>[0]) => Promise<unknown>;
}) {
  const { view, save } = props;
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [recordingDir, setRecordingDir] = useState<string | null>(null);

  // Resolve the effective recording dir on mount + on save events,
  // so the path display shows the actual filesystem location even
  // when AppConfig.recordingDir is null (default).
  useEffect(() => {
    void window.api.streamRecorder.getRecordingDir().then(setRecordingDir);
  }, [view]);

  const enabled = view?.config.recordingEnabled ?? false;
  const accepted = view?.config.recordingDisclaimerAccepted ?? false;
  const quality: 'best' | '1080p' | '720p' = view?.config.recordingQuality ?? 'best';
  const vodFallback = view?.config.recordingVodFallback ?? true;

  const handleToggleEnabled = async (next: boolean) => {
    if (next && !accepted) {
      setShowDisclaimer(true);
      return;
    }
    await save({ recordingEnabled: next });
  };

  const handleConfirmDisclaimer = async () => {
    await save({ recordingDisclaimerAccepted: true, recordingEnabled: true });
    setShowDisclaimer(false);
  };

  const handleRevealRecordingDir = async () => {
    if (!recordingDir) return;
    // Reuse the existing shell.openPath bridge — there's no direct
    // window.api for "open directory in explorer", so we just open
    // an arbitrary file inside via the recorder's revealInFolder
    // when a recording exists. For now: showing the path text +
    // letting the user copy it is sufficient.
    void navigator.clipboard?.writeText(recordingDir).catch(() => {});
  };

  return (
    <>
      <div className={styles.section}>
        <label className={styles.label}>自動録画(段階 X3+X4)</label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void handleToggleEnabled(e.target.checked)}
            disabled={!view}
          />
          配信開始時に自動録画する
        </label>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
            録画品質
          </div>
          <div role="radiogroup" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['best', '1080p', '720p'] as const).map((q) => (
              <label
                key={q}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}
              >
                <input
                  type="radio"
                  name="recordingQuality"
                  value={q}
                  checked={quality === q}
                  onChange={() => void save({ recordingQuality: q })}
                  disabled={!view}
                />
                {q === 'best' ? 'ベスト(最高画質)' : q}
              </label>
            ))}
          </div>
        </div>

        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--font-size-sm)', marginTop: 10 }}
        >
          <input
            type="checkbox"
            checked={vodFallback}
            onChange={(e) => void save({ recordingVodFallback: e.target.checked })}
            disabled={!view}
          />
          配信終了後に VOD で取り直す(高品質)
        </label>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
            録画フォルダ
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                flex: '1 1 240px',
                minWidth: 0,
                padding: '6px 10px',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(0, 0, 0, 0.2)',
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                direction: 'rtl',
                textAlign: 'left',
              }}
              title={recordingDir ?? '読込中…'}
            >
              {recordingDir ?? '読込中…'}
            </span>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => void handleRevealRecordingDir()}
              disabled={!recordingDir}
            >
              パスをコピー
            </button>
          </div>
        </div>

        <div className={styles.help}>
          <strong>注意:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: '1.2em' }}>
            <li>配信者から許諾を得たコンテンツのみで使用してください。</li>
            <li>1 配信あたり 1-20 GB のストレージを消費します。</li>
            <li>アプリを起動したままにする必要があります(タスクトレイ常駐推奨)。</li>
          </ul>
        </div>
      </div>

      {showDisclaimer && (
        <RecordingDisclaimer
          onConfirm={() => void handleConfirmDisclaimer()}
          onCancel={() => setShowDisclaimer(false)}
        />
      )}
    </>
  );
}

function RecordingDisclaimer(props: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onCancel}
    >
      <div
        style={{
          background: 'rgba(30, 33, 41, 0.95)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)',
          width: 'min(480px, 92vw)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>⚠ 自動録画機能について</h2>
        <div style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
          この機能は<strong>配信者の許諾を得たコンテンツのみ</strong>で使用してください。
          <br />
          <br />
          YouTube / Twitch の利用規約により、無断録画は規約違反となる可能性があります。本機能の使用は自己責任です。
        </div>
        <div
          style={{
            marginTop: 16,
            padding: 10,
            border: '1px solid var(--accent-warning, #f59e0b)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--accent-warning, #f59e0b)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          権利者から許諾を得ていますか?
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className={styles.cancelButton} onClick={props.onCancel}>
            キャンセル
          </button>
          <button type="button" className={styles.saveButton} onClick={props.onConfirm}>
            はい、許諾を得ている
          </button>
        </div>
      </div>
    </div>
  );
}
