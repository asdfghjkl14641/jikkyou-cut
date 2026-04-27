import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../../common/config';
import type { ApiKeyValidationResult } from '../../../common/types';

export type SettingsView = {
  config: AppConfig;
  hasApiKey: boolean;
};

export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [config, hasApiKey] = await Promise.all([
        window.api.getSettings(),
        window.api.hasApiKey(),
      ]);
      if (alive) {
        setView({ config, hasApiKey });
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
      prev ? { ...prev, config: next } : { config: next, hasApiKey: false },
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

  return { view, loading, save, validateApiKey, setApiKey, clearApiKey };
}
