import React from 'react';
import { RotateCcw } from 'lucide-react';
import { FreqScale } from '../types/preferences';
import { formatFrequency } from '../utils/music';

interface FrequencyZoomControlsProps {
  minFreq: number;
  maxFreq: number;
  nyquist: number;
  freqScale: FreqScale;
  onRangeChange: (minFreq: number, maxFreq: number) => void;
  onScaleChange: (scale: FreqScale) => void;
}

export const FrequencyZoomControls: React.FC<FrequencyZoomControlsProps> = ({
  minFreq,
  maxFreq,
  nyquist,
  freqScale,
  onRangeChange,
  onScaleChange,
}) => {
  const maxSliderHz = Math.max(1000, Math.floor(nyquist / 100) * 100);
  const defaultMaxHz = Math.min(20000, maxSliderHz);

  // Map 0 on slider to 20 Hz floor, and multiples of 100 Hz otherwise
  const sliderToHz = (val: number) => (val <= 0 ? 20 : val);
  const hzToSlider = (hz: number) =>
    hz <= 20 ? 0 : Math.min(maxSliderHz, Math.round(hz / 100) * 100);

  const minSliderVal = Math.min(maxSliderHz - 100, hzToSlider(minFreq));
  const maxSliderVal = Math.max(minSliderVal + 100, hzToSlider(maxFreq));

  const minPct = (minSliderVal / maxSliderHz) * 100;
  const maxPct = (maxSliderVal / maxSliderHz) * 100;

  const isZoomed = minFreq > 25 || Math.abs(maxFreq - defaultMaxHz) > 150;

  const handleMinSlide = (rawVal: number) => {
    const snapped = Math.min(rawVal, maxSliderVal - 100);
    onRangeChange(sliderToHz(snapped), sliderToHz(maxSliderVal));
  };

  const handleMaxSlide = (rawVal: number) => {
    const snapped = Math.max(rawVal, minSliderVal + 100);
    onRangeChange(sliderToHz(minSliderVal), sliderToHz(snapped));
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(20, rect.width)));
    const span = maxSliderVal - minSliderVal;
    const stepDelta = Math.max(100, Math.round((span * 0.14) / 100) * 100);
    const dir = e.deltaY > 0 ? 1 : -1; // >0 zooms out, <0 zooms in
    const nextMin = Math.max(0, minSliderVal - dir * Math.round((stepDelta * ratio) / 100) * 100);
    const nextMax = Math.min(
      maxSliderHz,
      maxSliderVal + dir * Math.round((stepDelta * (1 - ratio)) / 100) * 100
    );
    if (nextMax - nextMin >= 100) {
      onRangeChange(sliderToHz(nextMin), sliderToHz(nextMax));
    }
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

      <div className="control-group freq-zoom-group">
        <span className="control-label">Freq Range</span>
        <div
          className="dual-range-wrap"
          aria-label="Frequency Zoom Range Slider"
          onWheel={handleWheel}
        >
          <div className="dual-range-track" />
          <div
            className="dual-range-fill"
            style={{
              left: `${minPct}%`,
              width: `${Math.max(0, maxPct - minPct)}%`,
            }}
          />
          <input
            type="range"
            aria-label="Minimum Frequency Hz"
            className="dual-range-input"
            style={{ zIndex: minSliderVal > maxSliderHz - 1200 ? 4 : 2 }}
            min={0}
            max={maxSliderHz}
            step={100}
            value={minSliderVal}
            onChange={(e) => handleMinSlide(Number(e.target.value))}
          />
          <input
            type="range"
            aria-label="Maximum Frequency Hz"
            className="dual-range-input"
            style={{ zIndex: 3 }}
            min={0}
            max={maxSliderHz}
            step={100}
            value={maxSliderVal}
            onChange={(e) => handleMaxSlide(Number(e.target.value))}
          />
        </div>
        <span className="mono-val freq-range-readout">
          {formatFrequency(minFreq)} – {formatFrequency(maxFreq)}
        </span>
        <button
          type="button"
          className="btn btn-icon-only"
          disabled={!isZoomed}
          style={{ opacity: isZoomed ? 1 : 0.35, cursor: isZoomed ? 'pointer' : 'default' }}
          title="Reset Zoom"
          aria-label="Reset Frequency Zoom"
          onClick={() => onRangeChange(20, defaultMaxHz)}
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </>
  );
};
