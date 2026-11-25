import React, { useEffect, useRef, useState } from 'react';
import { useAudio, useAudioFrame } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useElementSize } from '../../hooks/useElementSize';
import { prepareCanvas2d } from '../../utils/canvas';
import {
  EXPORT_LABEL_FONT_PX,
  computePaddedExportMaxDb,
  createHighResExportCanvas,
  exportCanvasToPNG,
  formatSpectrographCSV,
  formatSpectrographJSON,
  getPngExportDimensions,
  triggerFileDownload,
} from '../../utils/exporters';
import {
  MAX_DISPLAY_FREQ_HZ,
  formatFrequency,
  normToFreq,
  panFreqRange,
  zoomFreqRange,
} from '../../utils/music';
import { MobileControlsBar } from '../controls/MobileControlsBar';
import { EmptyAudioOverlay } from '../layout/EmptyAudioOverlay';
import { SpectrographControls } from './SpectrographControls';
import {
  SpectrographHoverInfo,
  getSpectrographPeakDbInRange,
  getSpectrographPlotBounds,
  getSpectrographTargetPoint,
  inspectSpectrographPoint,
  renderSpectrographCanvas,
} from './spectrographRenderer';

export const SpectrographView: React.FC = () => {
  const { preferences, updateSpectrographPrefs } = usePreferencesContext();
  const {
    spectrographBuffer: buffer,
    sampleRate,
    isAudioActive,
    spectrographPaused: isPaused,
    toggleSpectrographPause,
    clearSpectrographBuffer,
    startMicrophone,
  } = useAudio();
  const frameTick = useAudioFrame();

  const prefs = preferences.spectrograph;
  const fftSize = preferences.audio.fftSize;
  const nyquist = Math.min(MAX_DISPLAY_FREQ_HZ, sampleRate / 2);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  const size = useElementSize(containerRef);
  const [controlsOpen, setControlsOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 900 && window.innerHeight > 540 : true
  );
  const [scrollBackSec, setScrollBackSec] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<SpectrographHoverInfo | null>(null);

  const dragRef = useRef<{
    active: boolean;
    mode: 'reticle' | 'pan';
    startX: number;
    startY: number;
    startedOnTarget: boolean;
    moved: boolean;
    startScrollBack: number;
    startMin: number;
    startMax: number;
  } | null>(null);

  const touchTapRef = useRef<{
    startX: number;
    startY: number;
    startedOnTarget: boolean;
    moved: boolean;
  } | null>(null);

  const lastTouchTimeRef = useRef<number>(-Infinity);

  const pinchRef = useRef<{
    initialDist: number;
    centerFreq: number;
    startMin: number;
    startMax: number;
  } | null>(null);

  const frameCount = buffer.getFrameCount();
  const earliestMs = frameCount > 0 ? buffer.getTimestampAt(0) : 0;
  const latestMs = frameCount > 0 ? buffer.getLatestTimestamp() : 0;
  const capturedSeconds = frameCount > 1 ? Math.min(60, (latestMs - earliestMs) / 1000) : 0;
  const maxScrollBackSec = Math.max(0, capturedSeconds - 0.5);
  const effectiveScrollBack = Math.min(scrollBackSec, maxScrollBackSec);

  // Reset scrollBackSec when buffer is cleared
  useEffect(() => {
    if (frameCount === 0 && scrollBackSec !== 0) {
      setScrollBackSec(0);
    }
  }, [frameCount, scrollBackSec]);

  // Right-to-left spectrograph rendering: X = Time (newest on right), Y = Frequency
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas2d(canvas, size.width, size.height);
    if (!prepared) return;

    renderSpectrographCanvas(prepared.ctx, offscreenRef, imageDataRef, {
      width: size.width,
      height: size.height,
      dpr: prepared.dpr,
      prefs,
      buffer,
      sampleRate,
      fftSize,
      effectiveScrollBack,
      frameCount,
      earliestMs,
      latestMs,
      target: hoverInfo,
    });
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
    hoverInfo,
  ]);

  const isInsidePlot = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { padLeft, padTop, plotW, plotH } = getSpectrographPlotBounds(rect.width, rect.height);
    return x >= padLeft && x <= padLeft + plotW && y >= padTop && y <= padTop + plotH;
  };

  const isOnActiveTarget = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !hoverInfo) return false;
    const rect = canvas.getBoundingClientRect();
    const pt = getSpectrographTargetPoint(
      hoverInfo,
      rect.width,
      rect.height,
      prefs,
      effectiveScrollBack
    );
    if (!pt) return false;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return Math.hypot(x - pt.x, y - pt.y) <= 20 || Math.abs(x - pt.x) <= 16;
  };

  const inspectAtClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const info = inspectSpectrographPoint(
      buffer,
      clientX,
      clientY,
      canvas.getBoundingClientRect(),
      prefs,
      fftSize,
      sampleRate,
      effectiveScrollBack,
      frameCount,
      latestMs
    );
    if (info) {
      setHoverInfo(info);
    }
  };

  const applyDrag = (clientX: number, clientY: number) => {
    if (!dragRef.current?.active || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const { plotW, plotH } = getSpectrographPlotBounds(rect.width, rect.height);

    // Horizontal drag scrubs time history (drag right = pull older data in)
    const dxNorm = (clientX - dragRef.current.startX) / plotW;
    const nextScroll = Math.max(
      0,
      Math.min(
        maxScrollBackSec,
        dragRef.current.startScrollBack + dxNorm * prefs.historyDurationSec
      )
    );
    setScrollBackSec(nextScroll);

    // Vertical drag pans frequency range
    const dyNorm = (clientY - dragRef.current.startY) / plotH;
    const [lo, hi] = panFreqRange(
      dragRef.current.startMin,
      dragRef.current.startMax,
      dyNorm,
      nyquist,
      prefs.freqScale
    );
    updateSpectrographPrefs({ minFreq: lo, maxFreq: hi });
  };

  // Mouse Wheel zooms Frequency axis (Y) centered at cursor Y
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { padTop, plotH } = getSpectrographPlotBounds(rect.width, rect.height);
    const normY = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - padTop) / plotH));
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
    const anchorFreq = normToFreq(normY, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const [lo, hi] = zoomFreqRange(
      prefs.minFreq,
      prefs.maxFreq,
      anchorFreq,
      zoomFactor,
      nyquist,
      prefs.freqScale
    );
    updateSpectrographPrefs({ minFreq: lo, maxFreq: hi });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchTimeRef.current < 800) return;
    const startedOnTarget =
      !e.shiftKey &&
      e.button !== 1 &&
      isInsidePlot(e.clientX, e.clientY) &&
      isOnActiveTarget(e.clientX, e.clientY);
    dragRef.current = {
      active: true,
      mode: startedOnTarget ? 'reticle' : 'pan',
      startX: e.clientX,
      startY: e.clientY,
      startedOnTarget,
      moved: false,
      startScrollBack: effectiveScrollBack,
      startMin: prefs.minFreq,
      startMax: prefs.maxFreq,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchTimeRef.current < 800) return;
    if (!dragRef.current?.active) return;
    if (Math.hypot(e.clientX - dragRef.current.startX, e.clientY - dragRef.current.startY) > 4) {
      dragRef.current.moved = true;
    }
    if (!dragRef.current.moved) return;
    if (dragRef.current.mode === 'reticle') {
      inspectAtClient(e.clientX, e.clientY);
    } else {
      applyDrag(e.clientX, e.clientY);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchTimeRef.current < 800) {
      dragRef.current = null;
      return;
    }
    if (dragRef.current?.active && !dragRef.current.moved) {
      if (dragRef.current.startedOnTarget) {
        setHoverInfo(null);
      } else if (isInsidePlot(e.clientX, e.clientY)) {
        inspectAtClient(e.clientX, e.clientY);
      }
    }
    dragRef.current = null;
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchTimeRef.current = performance.now();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      dragRef.current = null;
      pinchRef.current = null;
      if (isInsidePlot(t.clientX, t.clientY)) {
        const startedOnTarget = isOnActiveTarget(t.clientX, t.clientY);
        touchTapRef.current = {
          startX: t.clientX,
          startY: t.clientY,
          startedOnTarget,
          moved: false,
        };
        if (!startedOnTarget) {
          inspectAtClient(t.clientX, t.clientY);
        }
      } else {
        touchTapRef.current = null;
      }
    } else if (e.touches.length === 2 && canvasRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const { padTop, plotH } = getSpectrographPlotBounds(rect.width, rect.height);
      const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
      const normY = Math.max(0, Math.min(1, 1 - (midY - padTop) / plotH));
      const centerFreq = normToFreq(normY, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      pinchRef.current = {
        initialDist: Math.max(10, dist),
        centerFreq,
        startMin: prefs.minFreq,
        startMax: prefs.maxFreq,
      };
      dragRef.current = null;
      touchTapRef.current = null;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchTimeRef.current = performance.now();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (touchTapRef.current) {
        if (
          Math.hypot(
            t.clientX - touchTapRef.current.startX,
            t.clientY - touchTapRef.current.startY
          ) > 6
        ) {
          touchTapRef.current.moved = true;
        }
      }
      if (!touchTapRef.current || touchTapRef.current.moved) {
        inspectAtClient(t.clientX, t.clientY);
      }
    } else if (e.touches.length === 2 && pinchRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = pinchRef.current.initialDist / Math.max(10, dist);
      const [lo, hi] = zoomFreqRange(
        pinchRef.current.startMin,
        pinchRef.current.startMax,
        pinchRef.current.centerFreq,
        scale,
        nyquist,
        prefs.freqScale
      );
      updateSpectrographPrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchTimeRef.current = performance.now();
    dragRef.current = null;
    if (
      e.touches.length === 0 &&
      touchTapRef.current?.startedOnTarget &&
      !touchTapRef.current.moved
    ) {
      setHoverInfo(null);
    }
    if (e.touches.length === 0) {
      touchTapRef.current = null;
    }
    if (e.touches.length < 2) {
      pinchRef.current = null;
    }
  };

  const viewEndReferenceMs = frameCount > 0 ? latestMs - effectiveScrollBack * 1000 : undefined;

  const handleExportPNG = () => {
    const tempOffscreenRef = { current: null as HTMLCanvasElement | null };
    const tempImageDataRef = { current: null as ImageData | null };
    const { width: exportW, height: exportH } = getPngExportDimensions(size.width, size.height);
    const exportBounds = getSpectrographPlotBounds(exportW, exportH, EXPORT_LABEL_FONT_PX);
    const peakDb = getSpectrographPeakDbInRange(
      buffer,
      prefs,
      sampleRate,
      fftSize,
      effectiveScrollBack,
      frameCount,
      latestMs
    );
    const exportPrefs = {
      ...prefs,
      maxDb: computePaddedExportMaxDb(peakDb, prefs.minDb, prefs.maxDb),
    };

    const exportCanvas = createHighResExportCanvas(
      size.width,
      size.height,
      `Spectrograph • ${formatFrequency(prefs.minFreq)} – ${formatFrequency(prefs.maxFreq)} • ${prefs.historyDurationSec}s`,
      (ctx, width, height, dpr) => {
        renderSpectrographCanvas(ctx, tempOffscreenRef, tempImageDataRef, {
          width,
          height,
          dpr,
          prefs: exportPrefs,
          buffer,
          sampleRate,
          fftSize,
          effectiveScrollBack,
          frameCount,
          earliestMs,
          latestMs,
          target: hoverInfo,
          labelFontPx: EXPORT_LABEL_FONT_PX,
        });
      },
      exportBounds.padLeft,
      exportBounds.padRight
    );
    exportCanvasToPNG(exportCanvas, 'spectral_spectrograph');
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

  const handleClearHistory = () => {
    setScrollBackSec(0);
    clearSpectrographBuffer();
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
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            dragRef.current = null;
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
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
          <EmptyAudioOverlay
            title="Spectrograph"
            description="Enable the microphone to begin. Drag horizontally to scroll back in time, or zoom/filter frequency and dB ranges."
            onStartMic={() => void startMicrophone()}
          />
        )}
      </div>

      <MobileControlsBar
        summaryText={`${prefs.historyDurationSec}s • ${prefs.colormap} • ${prefs.freqScale.toUpperCase()}`}
        isPaused={isPaused}
        canPause={isAudioActive || frameCount > 0}
        controlsOpen={controlsOpen}
        pauseLabel="Pause Spectrograph"
        resumeLabel="Resume Spectrograph"
        toggleControlsLabel="Toggle Spectrograph Controls"
        clearLabel="Clear Spectrograph History"
        onTogglePause={toggleSpectrographPause}
        onToggleControls={() => setControlsOpen((v) => !v)}
        onClear={handleClearHistory}
      />

      <SpectrographControls
        controlsOpen={controlsOpen}
        nyquist={nyquist}
        frameCount={frameCount}
        maxScrollBackSec={maxScrollBackSec}
        effectiveScrollBack={effectiveScrollBack}
        onScrollBackChange={setScrollBackSec}
        onClearHistory={handleClearHistory}
        onExportPNG={handleExportPNG}
        onExportCSV={handleExportCSV}
        onExportJSON={handleExportJSON}
      />
    </div>
  );
};
