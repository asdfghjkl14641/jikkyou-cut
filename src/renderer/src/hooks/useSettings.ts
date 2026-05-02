import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../../common/config';
import type { ApiKeyValidationResult } from '../../../common/types';

export type SettingsView = {
  config: AppConfig;
  hasApiKey: boolean;
  hasAnthropicApiKey: boolean;
};

export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [config, hasApiKey, hasAnthropicApiKey] = await Promise.all([
        window.api.getSettings(),
        window.api.hasApiKey(),
        window.api.hasAnthropicApiKey(),
      ]);
      if (alive) {
        setView({ config, hasApiKey, hasAnthropicApiKey });
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (partial: Partial<AppConfig>) => {
    const next = await window.api.saveSettings(partial);
    setView((prev) =>
      prev ? { ...prev, config: next } : { config: next, hasApiKey: false, hasAnthropicApiKey: false },
    );
    return next;
  }, []);

  const validateApiKey = useCallback(
    (key: string): Promise<ApiKeyValidationResult> =>
      window.api.validateApiKey(key),
    [],
  );

  const setApiKey = useCallback(async (key: string) => {
    await window.api.setApiKey(key);
    setView((prev) =>
      prev ? { ...prev, hasApiKey: true } : null,
    );
  }, []);

  const clearApiKey = useCallback(async () => {
    await window.api.clearApiKey();
    setView((prev) =>
      prev ? { ...prev, hasApiKey: false } : null,
    );
  }, []);

  const validateAnthropicApiKey = useCallback(
    (key: string) => window.api.validateAnthropicApiKey(key),
    [],
  );

  const setAnthropicApiKey = useCallback(async (key: string) => {
    await window.api.setAnthropicApiKey(key);
    setView((prev) =>
      prev ? { ...prev, hasAnthropicApiKey: true } : null,
    );
  }, []);

  const clearAnthropicApiKey = useCallback(async () => {
    await window.api.clearAnthropicApiKey();
    setView((prev) =>
      prev ? { ...prev, hasAnthropicApiKey: false } : null,
    );
  }, []);

  return {
    view,
    loading,
    save,
    validateApiKey,
    setApiKey,
    clearApiKey,
    validateAnthropicApiKey,
    setAnthropicApiKey,
    clearAnthropicApiKey,
  };
}
