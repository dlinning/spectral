import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  ColormapId,
  HistoryDurationSec,
  SpectrographPreferences,
} from '../types/preferences';
import { SpectrographBuffer } from '../audio/SpectrographBuffer';
import { COLORMAP_OPTIONS, getColormapLUT } from '../utils/colormaps';
import {
  clampFreqRange,
  formatFreqTick,
  formatFrequency,
  freqToNorm,
  frequencyToNoteInfo,
  getFrequencyTicks,
  normToFreq,
  panFreqRange,
} from '../utils/music';
import {
  exportCanvasToPNG,
  formatSpectrographCSV,
  formatSpectrographJSON,
  triggerFileDownload,
} from '../utils/exporters';
import { DbRangeControls } from './DbRangeControls';
import { FrequencyZoomControls } from './FrequencyZoomControls';

interface SpectrographViewProps {
  prefs: SpectrographPreferences;
  buffer: SpectrographBuffer;
  fftSize: number;
  sampleRate: number;
  isAudioActive: boolean;
  isPaused: boolean;
  frameTick: number;
  onTogglePause: () => void;
  onUpdatePrefs: (patch: Partial<SpectrographPreferences>) => void;
  onClearBuffer: () => void;
  onStartMic: () => void;
}

const HISTORY_OPTIONS: HistoryDurationSec[] = [5, 15, 30, 60];

export const SpectrographView: React.FC<SpectrographViewProps> = ({
  prefs,
  buffer,
  fftSize,
  sampleRate,
  isAudioActive,
  isPaused,
  frameTick,
  onTogglePause,
  onUpdatePrefs,
  onClearBuffer,
  onStartMic,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  const [size, setSize] = useState({ width: 800, height: 420 });
  const [controlsOpen, setControlsOpen] = useState(true);
  const [scrollBackSec, setScrollBackSec] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{
    freq: number;
    note: string;
    timeOffsetSec: number;
    db: number | null;
  } | null>(null);

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startScrollBack: number;
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

  const frameCount = buffer.getFrameCount();
  const earliestMs = frameCount > 0 ? buffer.getTimestampAt(0) : 0;
  const latestMs = frameCount > 0 ? buffer.getLatestTimestamp() : 0;
  const capturedSeconds =
    frameCount > 1 ? Math.min(60, (latestMs - earliestMs) / 1000) : 0;
  const maxScrollBackSec = Math.max(0, capturedSeconds - 0.5);
  const effectiveScrollBack = Math.min(scrollBackSec, maxScrollBackSec);

  // Reset scrollBackSec when buffer is cleared
  useEffect(() => {
    if (frameCount === 0 && scrollBackSec !== 0) {
      setScrollBackSec(0);
    }
  }, [frameCount, scrollBackSec]);

  // Right-to-left spectrograph rendering:
  // X-axis = Time (newest on right, scrolling right-to-left)
  // Y-axis = Frequency (minFreq at bottom, maxFreq at top)
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
    const padLeft = 52; // Room for Frequency Y-axis labels
    const padRight = 52; // Room for dB colorbar legend
    const padTop = 16;
    const padBottom = 28; // Room for Time X-axis labels
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

    // Vertical pixel -> FFT bin range lookup (py=0 is maxFreq at top, py=plotH-1 is minFreq at bottom)
    // Uses max-pooling across bins when multiple FFT bins map to one vertical pixel row
    const binLo = new Int32Array(plotH);
    const binHi = new Int32Array(plotH);
    const binExact = new Float32Array(plotH);
    for (let py = 0; py < plotH; py++) {
      const nTop = 1 - Math.max(0, py - 0.5) / Math.max(1, plotH - 1);
      const nBot = 1 - Math.min(plotH - 1, py + 0.5) / Math.max(1, plotH - 1);
      const nMid = 1 - py / Math.max(1, plotH - 1);
      const fBot = normToFreq(nBot, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const fTop = normToFreq(nTop, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const fMid = normToFreq(nMid, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      binLo[py] = Math.max(1, Math.min(numBins - 1, Math.floor(fBot / binWidth)));
      binHi[py] = Math.max(binLo[py], Math.min(numBins - 1, Math.floor(fTop / binWidth)));
      binExact[py] = Math.max(1, Math.min(numBins - 1, fMid / binWidth));
    }

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

      if (frameCount > 0) {
        const durationMs = prefs.historyDurationSec * 1000;
        const viewEndMs = latestMs - effectiveScrollBack * 1000;
        const viewStartMs = viewEndMs - durationMs;
        const dbSpan = Math.max(10, prefs.maxDb - prefs.minDb);
        const invDbSpan = 255 / dbSpan;

        // Map horizontal pixel column px (0 = oldest left, plotW-1 = newest right) -> frame index
        const colFrameIdx = new Int32Array(plotW).fill(-1);
        let frameCursor = frameCount - 1;

        for (let px = plotW - 1; px >= 0; px--) {
          const targetTs =
            viewStartMs + (px / Math.max(1, plotW - 1)) * durationMs;

          while (
            frameCursor > 0 &&
            buffer.getTimestampAt(frameCursor) > targetTs
          ) {
            frameCursor--;
          }

          const ts = buffer.getTimestampAt(frameCursor);
          if (targetTs >= earliestMs - 250 && Math.abs(targetTs - ts) <= 500) {
            colFrameIdx[px] = frameCursor;
          }
        }

        // Cache frame views for each column to avoid repeated lookups inside py loop
        const colFrames: (Float32Array | null)[] = new Array(plotW);
        for (let px = 0; px < plotW; px++) {
          const fIdx = colFrameIdx[px];
          colFrames[px] = fIdx >= 0 ? buffer.getFrameView(fIdx) : null;
        }

        for (let py = 0; py < plotH; py++) {
          const lo = binLo[py];
          const hi = binHi[py];
          const bf = binExact[py];
          const b0 = bf | 0;
          const b1 = b0 + 1 < numBins ? b0 + 1 : b0;
          const frac = bf - b0;
          const rowBase = py * plotW * 4;

          for (let px = 0; px < plotW; px++) {
            const frame = colFrames[px];
            if (!frame) continue;
            let db: number;
            if (hi > lo) {
              db = -160;
              for (let b = lo; b <= hi; b++) {
                if (frame[b] > db) db = frame[b];
              }
            } else {
              db = frame[b0] * (1 - frac) + frame[b1] * frac;
            }
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

    // Frequency Axis Ticks (Left Y-axis: minFreq bottom -> maxFreq top)
    const freqTicks = getFrequencyTicks(
      prefs.minFreq,
      prefs.maxFreq,
      prefs.freqScale,
      plotH
    );

    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of freqTicks) {
      const norm = freqToNorm(f, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      const y = padTop + (1 - norm) * plotH;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(formatFreqTick(f), padLeft - 6, y);
    }

    // Time Axis Ticks (Bottom X-axis: oldest on left -> newest on right)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const timeSteps = 5;
    for (let i = 0; i <= timeSteps; i++) {
      const ratio = i / timeSteps;
      const x = padLeft + ratio * plotW;
      const offsetSec = -(effectiveScrollBack + (1 - ratio) * prefs.historyDurationSec);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        Math.abs(offsetSec) < 0.05 ? '0s' : `${offsetSec.toFixed(1).replace(/\.0$/, '')}s`,
        x,
        padTop + plotH + 6
      );
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
  }, [
    frameTick,
    prefs,
    buffer,
    sampleRate,
    fftSize,
    size,
    effectiveScrollBack,
    frameCount,
    earliestMs,
    latestMs,
  ]);

  const inspectAtClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padLeft = 52;
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
    const normY = 1 - (y - padTop) / plotH;
    const freq = normToFreq(normY, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const timeOffsetSec = -(
      effectiveScrollBack +
      (1 - normX) * prefs.historyDurationSec
    );
    const noteInfo = frequencyToNoteInfo(freq);
    const note = noteInfo ? noteInfo.label : '—';

    let db: number | null = null;
    if (frameCount > 0) {
      const targetTs = latestMs + timeOffsetSec * 1000;
      let chosen = -1;
      for (let i = frameCount - 1; i >= 0; i--) {
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

  // Mouse Wheel zooms Frequency axis (Y) centered at cursor Y
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padTop = 16;
    const plotH = Math.max(10, rect.height - padTop - 28);
    const normY = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - padTop) / plotH));
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;

    if (prefs.freqScale === 'log') {
      const logMin = Math.log10(Math.max(20, prefs.minFreq));
      const logMax = Math.log10(Math.max(21, prefs.maxFreq));
      const logCenter = logMin + normY * (logMax - logMin);
      const nextSpan = Math.max(
        0.08,
        Math.min(Math.log10(nyquist / 20), (logMax - logMin) * zoomFactor)
      );
      const [lo, hi] = clampFreqRange(
        Math.pow(10, logCenter - normY * nextSpan),
        Math.pow(10, logCenter + (1 - normY) * nextSpan),
        nyquist
      );
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    } else {
      const span = prefs.maxFreq - prefs.minFreq;
      const center = prefs.minFreq + normY * span;
      const nextSpan = Math.max(40, Math.min(nyquist - 20, span * zoomFactor));
      const [lo, hi] = clampFreqRange(
        center - normY * nextSpan,
        center + (1 - normY) * nextSpan,
        nyquist
      );
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startScrollBack: effectiveScrollBack,
      startMin: prefs.minFreq,
      startMax: prefs.maxFreq,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    inspectAtClient(e.clientX, e.clientY);
    if (!dragRef.current?.active || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const plotW = Math.max(10, rect.width - 104);
    const plotH = Math.max(10, rect.height - 44);

    // Horizontal drag scrubs time history (drag right = pull older data in)
    const dxNorm = (e.clientX - dragRef.current.startX) / plotW;
    const nextScroll = Math.max(
      0,
      Math.min(
        maxScrollBackSec,
        dragRef.current.startScrollBack + dxNorm * prefs.historyDurationSec
      )
    );
    setScrollBackSec(nextScroll);

    // Vertical drag pans frequency range
    const dyNorm = (e.clientY - dragRef.current.startY) / plotH;
    const [lo, hi] = panFreqRange(
      dragRef.current.startMin,
      dragRef.current.startMax,
      dyNorm,
      nyquist,
      prefs.freqScale
    );
    onUpdatePrefs({ minFreq: lo, maxFreq: hi });
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      inspectAtClient(t.clientX, t.clientY);
      dragRef.current = {
        active: true,
        startX: t.clientX,
        startY: t.clientY,
        startScrollBack: effectiveScrollBack,
        startMin: prefs.minFreq,
        startMax: prefs.maxFreq,
      };
      pinchRef.current = null;
    } else if (e.touches.length === 2 && canvasRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
      const plotH = Math.max(10, rect.height - 44);
      const normY = Math.max(0, Math.min(1, 1 - (midY - 16) / plotH));
      const centerFreq = normToFreq(normY, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
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
    // Single-finger touch scrolls time (X) and pans frequency (Y) without zooming
    if (e.touches.length === 1 && dragRef.current?.active && canvasRef.current) {
      const t = e.touches[0];
      inspectAtClient(t.clientX, t.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const plotW = Math.max(10, rect.width - 104);
      const plotH = Math.max(10, rect.height - 44);

      const dxNorm = (t.clientX - dragRef.current.startX) / plotW;
      const nextScroll = Math.max(
        0,
        Math.min(
          maxScrollBackSec,
          dragRef.current.startScrollBack + dxNorm * prefs.historyDurationSec
        )
      );
      setScrollBackSec(nextScroll);

      const dyNorm = (t.clientY - dragRef.current.startY) / plotH;
      const [lo, hi] = panFreqRange(
        dragRef.current.startMin,
        dragRef.current.startMax,
        dyNorm,
        nyquist,
        prefs.freqScale
      );
      onUpdatePrefs({ minFreq: lo, maxFreq: hi });
    } else if (e.touches.length === 2 && pinchRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = pinchRef.current.initialDist / Math.max(10, dist);
      if (prefs.freqScale === 'log') {
        const lMin = Math.log10(Math.max(20, pinchRef.current.startMin));
        const lMax = Math.log10(Math.max(21, pinchRef.current.startMax));
        const lCenter = Math.log10(Math.max(20, pinchRef.current.centerFreq));
        const newSpan = Math.max(
          0.08,
          Math.min(Math.log10(nyquist / 20), (lMax - lMin) * scale)
        );
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
        const ratio =
          (pinchRef.current.centerFreq - pinchRef.current.startMin) / Math.max(1, span);
        const [lo, hi] = clampFreqRange(
          pinchRef.current.centerFreq - ratio * newSpan,
          pinchRef.current.centerFreq + (1 - ratio) * newSpan,
          nyquist
        );
        onUpdatePrefs({ minFreq: lo, maxFreq: hi });
      }
    }
  };

  const viewEndReferenceMs =
    frameCount > 0 ? latestMs - effectiveScrollBack * 1000 : undefined;

  const handleExportPNG = () => {
    if (canvasRef.current) exportCanvasToPNG(canvasRef.current, 'spectral_spectrograph');
  };

  const handleExportCSV = () => {
    const csv = formatSpectrographCSV(buffer, fftSize, prefs, viewEndReferenceMs);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(csv, `spectral_spectrograph_${ts}.csv`, 'text/csv;charset=utf-8;');
  };

  const handleExportJSON = () => {
    const json = formatSpectrographJSON(buffer, fftSize, prefs, viewEndReferenceMs);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    triggerFileDownload(json, `spectral_spectrograph_${ts}.json`, 'application/json');
  };

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
          {effectiveScrollBack > 0.05 && (
            <div
              className="hud-pill"
              style={{
                color: '#7dd3fc',
                borderColor: 'rgba(56, 189, 248, 0.45)',
              }}
            >
              <strong>-{effectiveScrollBack.toFixed(1)}s</strong>
            </div>
          )}
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
              Scrolls right-to-left (newest on right) and stores up to 60 seconds of raw FFT
              frames. Drag horizontally to scroll back in time, or zoom/filter frequency and dB
              ranges retroactively.
            </p>
            <div className="empty-overlay-actions">
              <button type="button" className="btn btn-primary" onClick={onStartMic}>
                <Mic size={15} /> Start Microphone
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
          {prefs.historyDurationSec}s • {prefs.colormap} • {prefs.freqScale.toUpperCase()}
        </span>
        <div className="mobile-bar-actions">
          <button
            type="button"
            className={`btn btn-icon-only-landscape ${isPaused ? 'btn-active-mic' : ''}`}
            disabled={!isAudioActive && frameCount === 0}
            aria-label={isPaused ? 'Resume Spectrograph' : 'Pause Spectrograph'}
            title={isPaused ? 'Resume' : 'Pause'}
            onClick={onTogglePause}
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
            aria-label="Toggle Spectrograph Controls"
            title="Toggle Spectrograph Controls"
            onClick={() => setControlsOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
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
            onChange={(e) => setScrollBackSec(Number(e.target.value))}
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
              onClick={() => setScrollBackSec(0)}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>

        <div className="control-group">
          <span className="control-label">Time Smooth</span>
          <input
            type="range"
            aria-label="Spectrograph Time Smoothing"
            className="range-slider"
            min={0}
            max={300}
            step={10}
            value={prefs.timeSmoothingMs}
            onChange={(e) => onUpdatePrefs({ timeSmoothingMs: Number(e.target.value) })}
          />
          <span className="mono-val">{prefs.timeSmoothingMs} ms</span>
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
          defaultMinDb={-95}
          defaultMaxDb={-5}
          onChange={(minDb, maxDb) => onUpdatePrefs({ minDb, maxDb })}
        />

        <div className="control-group">
          <button
            type="button"
            className={`btn desktop-only-btn ${isPaused ? 'btn-active-mic' : ''}`}
            disabled={!isAudioActive && frameCount === 0}
            title="Pause / Resume (Space)"
            onClick={onTogglePause}
          >
            {isPaused ? <Play size={13} /> : <Pause size={13} />}
            <span>{isPaused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            className="btn"
            title="Clear Spectrograph History"
            onClick={() => {
              setScrollBackSec(0);
              onClearBuffer();
            }}
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
