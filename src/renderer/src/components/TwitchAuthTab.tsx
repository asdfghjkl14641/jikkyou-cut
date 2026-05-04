import { useCallback, useEffect, useState } from 'react';
import { Check, AlertCircle } from 'lucide-react';
import styles from './SettingsDialog.module.css';

// 段階 X1 (revised) — Twitch Helix credentials only.
//
// The "register a streamer" + "list registered streamers" UI moved out
// of SettingsDialog and into the new MonitoredCreatorsView (full-screen
// page accessible from the menu bar). Auth credentials stay here
// because they fit the dialog's "small persistent settings" idiom.
//
// Behaviour mirrors the original CreatorManagementTab.tsx auth section
// 1:1 — the user retypes Secret to update; saved Secret is not echoed
// back to the renderer.

type AuthStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

export default function TwitchAuthTab() {
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    void window.api.twitch.getClientCredentials().then((creds) => {
      if (!alive) return;
      setClientIdInput(creds.clientId ?? '');
      setHasSecret(creds.hasSecret);
    }).catch((err) => {
      console.warn('[twitch-auth] initial load failed:', err);
    });
    return () => { alive = false; };
  }, []);

  const handleSave = useCallback(async () => {
    if (!clientIdInput.trim()) {
      setAuthStatus({ kind: 'error', message: 'Client ID が必要です' });
      return;
    }
    if (!clientSecretInput.trim()) {
      setAuthStatus({ kind: 'error', message: 'Client Secret が必要です(再入力してください)' });
      return;
    }
    setSavingCreds(true);
    setAuthStatus({ kind: 'idle' });
    try {
      const res = await window.api.twitch.setClientCredentials({
        clientId: clientIdInput.trim(),
        clientSecret: clientSecretInput.trim(),
      });
      if (res.ok) {
        setHasSecret(true);
        setClientSecretInput('');
        setAuthStatus({ kind: 'ok', message: '保存しました' });
      } else {
        setAuthStatus({ kind: 'error', message: res.error ?? '保存に失敗しました' });
      }
    } catch (err) {
      setAuthStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingCreds(false);
    }
  }, [clientIdInput, clientSecretInput]);

  const handleClear = useCallback(async () => {
    await window.api.twitch.clearClientCredentials();
    setClientIdInput('');
    setClientSecretInput('');
    setHasSecret(false);
    setAuthStatus({ kind: 'idle' });
  }, []);

  const handleTest = useCallback(async () => {
    setAuthStatus({ kind: 'loading' });
    try {
      const res = await window.api.twitch.testCredentials();
      if (res.ok) {
        setAuthStatus({ kind: 'ok', message: '認証成功' });
      } else {
        setAuthStatus({ kind: 'error', message: res.error ?? '認証失敗' });
      }
    } catch (err) {
      setAuthStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <div className={styles.section}>
      <label className={styles.label}>Twitch 認証</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
            Client ID
          </div>
          <input
            type="text"
            className={styles.input}
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            placeholder="例: abcd1234efgh5678..."
            spellCheck={false}
            autoComplete="off"
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
            Client Secret
            {hasSecret ? (
              <span style={{ color: 'var(--accent-success)', marginLeft: 6 }}>✓ 設定済み</span>
            ) : (
              <span style={{ color: 'var(--accent-danger)', marginLeft: 6 }}>⚠ 未設定</span>
            )}
          </div>
          <input
            type="password"
            className={styles.input}
            value={clientSecretInput}
            onChange={(e) => setClientSecretInput(e.target.value)}
            placeholder={hasSecret ? '(変更する場合のみ入力)' : 'Client Secret を入力'}
            spellCheck={false}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={styles.saveButton}
            onClick={handleSave}
            disabled={savingCreds}
          >
            {savingCreds ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={handleTest}
            disabled={!hasSecret || authStatus.kind === 'loading'}
            title={!hasSecret ? 'Secret を保存してから認証テストできます' : ''}
          >
            {authStatus.kind === 'loading' ? '認証中…' : '認証テスト'}
          </button>
          {hasSecret && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={handleClear}
            >
              クリア
            </button>
          )}
        </div>
        {authStatus.kind === 'ok' && (
          <div className={styles.statusOk}>
            <Check size={14} className={styles.statusIcon} />
            <span>{authStatus.message}</span>
          </div>
        )}
        {authStatus.kind === 'error' && (
          <div className={styles.error}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {authStatus.message}
          </div>
        )}
        <div className={styles.help}>
          Client ID / Secret は{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>https://dev.twitch.tv/console</span>{' '}
          で「Application を登録」して取得します。OAuth Redirect URL は
          「http://localhost」を指定すれば OK(本機能は Client Credentials flow のみ使用、ユーザログイン不要)。
          <br />
          <strong>※ Client Secret は暗号化保存され、画面に再表示されません。</strong>
          <br />
          <br />
          配信者の登録は メニュー → 登録チャンネル(Ctrl+Shift+M) から行えます。
        </div>
      </div>
    </div>
  );
}
