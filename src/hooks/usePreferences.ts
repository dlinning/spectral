import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, UserPreferences } from '../types/preferences';

export const PREFERENCES_STORAGE_KEY = 'spectral_pwa_preferences_v1';

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function mergePreferences(
  stored: unknown,
  defaults: UserPreferences = DEFAULT_PREFERENCES
): UserPreferences {
  if (!isPlainObject(stored)) {
    return structuredClone(defaults);
  }

  const audio = isPlainObject(stored.audio) ? stored.audio : {};
  const analyzer = isPlainObject(stored.analyzer) ? stored.analyzer : {};
  const spectrograph = isPlainObject(stored.spectrograph) ? stored.spectrograph : {};
  const tuner = isPlainObject(stored.tuner) ? stored.tuner : {};

  const validTab =
    stored.activeTab === 'analyzer' ||
    stored.activeTab === 'spectrograph' ||
    stored.activeTab === 'tuner'
      ? stored.activeTab
      : defaults.activeTab;

  return {
    version: 1,
    activeTab: validTab,
    audio: {
      ...defaults.audio,
      ...audio,
    },
    analyzer: {
      ...defaults.analyzer,
      ...analyzer,
    },
    spectrograph: {
      ...defaults.spectrograph,
      ...spectrograph,
    },
    tuner: {
      ...defaults.tuner,
      ...tuner,
    },
  };
}

export function loadPreferences(
  storage: Pick<Storage, 'getItem'> | null = typeof window !== 'undefined'
    ? window.localStorage
    : null
): UserPreferences {
  if (!storage) return structuredClone(DEFAULT_PREFERENCES);
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_PREFERENCES);
    const parsed: unknown = JSON.parse(raw);
    return mergePreferences(parsed);
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

export function savePreferences(
  prefs: UserPreferences,
  storage: Pick<Storage, 'setItem'> | null = typeof window !== 'undefined'
    ? window.localStorage
    : null
): void {
  if (!storage) return;
  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadPreferences());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      savePreferences(preferences);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  // Also flush immediately on page hide/unload so sudden closes don't lose recent tweaks
  useEffect(() => {
    const flush = () => savePreferences(preferences);
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [preferences]);

  const updatePreferences = useCallback((updater: (prev: UserPreferences) => UserPreferences) => {
    setPreferences((prev) => {
      const next = updater(prev);
      savePreferences(next);
      return next;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    const fresh = structuredClone(DEFAULT_PREFERENCES);
    setPreferences(fresh);
    savePreferences(fresh);
  }, []);

  return {
    preferences,
    updatePreferences,
    resetPreferences,
  };
}
