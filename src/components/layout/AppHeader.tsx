import React, { useState } from 'react';
import { Activity, BarChart3, Gauge, Mic, MicOff, Settings } from 'lucide-react';
import { useAudio } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { AppTab } from '../../types/preferences';
import { AudioSettingsPopover } from './AudioSettingsPopover';

const NAV_TABS: readonly { id: AppTab; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { id: 'analyzer', label: 'Spectrum Analyzer', Icon: BarChart3 },
  { id: 'spectrograph', label: 'Spectrograph', Icon: Activity },
  { id: 'tuner', label: 'Tuner', Icon: Gauge },
];

export const AppHeader: React.FC = () => {
  const { preferences, setActiveTab } = usePreferencesContext();
  const { sourceKind, startMicrophone, stopAudio } = useAudio();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="app-header">
      <div className="brand-group">
        <img src="./logo/icon.svg" alt="Spectral Logo" className="brand-icon" />
        <div className="brand-text">
          <span className="brand-title">Spectral</span>
        </div>
      </div>

      <nav className="top-tabs" role="tablist" aria-label="Primary Views">
        {NAV_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={preferences.activeTab === id}
            className={`tab-btn ${preferences.activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="audio-controls-bar">
        {sourceKind === 'mic' ? (
          <button type="button" className="btn btn-active-mic" onClick={stopAudio}>
            <MicOff size={14} />
            <span className="desktop-only-label">Stop Mic</span>
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => void startMicrophone()}>
            <Mic size={14} />
            <span className="desktop-only-label">Mic</span>
          </button>
        )}

        <div className="audio-settings-wrapper">
          <button
            type="button"
            className="btn btn-icon-only"
            aria-label="Audio & App Settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings size={15} />
          </button>

          {settingsOpen && <AudioSettingsPopover onClose={() => setSettingsOpen(false)} />}
        </div>
      </div>
    </header>
  );
};
