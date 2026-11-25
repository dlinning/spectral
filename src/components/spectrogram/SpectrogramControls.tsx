import React from 'react';
import { Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useAudio } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { ColormapId, HistoryDurationSec } from '../../types/preferences';
import { COLORMAP_OPTIONS } from '../../utils/colormaps';
import { DbRangeControls } from '../controls/DbRangeControls';
import { ExportControls } from '../controls/ExportControls';
import { FrequencyZoomControls } from '../controls/FrequencyZoomControls';
import { SegmentedControl, SegmentedOption } from '../controls/SegmentedControl';

const HISTORY_OPTIONS: readonly SegmentedOption<HistoryDurationSec>[] = [
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
];

interface SpectrogramControlsProps {
  controlsOpen: boolean;
  nyquist: number;
  frameCount: number;
  maxScrollBackSec: number;
  effectiveScrollBack: number;
  onScrollBackChange: (sec: number) => void;
  onClearHistory: () => void;
  onExportPNG: () => void;
  onExportCSV: () => void;
  onExportJSON: () => void;
}

export const SpectrogramControls: React.FC<SpectrogramControlsProps> = ({
  controlsOpen,
  nyquist,
  frameCount,
  maxScrollBackSec,
  effectiveScrollBack,
  onScrollBackChange,
  onClearHistory,
  onExportPNG,
  onExportCSV,
  onExportJSON,
}) => {
  const { preferences, updateSpectrogramPrefs } = usePreferencesContext();
  const { isAudioActive, spectrogramPaused, toggleSpectrogramPause } = useAudio();
  const prefs = preferences.spectrogram;

  return (
    <div className={`controls-dock ${controlsOpen ? '' : 'collapsed'}`}>
      <div className="control-group">
        <span className="control-label">History</span>
        <SegmentedControl
          ariaLabel="History Duration"
          options={HISTORY_OPTIONS}
          value={prefs.historyDurationSec}
          onChange={(historyDurationSec) => updateSpectrogramPrefs({ historyDurationSec })}
        />
      </div>

      <div className="control-group">
        <span className="control-label">Time Scroll</span>
        <input
          type="range"
          aria-label="Scroll Back in Time"
          className="range-slider"
          disabled={maxScrollBackSec <= 0.1}
          min={0}
          max={Math.max(0.5, Number(maxScrollBackSec.toFixed(1)))}
          step={0.1}
          value={effectiveScrollBack}
          onChange={(e) => onScrollBackChange(Number(e.target.value))}
        />
        <span className="mono-val" style={{ minWidth: 50, textAlign: 'right' }}>
          {effectiveScrollBack <= 0.05 ? 'Live' : `-${effectiveScrollBack.toFixed(1)}s`}
        </span>
        {effectiveScrollBack > 0.05 && (
          <button
            type="button"
            className="btn btn-icon-only"
            title="Jump to Live (0s)"
            aria-label="Jump to Live"
            onClick={() => onScrollBackChange(0)}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      <div className="control-group">
        <span className="control-label">Time Smooth</span>
        <input
          type="range"
          aria-label="Spectrogram Time Smoothing"
          className="range-slider"
          min={0}
          max={300}
          step={10}
          value={prefs.timeSmoothingMs}
          onChange={(e) => updateSpectrogramPrefs({ timeSmoothingMs: Number(e.target.value) })}
        />
        <span className="mono-val">{prefs.timeSmoothingMs} ms</span>
      </div>

      <div className="control-group">
        <span className="control-label">Palette</span>
        <select
          aria-label="Colormap Palette"
          className="select-compact"
          value={prefs.colormap}
          onChange={(e) => updateSpectrogramPrefs({ colormap: e.target.value as ColormapId })}
        >
          {COLORMAP_OPTIONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <FrequencyZoomControls
        minFreq={prefs.minFreq}
        maxFreq={prefs.maxFreq}
        nyquist={nyquist}
        freqScale={prefs.freqScale}
        onRangeChange={(minFreq, maxFreq) => updateSpectrogramPrefs({ minFreq, maxFreq })}
        onScaleChange={(freqScale) => updateSpectrogramPrefs({ freqScale })}
      />

      <DbRangeControls
        minDb={prefs.minDb}
        maxDb={prefs.maxDb}
        defaultMinDb={-95}
        defaultMaxDb={-5}
        onChange={(minDb, maxDb) => updateSpectrogramPrefs({ minDb, maxDb })}
      />

      <div className="control-group">
        <button
          type="button"
          className="btn desktop-only-btn"
          title="Clear Spectrogram History"
          onClick={onClearHistory}
        >
          <Trash2 size={13} /> Clear
        </button>
        <button
          type="button"
          className={`btn desktop-only-btn ${spectrogramPaused ? 'btn-active-mic' : ''}`}
          disabled={!isAudioActive && frameCount === 0}
          title="Pause / Resume (Space)"
          onClick={toggleSpectrogramPause}
        >
          {spectrogramPaused ? <Play size={13} /> : <Pause size={13} />}
          <span>{spectrogramPaused ? 'Resume' : 'Pause'}</span>
        </button>
      </div>

      <ExportControls
        onExportPNG={onExportPNG}
        onExportCSV={onExportCSV}
        onExportJSON={onExportJSON}
      />
    </div>
  );
};
