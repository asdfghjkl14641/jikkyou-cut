import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../../common/config';

export function useSettings() {
  const [settings, setSettings] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    window.api.getSettings().then((s) => {
      if (alive) {
        setSettings(s);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (partial: Partial<AppConfig>) => {
    const next = await window.api.saveSettings(partial);
    setSettings(next);
    return next;
  }, []);

  return { settings, loading, save };
}
