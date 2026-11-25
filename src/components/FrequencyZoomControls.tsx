import React from 'react';
import { RotateCcw } from 'lucide-react';
import { FreqScale } from '../types/preferences';
import { clampFreqRange } from '../utils/music';

interface FrequencyZoomControlsProps {
  minFreq: number;
  maxFreq: number;
  nyquist: number;
  freqScale: FreqScale;
  onRangeChange: (minFreq: number, maxFreq: number) => void;
  onScaleChange: (scale: FreqScale) => void;
}

const PRESETS: { label: string; min: number; max: number }[] = [
  { label: 'Full', min: 20, max: 20000 },
  { label: 'Bass', min: 20, max: 250 },
  { label: 'Mid', min: 200, max: 4000 },
  { label: 'High', min: 2000, max: 20000 },
];

export const FrequencyZoomControls: React.FC<FrequencyZoomControlsProps> = ({
  minFreq,
  maxFreq,
  nyquist,
  freqScale,
  onRangeChange,
  onScaleChange,
}) => {
  const defaultMax = Math.min(20000, Math.round(nyquist));
  const isZoomed = minFreq > 22 || maxFreq < defaultMax - 50;

  const handleMinChange = (val: number) => {
    if (!Number.isFinite(val)) return;
    const [lo, hi] = clampFreqRange(val, maxFreq, nyquist);
    onRangeChange(lo, hi);
  };

  const handleMaxChange = (val: number) => {
    if (!Number.isFinite(val)) return;
    const [lo, hi] = clampFreqRange(minFreq, val, nyquist);
    onRangeChange(lo, hi);
  };

  return (
    <>
      <div className="control-group">
        <span className="control-label">Scale</span>
        <div className="segmented" role="group" aria-label="Frequency Scale">
          <button
            type="button"
            className={`seg-btn ${freqScale === 'log' ? 'active' : ''}`}
            onClick={() => onScaleChange('log')}
          >
            Log
          </button>
          <button
            type="button"
            className={`seg-btn ${freqScale === 'linear' ? 'active' : ''}`}
            onClick={() => onScaleChange('linear')}
          >
            Linear
          </button>
        </div>
      </div>

      <div className="control-group">
        <span className="control-label">Freq Hz</span>
        <input
          type="number"
          aria-label="Minimum Frequency Hz"
          className="input-compact freq-input"
          min={20}
          max={Math.max(40, maxFreq - 20)}
          value={Math.round(minFreq)}
          onChange={(e) => handleMinChange(Number(e.target.value))}
        />
        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>–</span>
        <input
          type="number"
          aria-label="Maximum Frequency Hz"
          className="input-compact freq-input"
          min={minFreq + 20}
          max={Math.round(nyquist)}
          value={Math.round(maxFreq)}
          onChange={(e) => handleMaxChange(Number(e.target.value))}
        />
        <div className="segmented" role="group" aria-label="Frequency Zoom Presets">
          {PRESETS.map((p) => {
            const targetMax = Math.min(p.max, Math.round(nyquist));
            const active =
              Math.abs(minFreq - p.min) < 5 && Math.abs(maxFreq - targetMax) < 50;
            return (
              <button
                key={p.label}
                type="button"
                className={`seg-btn ${active ? 'active' : ''}`}
                onClick={() => onRangeChange(p.min, targetMax)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {isZoomed && (
          <button
            type="button"
            className="btn btn-icon-only"
            title="Reset Zoom"
            aria-label="Reset Frequency Zoom"
            onClick={() => onRangeChange(20, defaultMax)}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    </>
  );
};
