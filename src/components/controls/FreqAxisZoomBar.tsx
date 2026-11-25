import React, { useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { FreqScale } from '../../types/preferences';
import {
  MAX_DISPLAY_FREQ_HZ,
  clampFreqRange,
  freqToNorm,
  normToFreq,
  zoomFreqRange,
} from '../../utils/music';

interface FreqAxisZoomBarProps {
  minFreq: number;
  maxFreq: number;
  nyquist: number;
  freqScale: FreqScale;
  padLeft?: number;
  padRight?: number;
  onRangeChange: (minFreq: number, maxFreq: number) => void;
}

type DragMode = 'min' | 'max' | 'pan';

export const FreqAxisZoomBar: React.FC<FreqAxisZoomBarProps> = ({
  minFreq,
  maxFreq,
  nyquist,
  freqScale,
  padLeft = 46,
  padRight = 22,
  onRangeChange,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startMin: number;
    startMax: number;
  } | null>(null);

  const absMin = 20;
  const absMax = Math.min(MAX_DISPLAY_FREQ_HZ, Math.max(1000, Math.floor(nyquist / 100) * 100));
  const defaultMaxHz = Math.min(20000, absMax);
  const isZoomed = minFreq > 25 || Math.abs(maxFreq - defaultMaxHz) > 150;

  const snapHz = (hz: number) => {
    if (hz <= 55) return 20;
    return Math.max(100, Math.min(absMax, Math.round(hz / 100) * 100));
  };

  const leftPct = Math.max(0, Math.min(100, freqToNorm(minFreq, absMin, absMax, freqScale) * 100));
  const rightPct = Math.max(
    leftPct,
    Math.min(100, freqToNorm(maxFreq, absMin, absMax, freqScale) * 100)
  );

  const startDrag = (mode: DragMode, clientX: number) => {
    dragRef.current = {
      mode,
      startX: clientX,
      startMin: minFreq,
      startMax: maxFreq,
    };

    const handleMove = (ev: PointerEvent) => {
      if (!dragRef.current || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const width = Math.max(20, rect.width);

      if (dragRef.current.mode === 'min') {
        const norm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / width));
        const rawFreq = normToFreq(norm, absMin, absMax, freqScale);
        const nextMin = Math.min(snapHz(rawFreq), dragRef.current.startMax - 100);
        const [lo, hi] = clampFreqRange(nextMin, dragRef.current.startMax, absMax, 100);
        onRangeChange(lo, hi);
      } else if (dragRef.current.mode === 'max') {
        const norm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / width));
        const rawFreq = normToFreq(norm, absMin, absMax, freqScale);
        const nextMax = Math.max(snapHz(rawFreq), dragRef.current.startMin + 100);
        const [lo, hi] = clampFreqRange(dragRef.current.startMin, nextMax, absMax, 100);
        onRangeChange(lo, hi);
      } else {
        const dxNorm = (ev.clientX - dragRef.current.startX) / width;
        if (freqScale === 'log') {
          const lAbsMin = Math.log10(absMin);
          const lAbsMax = Math.log10(absMax);
          const lStartMin = Math.log10(Math.max(absMin, dragRef.current.startMin));
          const lStartMax = Math.log10(Math.max(absMin + 1, dragRef.current.startMax));
          const span = lStartMax - lStartMin;
          const total = lAbsMax - lAbsMin;
          let nextLo = lStartMin + dxNorm * total;
          let nextHi = lStartMax + dxNorm * total;
          if (nextLo < lAbsMin) {
            nextLo = lAbsMin;
            nextHi = lAbsMin + span;
          }
          if (nextHi > lAbsMax) {
            nextHi = lAbsMax;
            nextLo = lAbsMax - span;
          }
          const [lo, hi] = clampFreqRange(Math.pow(10, nextLo), Math.pow(10, nextHi), absMax, 100);
          onRangeChange(lo, hi);
        } else {
          const span = dragRef.current.startMax - dragRef.current.startMin;
          const total = absMax - absMin;
          let nextLo = dragRef.current.startMin + dxNorm * total;
          let nextHi = dragRef.current.startMax + dxNorm * total;
          if (nextLo < absMin) {
            nextLo = absMin;
            nextHi = absMin + span;
          }
          if (nextHi > absMax) {
            nextHi = absMax;
            nextLo = absMax - span;
          }
          const [lo, hi] = clampFreqRange(nextLo, nextHi, absMax, 100);
          onRangeChange(lo, hi);
        }
      }
    };

    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(20, rect.width)));
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
    const cursorFreq = normToFreq(norm, absMin, absMax, freqScale);
    const [lo, hi] = zoomFreqRange(
      minFreq,
      maxFreq,
      cursorFreq,
      zoomFactor,
      absMax,
      freqScale,
      100
    );
    onRangeChange(lo, hi);
  };

  return (
    <div
      className="freq-axis-zoom-bar"
      style={{ paddingLeft: padLeft, paddingRight: Math.max(10, padRight - 8) }}
      onWheel={handleWheel}
      title="Drag Min/Max handles or scroll mouse wheel to zoom frequency range"
    >
      <div ref={trackRef} className="freq-axis-zoom-track">
        <div
          className="freq-axis-zoom-window"
          style={{
            left: `${leftPct}%`,
            width: `${Math.max(1.5, rightPct - leftPct)}%`,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            startDrag('pan', e.clientX);
          }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="Minimum Frequency Grab Handle"
            aria-valuemin={absMin}
            aria-valuemax={maxFreq - 100}
            aria-valuenow={minFreq}
            className="freq-axis-handle freq-axis-handle-min"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              startDrag('min', e.clientX);
            }}
          />
          <div
            role="slider"
            tabIndex={0}
            aria-label="Maximum Frequency Grab Handle"
            aria-valuemin={minFreq + 100}
            aria-valuemax={absMax}
            aria-valuenow={maxFreq}
            className="freq-axis-handle freq-axis-handle-max"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              startDrag('max', e.clientX);
            }}
          />
        </div>
      </div>

      <button
        type="button"
        className="btn btn-icon-only freq-axis-reset-btn"
        disabled={!isZoomed}
        style={{ opacity: isZoomed ? 1 : 0.35, cursor: isZoomed ? 'pointer' : 'default' }}
        title="Reset Zoom"
        aria-label="Reset Frequency Zoom"
        onClick={() => onRangeChange(absMin, defaultMaxHz)}
      >
        <RotateCcw size={13} />
      </button>
    </div>
  );
};
