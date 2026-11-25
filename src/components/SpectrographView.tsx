import React, { useEffect, useRef, useState } from 'react';
import { Download, Mic, Radio, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  ColormapId,
  HistoryDurationSec,
  SpectrographPreferences,
} from '../types/preferences';
import { SpectrographBuffer } from '../audio/SpectrographBuffer';
import { COLORMAP_OPTIONS, getColormapLUT } from '../utils/colormaps';
import {
  clampFreqRange,
  formatFrequency,
  freqToNorm,
  frequencyToNoteInfo,
  normToFreq,
} from '../utils/music';
import {
  exportCanvasToPNG,
  formatSpectrographCSV,
  formatSpectrographJSON,
  triggerFileDownload,
} from '../utils/exporters';
import { FrequencyZoomControls } from './FrequencyZoomControls';

interface SpectrographViewProps {
  prefs: SpectrographPreferences;
  buffer: SpectrographBuffer;
  fftSize: number;
  sampleRate: number;
  isAudioActive: boolean;
  frameTick: number;
  onUpdatePrefs: (patch: Partial<SpectrographPreferences>) => void;
  onClearBuffer: () => void;
  onStartMic: () => void;
  onStartDemo: () => void;
}

const HISTORY_OPTIONS: HistoryDurationSec[] = [5, 15, 30, 60];

export const SpectrographView: React.FC<SpectrographViewProps> = ({
  prefs,
  buffer,
  fftSize,
  sampleRate,
  isAudioActive,
  frameTick,
  onUpdatePrefs,
  onClearBuffer,
  onStartMic,
  onStartDemo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  const [size, setSize] = useState({ width: 800, height: 420 });
  const [controlsOpen, setControlsOpen] = useState(true);
  const [hoverInfo, setHoverInfo] = useState<{
    freq: number;
    note: string;
    timeOffsetSec: number;
    db: number | null;
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

  useEffect(() => {
    if (window.innerWidth <= 900 || window.innerHeight <= 540) {
      setControlsOpen(false);
    }
  }, []);

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

  // Re-render spectrograph waterfall from raw 60s ring buffer so zoom, scale,
  // colormap, dynamic range, and history duration always reflect full resolution.
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

    const w = size.width;
    const h = size.height;
    const padLeft = 48;
    const padRight = 52; // Room for dB colorbar legend
    const padTop = 16;
    const padBottom = 28;
    const plotW = Math.max(10, Math.floor(w - padLeft - padRight));
    const plotH = Math.max(10, Math.floor(h - padTop - padBottom));

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear frame
    ctx.fillStyle = '#060a12';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(padLeft, padTop, plotW, plotH);

    const lut = getColormapLUT(prefs.colormap);
    const numBins = buffer.getNumBins();
    const binWidth = sampleRate / fftSize;

    // Precompute horizontal pixel -> FFT bin index lookup for current zoom + scale
    const binLookup = new Float32Array(plotW);
    for (let px = 0; px < plotW; px++) {
      const f = normToFreq(px / Math.max(1, plotW - 1), prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      binLookup[px] = Math.max(1, Math.min(numBins - 1, f / binWidth));
    }

    // Prepare offscreen ImageData
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas');
    }
    const offscreen = offscreenRef.current;
    if (offscreen.width !== plotW || offscreen.height !== plotH) {
      offscreen.width = plotW;
      offscreen.height = plotH;
      imageDataRef.current = null;
    }
    const offCtx = offscreen.getContext('2d');
    if (offCtx) {
      if (!imageDataRef.current) {
        imageDataRef.current = offCtx.createImageData(plotW, plotH);
      }
      const imgData = imageDataRef.current;
      const pixels = imgData.data;

      // Clear background RGBA
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 6;
        pixels[i + 1] = 10;
        pixels[i + 2] = 18;
        pixels[i + 3] = 255;
      }

      const frameCount = buffer.getFrameCount();
      if (frameCount > 0) {
        const latestMs = buffer.getLatestTimestamp();
        const durationMs = prefs.historyDurationSec * 1000;
        const dbSpan = Math.max(10, prefs.maxDb - prefs.minDb);
        const invDbSpan = 255 / dbSpan;

        // Collect frames within window & map each row y (0 = newest top, plotH-1 = oldest bottom)
        // Build index lookup by walking backward from newest frame
        const rowFrameIdx = new Int32Array(plotH).fill(-1);
        let frameCursor = frameCount - 1;

        for (let py = 0; py < plotH; py++) {
          const targetAgeMs = (py / Math.max(1, plotH - 1)) * durationMs;
          const targetTs = latestMs - targetAgeMs;

          while (
            frameCursor > 0 &&
            buffer.getTimestampAt(frameCursor) > targetTs
          ) {
            frameCursor--;
          }

          const ts = buffer.getTimestampAt(frameCursor);
          if (latestMs - ts <= durationMs + 250) {
            rowFrameIdx[py] = frameCursor;
          }
        }

        for (let py = 0; py < plotH; py++) {
          const fIdx = rowFrameIdx[py];
          if (fIdx < 0) continue;
          const frame = buffer.getFrameView(fIdx);
          if (!frame) continue;

          const rowBase = py * plotW * 4;
          for (let px = 0; px < plotW; px++) {
            const bf = binLookup[px];
            const b0 = bf | 0;
            const b1 = b0 + 1 < numBins ? b0 + 1 : b0;
            const frac = bf - b0;
            const db = frame[b0] * (1 - frac) + frame[b1] * frac;
            const colorIdx = Math.max(
              0,
              Math.min(255, Math.round((db - prefs.minDb) * invDbSpan))
            );
            const lutBase = colorIdx * 4;
            const outBase = rowBase + px * 4;
            pixels[outBase] = lut[lutBase];
            pixels[outBase + 1] = lut[lutBase + 1];
            pixels[outBase + 2] = lut[lutBase + 2];
            pixels[outBase + 3] = 255;
          }
        }
      }

      offCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(offscreen, padLeft, padTop);
    }

    // Time Axis Ticks (Left)
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const timeSteps = 5;
    for (let i = 0; i <= timeSteps; i++) {
      const ratio = i / timeSteps;
      const y = padTop + ratio * plotH;
      const sec = -(ratio * prefs.historyDurationSec);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(sec === 0 ? '0s' : `${Math.round(sec)}s`, padLeft - 6, y);
    }

    // Frequency Axis Ticks (Bottom)
    const freqTicks =
      prefs.freqScale === 'log'
        ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        : Array.from({ length: 8 }, (_, idx) =>
            prefs.minFreq + ((idx + 1) / 9) * (prefs.maxFreq - prefs.minFreq)
          );

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of freqTicks) {
      if (f < prefs.minFreq || f > prefs.maxFreq) continue;
      const norm = freqToNorm(f, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const x = padLeft + norm * plotW;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      const label = f >= 1000 ? `${(f / 1000).toFixed(f % 1000 === 0 ? 0 : 1)}k` : `${Math.round(f)}`;
      ctx.fillText(label, x, padTop + plotH + 6);
    }

    // Colorbar Legend (Right)
    const barX = padLeft + plotW + 10;
    const barW = 12;
    for (let py = 0; py < plotH; py++) {
      const cIdx = Math.round((1 - py / Math.max(1, plotH - 1)) * 255);
      const base = cIdx * 4;
      ctx.fillStyle = `rgb(${lut[base]},${lut[base + 1]},${lut[base + 2]})`;
      ctx.fillRect(barX, padTop + py, barW, 1.5);
    }
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.strokeRect(barX, padTop, barW, plotH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${prefs.maxDb}`, barX + barW + 4, padTop + 6);
    ctx.fillText(`${prefs.minDb}`, barX + barW + 4, padTop + plotH - 6);

    // Plot Border
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    ctx.restore();
  }, [frameTick, prefs, buffer, sampleRate, fftSize, size]);

  const inspectAtClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padLeft = 48;
    const padRight = 52;
    const padTop = 16;
    const padBottom = 28;
    const plotW = Math.max(10, rect.width - padLeft - padRight);
    const plotH = Math.max(10, rect.height - padTop - padBottom);
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (x < padLeft || x > padLeft + plotW || y < padTop || y > padTop + plotH) {
      setHoverInfo(null);
      return;
    }

    const normX = (x - padLeft) / plotW;
    const normY = (y - padTop) / plotH;
    const freq = normToFreq(normX, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const timeOffsetSec = -(normY * prefs.historyDurationSec);
    const noteInfo = frequencyToNoteInfo(freq);
    const note = noteInfo ? noteInfo.label : '—';

    // Look up actual magnitude in the buffer if available
    let db: number | null = null;
    const count = buffer.getFrameCount();
    if (count > 0) {
      const latestMs = buffer.getLatestTimestamp();
      const targetTs = latestMs + timeOffsetSec * 1000;
      let chosen = -1;
      for (let i = count - 1; i >= 0; i--) {
        if (buffer.getTimestampAt(i) <= targetTs) {
          chosen = i;
          break;
        }
      }
      if (chosen >= 0) {
        const frame = buffer.getFrameView(chosen);
        if (frame) {
          const bin = Math.max(
            1,
            Math.min(frame.length - 1, Math.round((freq * fftSize) / sampleRate))
          );
          db = frame[bin];
        }
      }
    }

    setHoverInfo({ freq, note, timeOffsetSec, db });
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padLeft = 48;
    const plotW = Math.max(10, rect.width - padLeft - 52);
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left - padLeft) / plotW));
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;

    if (prefs.freqScale === 'log') {
      const logMin = Math.log10(Math.max(20, prefs.minFreq));
      const logMax = Math.log10(Math.max(21, prefs.maxFreq));
      const logCenter = logMin + norm * (logMax - logMin);
      const nextSpan = Math.max(0.08, Math.min(Math.log10(nyquist / 20), (logMax - logMin) * zoomFactor));
      const [lo, hi] = clampFreqRange(
        Math.pow(10, logCenter - norm * nextSpan),
        Math.pow(10, logCenter + (1 - norm) * nextSpan),
        nyquist
      );
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
    inspectAtClient(e.clientX, e.clientY);
    if (!dragRef.current?.active || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const plotW = Math.max(10, rect.width - 100);
    const dxNorm = (e.clientX - dragRef.current.startX) / plotW;

    if (prefs.freqScale === 'log') {
      const logMin = Math.log10(Math.max(20, dragRef.current.startMin));
      const logMax = Math.log10(Math.max(21, dragRef.current.startMax));
      const span = logMax - logMin;
      const [lo, hi] = clampFreqRange(
        Math.pow(10, logMin - dxNorm * span),
        Math.pow(10, logMax - dxNorm * span),
        nyquist
      );
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    } else {
      const span = dragRef.current.startMax - dragRef.current.startMin;
      const [lo, hi] = clampFreqRange(
        dragRef.current.startMin - dxNorm * span,
        dragRef.current.startMax - dxNorm * span,
        nyquist
      );
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      inspectAtClient(t.clientX, t.clientY);
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
      const plotW = Math.max(10, rect.width - 100);
      const norm = Math.max(0, Math.min(1, (midX - 48) / plotW));
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
      inspectAtClient(t.clientX, t.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const plotW = Math.max(10, rect.width - 100);
      const dxNorm = (t.clientX - dragRef.current.startX) / plotW;
      if (prefs.freqScale === 'log') {
        const lMin = Math.log10(Math.max(20, dragRef.current.startMin));
        const lMax = Math.log10(Math.max(21, dragRef.current.startMax));
        const span = lMax - lMin;
        const [lo, hi] = clampFreqRange(
          Math.pow(10, lMin - dxNorm * span),
          Math.pow(10, lMax - dxNorm * span),
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      } else {
        const span = dragRef.current.startMax - dragRef.current.startMin;
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

  const handleExportPNG = () => {
    if (canvasRef.current) exportCanvasToPNG(canvasRef.current, 'spectral_spectrograph');
  };

  const handleExportCSV = () => {
    const csv = formatSpectrographCSV(buffer, fftSize, prefs);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(csv, `spectral_spectrograph_${ts}.csv`, 'text/csv;charset=utf-8;');
  };

  const handleExportJSON = () => {
    const json = formatSpectrographJSON(buffer, fftSize, prefs);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(json, `spectral_spectrograph_${ts}.json`, 'application/json');
  };

  const capturedSeconds = Math.min(
    60,
    buffer.getFrameCount() > 1
      ? (buffer.getLatestTimestamp() - buffer.getTimestampAt(0)) / 1000
      : 0
  );

  return (
    <div className="viz-view">
      <div className="canvas-stage" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="viz-canvas"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={() => {
            dragRef.current = null;
          }}
          onMouseLeave={() => {
            setHoverInfo(null);
            dragRef.current = null;
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => {
            dragRef.current = null;
            pinchRef.current = null;
          }}
        />

        <div className="canvas-hud-top-left">
          <div className="hud-pill">
            <span>Window</span>
            <strong>{prefs.historyDurationSec}s</strong>
            <span>({capturedSeconds.toFixed(1)}s stored)</span>
          </div>
          <div className="hud-pill">
            <span>Range</span>
            <strong>
              {formatFrequency(prefs.minFreq)} – {formatFrequency(prefs.maxFreq)}
            </strong>
          </div>
          {hoverInfo && (
            <div className="hud-pill">
              <strong>{hoverInfo.timeOffsetSec.toFixed(1)}s</strong>
              <strong>{formatFrequency(hoverInfo.freq)}</strong>
              <span>({hoverInfo.note})</span>
              {hoverInfo.db !== null && <strong>{hoverInfo.db.toFixed(1)} dB</strong>}
            </div>
          )}
        </div>

        {!isAudioActive && buffer.getFrameCount() === 0 && (
          <div className="empty-audio-overlay">
            <h3>60-Second Spectrograph Ready</h3>
            <p>
              Captures up to 60 seconds of raw FFT frames so you can retroactively zoom,
              switch Log/Linear scale, change color palettes, or export CSV/JSON/PNG.
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

      <div className="controls-mobile-bar">
        <span
          className="mobile-summary-text"
          style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}
        >
          {prefs.historyDurationSec}s History • {prefs.colormap} • {prefs.freqScale.toUpperCase()}
        </span>
        <button
          type="button"
          className="btn"
          aria-expanded={controlsOpen}
          aria-label="Toggle Spectrograph Controls"
          onClick={() => setControlsOpen((v) => !v)}
        >
          <SlidersHorizontal size={14} />
          <span className="desktop-only-label">Controls</span>
        </button>
      </div>

      <div className={`controls-dock ${controlsOpen ? '' : 'collapsed'}`}>
        <div className="control-group">
          <span className="control-label">History</span>
          <div className="segmented" role="group" aria-label="History Duration">
            {HISTORY_OPTIONS.map((sec) => (
              <button
                key={sec}
                type="button"
                className={`seg-btn ${prefs.historyDurationSec === sec ? 'active' : ''}`}
                onClick={() => onUpdatePrefs({ historyDurationSec: sec })}
              >
                {sec}s
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="control-label">Time Smooth</span>
          <input
            type="range"
            aria-label="Spectrograph Time Smoothing"
            className="range-slider"
            min={0}
            max={0.95}
            step={0.05}
            value={prefs.timeSmoothing}
            onChange={(e) => onUpdatePrefs({ timeSmoothing: Number(e.target.value) })}
          />
          <span className="mono-val">{Math.round(prefs.timeSmoothing * 100)}%</span>
        </div>

        <div className="control-group">
          <span className="control-label">Palette</span>
          <select
            aria-label="Colormap Palette"
            className="select-compact"
            value={prefs.colormap}
            onChange={(e) => onUpdatePrefs({ colormap: e.target.value as ColormapId })}
          >
            {COLORMAP_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <span className="control-label">Floor dB</span>
          <input
            type="range"
            aria-label="Spectrograph Floor dB"
            className="range-slider"
            min={-110}
            max={-30}
            step={5}
            value={prefs.minDb}
            onChange={(e) => onUpdatePrefs({ minDb: Number(e.target.value) })}
          />
          <span className="mono-val">{prefs.minDb}</span>
        </div>

        <FrequencyZoomControls
          minFreq={prefs.minFreq}
          maxFreq={prefs.maxFreq}
          nyquist={nyquist}
          freqScale={prefs.freqScale}
          onRangeChange={(minFreq, maxFreq) => onUpdatePrefs({ minFreq, maxFreq })}
          onScaleChange={(freqScale) => onUpdatePrefs({ freqScale })}
        />

        <div className="control-group">
          <button
            type="button"
            className="btn"
            title="Clear Spectrograph History"
            onClick={onClearBuffer}
          >
            <Trash2 size={13} /> Clear
          </button>
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
