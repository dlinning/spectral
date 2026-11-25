import React, { useEffect, useRef, useState } from 'react';
import { useAudio, useAudioFrame } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useElementSize } from '../../hooks/useElementSize';
import { prepareCanvas2d } from '../../utils/canvas';
import {
  exportCanvasToPNG,
  formatSpectrographCSV,
  formatSpectrographJSON,
  triggerFileDownload,
} from '../../utils/exporters';
import { formatFrequency, normToFreq, panFreqRange, zoomFreqRange } from '../../utils/music';
import { MobileControlsBar } from '../controls/MobileControlsBar';
import { EmptyAudioOverlay } from '../layout/EmptyAudioOverlay';
import { SpectrographControls } from './SpectrographControls';
import {
  SpectrographHoverInfo,
  getSpectrographPlotBounds,
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
  const nyquist = sampleRate / 2;

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
  ]);

  const inspectAtClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setHoverInfo(
      inspectSpectrographPoint(
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
      )
    );
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
    applyDrag(e.clientX, e.clientY);
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
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1 && dragRef.current?.active) {
      const t = e.touches[0];
      inspectAtClient(t.clientX, t.clientY);
      applyDrag(t.clientX, t.clientY);
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

  const viewEndReferenceMs = frameCount > 0 ? latestMs - effectiveScrollBack * 1000 : undefined;

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
          <EmptyAudioOverlay
            title="60-Second Spectrograph Ready"
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
        onTogglePause={toggleSpectrographPause}
        onToggleControls={() => setControlsOpen((v) => !v)}
      />

      <SpectrographControls
        controlsOpen={controlsOpen}
        nyquist={nyquist}
        frameCount={frameCount}
        maxScrollBackSec={maxScrollBackSec}
        effectiveScrollBack={effectiveScrollBack}
        onScrollBackChange={setScrollBackSec}
        onClearHistory={() => {
          setScrollBackSec(0);
          clearSpectrographBuffer();
        }}
        onExportPNG={handleExportPNG}
        onExportCSV={handleExportCSV}
        onExportJSON={handleExportJSON}
      />
    </div>
  );
};
