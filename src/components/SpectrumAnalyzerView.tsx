import {
  Download,
  Mic,
  Pause,
  Play,
  Radio,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  OctaveSmoothing,
  SpectrumAnalyzerPreferences,
  TiltSlope,
} from '../types/preferences';
import {
  exportCanvasToPNG,
  formatSpectrumCSV,
  formatSpectrumJSON,
  triggerFileDownload,
} from '../utils/exporters';
import {
  clampFreqRange,
  formatFrequency,
  freqToNorm,
  frequencyToNoteInfo,
  normToFreq,
  timeConstantMsToAlpha,
} from '../utils/music';
import { dspBridge } from '../wasm/dspBridge';
import { DbRangeControls } from './DbRangeControls';
import { FrequencyZoomControls } from './FrequencyZoomControls';

interface SpectrumAnalyzerViewProps {
  prefs: SpectrumAnalyzerPreferences;
  fftSize: number;
  sampleRate: number;
  isAudioActive: boolean;
  latestBinsRef: React.MutableRefObject<Float32Array>;
  frameTick: number;
  onUpdatePrefs: (patch: Partial<SpectrumAnalyzerPreferences>) => void;
  onStartMic: () => void;
  onStartDemo: () => void;
}

const OCTAVE_OPTIONS: { value: OctaveSmoothing; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 24, label: '1/24' },
  { value: 12, label: '1/12' },
  { value: 6, label: '1/6' },
  { value: 3, label: '1/3' },
  { value: 2, label: '1/2' },
];

const TILT_OPTIONS: { value: TiltSlope; label: string }[] = [
  { value: 0, label: 'Flat' },
  { value: 3, label: '+3dB' },
  { value: 4.5, label: '+4.5dB' },
];

export const SpectrumAnalyzerView: React.FC<SpectrumAnalyzerViewProps> = ({
  prefs,
  fftSize,
  sampleRate,
  isAudioActive,
  latestBinsRef,
  frameTick,
  onUpdatePrefs,
  onStartMic,
  onStartDemo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 420 });
  const [controlsOpen, setControlsOpen] = useState(true);
  const [isPaused, setIsPaused] = useState(false);

  // DSP buffers
  const timeSmoothedRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const octaveSmoothedRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const peakHoldRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const lastFrameMsRef = useRef<number>(performance.now());

  // Cursor / touch zoom & pan state
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const [cursorReadout, setCursorReadout] = useState<{
    freq: number;
    db: number;
    note: string;
  } | null>(null);

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startMin: number;
    startMax: number;
  } | null>(null);

  const pinchRef = useRef<{
    initialDist: number;
    centerFreq: number;
    startMin: number;
    startMax: number;
  } | null>(null);

  const nyquist = sampleRate / 2;

  // Resize buffers when FFT size changes
  useEffect(() => {
    const bins = fftSize / 2;
    timeSmoothedRef.current = new Float32Array(bins).fill(-110);
    octaveSmoothedRef.current = new Float32Array(bins).fill(-110);
    peakHoldRef.current = new Float32Array(bins).fill(-110);
  }, [fftSize]);

  // Collapse mobile drawer by default on small viewports
  useEffect(() => {
    if (window.innerWidth <= 900 || window.innerHeight <= 540) {
      setControlsOpen(false);
    }
  }, []);

  // Observe canvas container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetPeakHold = useCallback(() => {
    peakHoldRef.current.fill(-120);
  }, []);

  // Process DSP & render canvas whenever a frame arrives or settings/size change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.floor(size.width * dpr);
    const targetH = Math.floor(size.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const raw = latestBinsRef.current;
    const numBins = Math.min(raw.length, timeSmoothedRef.current.length);
    const nowMs = performance.now();
    const dtMs = nowMs - lastFrameMsRef.current;
    lastFrameMsRef.current = nowMs;

    if (isAudioActive && numBins > 0) {
      if (!isPaused) {
        const alpha = timeConstantMsToAlpha(prefs.timeSmoothingMs, dtMs);
        dspBridge.applyTimeSmoothing(raw, timeSmoothedRef.current, alpha);
      }
      dspBridge.applyOctaveSmoothing(
        timeSmoothedRef.current,
        octaveSmoothedRef.current,
        prefs.octaveSmoothing
      );
      if (prefs.showPeakHold && !isPaused) {
        dspBridge.updatePeakHold(
          octaveSmoothedRef.current,
          peakHoldRef.current,
          prefs.peakDecayRate
        );
      }
    }

    const w = size.width;
    const h = size.height;
    const padLeft = 46;
    const padRight = 14;
    const padTop = 18;
    const padBottom = 28;
    const plotW = Math.max(10, w - padLeft - padRight);
    const plotH = Math.max(10, h - padTop - padBottom);

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#060a12';
    ctx.fillRect(0, 0, w, h);

    // Plot area background
    ctx.fillStyle = '#09101d';
    ctx.fillRect(padLeft, padTop, plotW, plotH);

    // Grid lines: Horizontal dB
    ctx.lineWidth = 1;
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const dbMin = prefs.minDb;
    const dbMax = prefs.maxDb;
    const dbSpan = Math.max(10, dbMax - dbMin);
    const dbStep = dbSpan <= 40 ? 10 : 20;
    const firstGridDb = Math.ceil(dbMin / dbStep) * dbStep;

    for (let db = firstGridDb; db <= dbMax; db += dbStep) {
      const y = padTop + ((dbMax - db) / dbSpan) * plotH;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.fillText(`${db}`, padLeft - 6, y);
    }

    // Grid lines: Vertical Frequency
    const freqTicks =
      prefs.freqScale === 'log'
        ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        : Array.from({ length: 9 }, (_, idx) =>
            prefs.minFreq + ((idx + 1) / 10) * (prefs.maxFreq - prefs.minFreq)
          );

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of freqTicks) {
      if (f < prefs.minFreq || f > prefs.maxFreq) continue;
      const norm = freqToNorm(f, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const x = padLeft + norm * plotW;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      const label = f >= 1000 ? `${(f / 1000).toFixed(f % 1000 === 0 ? 0 : 1)}k` : `${Math.round(f)}`;
      ctx.fillText(label, x, padTop + plotH + 6);
    }

    // Clip to plot region for spectrum curves
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    const binWidth = sampleRate / fftSize;
    const displayData = octaveSmoothedRef.current;

    const mapDbToY = (db: number) => {
      const clamped = Math.max(dbMin, Math.min(dbMax, db));
      return padTop + ((dbMax - clamped) / dbSpan) * plotH;
    };

    const tiltOffset = (freqHz: number) =>
      prefs.tiltSlope ? prefs.tiltSlope * Math.log2(Math.max(20, freqHz) / 1000) : 0;

    // Sample pixel column using max-pooling when multiple FFT bins fall within 1 pixel
    // (critical above ~1 kHz on log axes so narrow peaks are never skipped)
    const sampleColumnDb = (arr: Float32Array, px: number): number => {
      const fCenter = normToFreq(px / plotW, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const f0 = normToFreq(
        Math.max(0, px - 0.5) / plotW,
        prefs.minFreq,
        prefs.maxFreq,
        prefs.freqScale
      );
      const f1 = normToFreq(
        Math.min(plotW, px + 0.5) / plotW,
        prefs.minFreq,
        prefs.maxFreq,
        prefs.freqScale
      );
      const bStart = Math.max(1, Math.min(numBins - 1, Math.floor(f0 / binWidth)));
      const bEnd = Math.max(1, Math.min(numBins - 1, Math.floor(f1 / binWidth)));

      let rawDb: number;
      if (bEnd > bStart) {
        rawDb = -160;
        for (let b = bStart; b <= bEnd; b++) {
          if (arr[b] > rawDb) rawDb = arr[b];
        }
      } else {
        const bf = fCenter / binWidth;
        const b0 = Math.max(1, Math.min(numBins - 1, Math.floor(bf)));
        const b1 = Math.max(1, Math.min(numBins - 1, Math.ceil(bf)));
        const frac = bf - b0;
        rawDb = arr[b0] * (1 - frac) + arr[b1] * frac;
      }
      return rawDb + tiltOffset(fCenter);
    };

    // Draw Peak Hold curve
    if (prefs.showPeakHold && isAudioActive && numBins > 1) {
      ctx.beginPath();
      for (let px = 0; px <= plotW; px += 1) {
        const x = padLeft + px;
        const y = mapDbToY(sampleColumnDb(peakHoldRef.current, px));
        if (px === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    // Draw Live Spectrum Curve
    if (isAudioActive && numBins > 1) {
      ctx.beginPath();
      let firstX = padLeft;
      let lastX = padLeft;

      for (let px = 0; px <= plotW; px += 1) {
        const x = padLeft + px;
        const y = mapDbToY(sampleColumnDb(displayData, px));
        if (px === 0) {
          firstX = x;
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }

      if (prefs.fillArea) {
        ctx.save();
        ctx.lineTo(lastX, padTop + plotH);
        ctx.lineTo(firstX, padTop + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, 'rgba(34, 211, 238, 0.42)');
        grad.addColorStop(0.6, 'rgba(59, 130, 246, 0.18)');
        grad.addColorStop(1, 'rgba(139, 92, 246, 0.02)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    // Cursor Crosshair
    const cur = cursorRef.current;
    if (
      cur &&
      cur.x >= padLeft &&
      cur.x <= padLeft + plotW &&
      cur.y >= padTop &&
      cur.y <= padTop + plotH
    ) {
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cur.x, padTop);
      ctx.lineTo(cur.x, padTop + plotH);
      ctx.moveTo(padLeft, cur.y);
      ctx.lineTo(padLeft + plotW, cur.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore(); // unclip

    // Plot border
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    ctx.restore();
  }, [frameTick, isAudioActive, isPaused, prefs, sampleRate, fftSize, size, latestBinsRef]);

  const updateCursorFromClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    cursorRef.current = { x, y };

    const padLeft = 46;
    const padRight = 14;
    const padTop = 18;
    const padBottom = 28;
    const plotW = Math.max(10, rect.width - padLeft - padRight);
    const plotH = Math.max(10, rect.height - padTop - padBottom);

    if (x < padLeft || x > padLeft + plotW || y < padTop || y > padTop + plotH) {
      setCursorReadout(null);
      return;
    }

    const normX = (x - padLeft) / plotW;
    const normY = (y - padTop) / plotH;
    const freq = normToFreq(normX, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const db = prefs.maxDb - normY * Math.max(10, prefs.maxDb - prefs.minDb);
    const noteInfo = frequencyToNoteInfo(freq);
    const noteStr = noteInfo
      ? `${noteInfo.label} ${noteInfo.cents >= 0 ? '+' : ''}${noteInfo.cents.toFixed(0)}¢`
      : '—';

    setCursorReadout({ freq, db, note: noteStr });
  };

  // Wheel Zoom centered at cursor frequency
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padLeft = 46;
    const plotW = Math.max(10, rect.width - padLeft - 14);
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left - padLeft) / plotW));

    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
    if (prefs.freqScale === 'log') {
      const logMin = Math.log10(Math.max(20, prefs.minFreq));
      const logMax = Math.log10(Math.max(21, prefs.maxFreq));
      const logCenter = logMin + norm * (logMax - logMin);
      const nextSpan = Math.max(0.08, Math.min(Math.log10(nyquist / 20), (logMax - logMin) * zoomFactor));
      const newMin = Math.pow(10, logCenter - norm * nextSpan);
      const newMax = Math.pow(10, logCenter + (1 - norm) * nextSpan);
      const [lo, hi] = clampFreqRange(newMin, newMax, nyquist);
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    } else {
      const span = prefs.maxFreq - prefs.minFreq;
      const center = prefs.minFreq + norm * span;
      const nextSpan = Math.max(40, Math.min(nyquist - 20, span * zoomFactor));
      const [lo, hi] = clampFreqRange(center - norm * nextSpan, center + (1 - norm) * nextSpan, nyquist);
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startMin: prefs.minFreq,
      startMax: prefs.maxFreq,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    updateCursorFromClient(e.clientX, e.clientY);
    if (!dragRef.current?.active || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const plotW = Math.max(10, rect.width - 60);
    const dxNorm = (e.clientX - dragRef.current.startX) / plotW;

    if (prefs.freqScale === 'log') {
      const logMin = Math.log10(Math.max(20, dragRef.current.startMin));
      const logMax = Math.log10(Math.max(21, dragRef.current.startMax));
      const span = logMax - logMin;
      let nextLogMin = logMin - dxNorm * span;
      let nextLogMax = logMax - dxNorm * span;
      const absMinLog = Math.log10(20);
      const absMaxLog = Math.log10(nyquist);
      if (nextLogMin < absMinLog) {
        nextLogMin = absMinLog;
        nextLogMax = absMinLog + span;
      }
      if (nextLogMax > absMaxLog) {
        nextLogMax = absMaxLog;
        nextLogMin = absMaxLog - span;
      }
      const [lo, hi] = clampFreqRange(Math.pow(10, nextLogMin), Math.pow(10, nextLogMax), nyquist);
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    } else {
      const span = dragRef.current.startMax - dragRef.current.startMin;
      let nextMin = dragRef.current.startMin - dxNorm * span;
      let nextMax = dragRef.current.startMax - dxNorm * span;
      if (nextMin < 20) {
        nextMin = 20;
        nextMax = 20 + span;
      }
      if (nextMax > nyquist) {
        nextMax = nyquist;
        nextMin = nyquist - span;
      }
      const [lo, hi] = clampFreqRange(nextMin, nextMax, nyquist);
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleMouseUp = () => {
    dragRef.current = null;
  };

  // Touch support: single-finger pan & two-finger pinch-to-zoom
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      updateCursorFromClient(t.clientX, t.clientY);
      dragRef.current = {
        active: true,
        startX: t.clientX,
        startMin: prefs.minFreq,
        startMax: prefs.maxFreq,
      };
      pinchRef.current = null;
    } else if (e.touches.length === 2 && canvasRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
      const plotW = Math.max(10, rect.width - 60);
      const norm = Math.max(0, Math.min(1, (midX - 46) / plotW));
      const centerFreq = normToFreq(norm, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      pinchRef.current = {
        initialDist: Math.max(10, dist),
        centerFreq,
        startMin: prefs.minFreq,
        startMax: prefs.maxFreq,
      };
      dragRef.current = null;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1 && dragRef.current?.active && canvasRef.current) {
      const t = e.touches[0];
      updateCursorFromClient(t.clientX, t.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const plotW = Math.max(10, rect.width - 60);
      const dxNorm = (t.clientX - dragRef.current.startX) / plotW;
      const span = dragRef.current.startMax - dragRef.current.startMin;
      if (prefs.freqScale === 'log') {
        const logMin = Math.log10(Math.max(20, dragRef.current.startMin));
        const logMax = Math.log10(Math.max(21, dragRef.current.startMax));
        const lSpan = logMax - logMin;
        const [lo, hi] = clampFreqRange(
          Math.pow(10, logMin - dxNorm * lSpan),
          Math.pow(10, logMax - dxNorm * lSpan),
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      } else {
        const [lo, hi] = clampFreqRange(
          dragRef.current.startMin - dxNorm * span,
          dragRef.current.startMax - dxNorm * span,
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      }
    } else if (e.touches.length === 2 && pinchRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = pinchRef.current.initialDist / Math.max(10, dist);
      if (prefs.freqScale === 'log') {
        const lMin = Math.log10(Math.max(20, pinchRef.current.startMin));
        const lMax = Math.log10(Math.max(21, pinchRef.current.startMax));
        const lCenter = Math.log10(Math.max(20, pinchRef.current.centerFreq));
        const newSpan = Math.max(0.08, Math.min(Math.log10(nyquist / 20), (lMax - lMin) * scale));
        const ratio = (lCenter - lMin) / Math.max(0.001, lMax - lMin);
        const [lo, hi] = clampFreqRange(
          Math.pow(10, lCenter - ratio * newSpan),
          Math.pow(10, lCenter + (1 - ratio) * newSpan),
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      } else {
        const span = pinchRef.current.startMax - pinchRef.current.startMin;
        const newSpan = Math.max(40, Math.min(nyquist - 20, span * scale));
        const ratio = (pinchRef.current.centerFreq - pinchRef.current.startMin) / Math.max(1, span);
        const [lo, hi] = clampFreqRange(
          pinchRef.current.centerFreq - ratio * newSpan,
          pinchRef.current.centerFreq + (1 - ratio) * newSpan,
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      }
    }
  };

  const handleTouchEnd = () => {
    dragRef.current = null;
    pinchRef.current = null;
  };

  const handleExportPNG = () => {
    if (canvasRef.current) exportCanvasToPNG(canvasRef.current, 'spectral_analyzer');
  };

  const handleExportCSV = () => {
    const csv = formatSpectrumCSV(
      octaveSmoothedRef.current,
      prefs.showPeakHold ? peakHoldRef.current : null,
      sampleRate,
      fftSize,
      prefs
    );
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(csv, `spectral_analyzer_${ts}.csv`, 'text/csv;charset=utf-8;');
  };

  const handleExportJSON = () => {
    const json = formatSpectrumJSON(
      octaveSmoothedRef.current,
      prefs.showPeakHold ? peakHoldRef.current : null,
      sampleRate,
      fftSize,
      prefs
    );
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(json, `spectral_analyzer_${ts}.json`, 'application/json');
  };

  const octLabel =
    prefs.octaveSmoothing === 0 ? 'Off' : `1/${prefs.octaveSmoothing} Oct`;

  return (
    <div className="viz-view">
      <div className="canvas-stage" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="viz-canvas"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            cursorRef.current = null;
            setCursorReadout(null);
            handleMouseUp();
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />

        <div className="canvas-hud-top-left">
          {isPaused && (
            <div
              className="hud-pill"
              style={{
                color: '#fda4af',
                borderColor: 'rgba(244, 63, 94, 0.5)',
              }}
            >
              <strong>PAUSED</strong>
            </div>
          )}
          <div className="hud-pill">
            <span>Range</span>
            <strong>
              {formatFrequency(prefs.minFreq)} – {formatFrequency(prefs.maxFreq)}
            </strong>
          </div>
          <div className="hud-pill">
            <span>Octave</span>
            <strong>{octLabel}</strong>
          </div>
          {cursorReadout && (
            <div className="hud-pill">
              <strong>{formatFrequency(cursorReadout.freq)}</strong>
              <span>({cursorReadout.note})</span>
              <strong>{cursorReadout.db.toFixed(1)} dB</strong>
            </div>
          )}
        </div>

        {!isAudioActive && (
          <div className="empty-audio-overlay">
            <h3>Spectrum Analyzer Ready</h3>
            <p>
              Start your microphone for real-time acoustic analysis or launch the built-in
              synthetic test signal. Drag or pinch to pan &amp; scroll/wheel to zoom frequency ranges.
            </p>
            <div className="empty-overlay-actions">
              <button type="button" className="btn btn-primary" onClick={onStartMic}>
                <Mic size={15} /> Start Microphone
              </button>
              <button type="button" className="btn" onClick={onStartDemo}>
                <Radio size={15} /> Run Demo Signal
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Mobile Portrait/Landscape Toggle Rail */}
      <div className="controls-mobile-bar">
        <span
          className="mobile-summary-text"
          style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}
        >
          {octLabel} • {prefs.timeSmoothingMs}ms • {prefs.freqScale.toUpperCase()}
        </span>
        <div className="mobile-bar-actions">
          <button
            type="button"
            className={`btn btn-icon-only-landscape ${isPaused ? 'btn-active-mic' : ''}`}
            disabled={!isAudioActive}
            aria-label={isPaused ? 'Resume Spectrum Analyzer' : 'Pause Spectrum Analyzer'}
            title={isPaused ? 'Resume' : 'Pause'}
            onClick={() => setIsPaused((p) => !p)}
          >
            {isPaused ? <Play size={14} /> : <Pause size={14} />}
            <span className="mobile-portrait-label">
              {isPaused ? 'Resume' : 'Pause'}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-icon-only"
            aria-expanded={controlsOpen}
            aria-label="Toggle Analyzer Controls"
            title="Toggle Analyzer Controls"
            onClick={() => setControlsOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      <div className={`controls-dock ${controlsOpen ? '' : 'collapsed'}`}>
        <div className="control-group">
          <span className="control-label">Octave Smooth</span>
          <div className="segmented" role="group" aria-label="Octave Smoothing">
            {OCTAVE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`seg-btn ${prefs.octaveSmoothing === opt.value ? 'active' : ''}`}
                onClick={() => onUpdatePrefs({ octaveSmoothing: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="control-label">Slope</span>
          <div className="segmented" role="group" aria-label="Spectral Tilt">
            {TILT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`seg-btn ${(prefs.tiltSlope ?? 0) === opt.value ? 'active' : ''}`}
                onClick={() => onUpdatePrefs({ tiltSlope: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="control-label">Time Smooth</span>
          <input
            type="range"
            aria-label="Spectrum Time Smoothing"
            className="range-slider"
            min={0}
            max={300}
            step={10}
            value={prefs.timeSmoothingMs}
            onChange={(e) => onUpdatePrefs({ timeSmoothingMs: Number(e.target.value) })}
          />
          <span className="mono-val">{prefs.timeSmoothingMs} ms</span>
        </div>

        <FrequencyZoomControls
          minFreq={prefs.minFreq}
          maxFreq={prefs.maxFreq}
          nyquist={nyquist}
          freqScale={prefs.freqScale}
          onRangeChange={(minFreq, maxFreq) => onUpdatePrefs({ minFreq, maxFreq })}
          onScaleChange={(freqScale) => onUpdatePrefs({ freqScale })}
        />

        <DbRangeControls
          minDb={prefs.minDb}
          maxDb={prefs.maxDb}
          onChange={(minDb, maxDb) => onUpdatePrefs({ minDb, maxDb })}
        />

        <div className="control-group">
          <button
            type="button"
            className={`btn desktop-only-btn ${isPaused ? 'btn-active-mic' : ''}`}
            disabled={!isAudioActive}
            onClick={() => setIsPaused((p) => !p)}
          >
            {isPaused ? <Play size={13} /> : <Pause size={13} />}
            <span>{isPaused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            className={`btn ${prefs.showPeakHold ? 'btn-active-demo' : ''}`}
            onClick={() => onUpdatePrefs({ showPeakHold: !prefs.showPeakHold })}
          >
            Peak Hold
          </button>
          {prefs.showPeakHold && (
            <button
              type="button"
              className="btn btn-icon-only"
              title="Clear Peak Hold"
              aria-label="Clear Peak Hold"
              onClick={resetPeakHold}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>

        <div className="export-group">
          <span className="control-label">Export</span>
          <button type="button" className="btn" onClick={handleExportPNG}>
            <Download size={13} /> PNG
          </button>
          <button type="button" className="btn" onClick={handleExportCSV}>
            <Download size={13} /> CSV
          </button>
          <button type="button" className="btn" onClick={handleExportJSON}>
            <Download size={13} /> JSON
          </button>
        </div>
      </div>
    </div>
  );
};
