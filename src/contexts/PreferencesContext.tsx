import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { usePreferences } from '../hooks/usePreferences';
import {
  AppTab,
  AudioPreferences,
  MusicalTunerPreferences,
  SpectrogramPreferences,
  SpectrumAnalyzerPreferences,
  UserPreferences,
} from '../types/preferences';

interface PreferencesContextValue {
  preferences: UserPreferences;
  updatePreferences: (updater: (prev: UserPreferences) => UserPreferences) => void;
  resetPreferences: () => void;
  setActiveTab: (tab: AppTab) => void;
  updateAudioPrefs: (patch: Partial<AudioPreferences>) => void;
  updateAnalyzerPrefs: (patch: Partial<SpectrumAnalyzerPreferences>) => void;
  updateSpectrogramPrefs: (patch: Partial<SpectrogramPreferences>) => void;
  updateTunerPrefs: (patch: Partial<MusicalTunerPreferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export const PreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { preferences, updatePreferences, resetPreferences } = usePreferences();

  const setActiveTab = useCallback(
    (activeTab: AppTab) => {
      updatePreferences((prev) => ({ ...prev, activeTab }));
    },
    [updatePreferences]
  );

  const updateAudioPrefs = useCallback(
    (patch: Partial<AudioPreferences>) => {
      updatePreferences((prev) => ({
        ...prev,
        audio: { ...prev.audio, ...patch },
      }));
    },
    [updatePreferences]
  );

  const updateAnalyzerPrefs = useCallback(
    (patch: Partial<SpectrumAnalyzerPreferences>) => {
      updatePreferences((prev) => ({
        ...prev,
        analyzer: { ...prev.analyzer, ...patch },
      }));
    },
    [updatePreferences]
  );

  const updateSpectrogramPrefs = useCallback(
    (patch: Partial<SpectrogramPreferences>) => {
      updatePreferences((prev) => ({
        ...prev,
        spectrogram: { ...prev.spectrogram, ...patch },
      }));
    },
    [updatePreferences]
  );

  const updateTunerPrefs = useCallback(
    (patch: Partial<MusicalTunerPreferences>) => {
      updatePreferences((prev) => ({
        ...prev,
        tuner: { ...prev.tuner, ...patch },
      }));
    },
    [updatePreferences]
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences,
      resetPreferences,
      setActiveTab,
      updateAudioPrefs,
      updateAnalyzerPrefs,
      updateSpectrogramPrefs,
      updateTunerPrefs,
    }),
    [
      preferences,
      updatePreferences,
      resetPreferences,
      setActiveTab,
      updateAudioPrefs,
      updateAnalyzerPrefs,
      updateSpectrogramPrefs,
      updateTunerPrefs,
    ]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
};

export function usePreferencesContext(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error('usePreferencesContext must be used within a PreferencesProvider');
  }
  return ctx;
}
