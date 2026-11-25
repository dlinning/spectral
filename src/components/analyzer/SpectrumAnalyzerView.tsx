import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAudio, useAudioFrame } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useElementSize } from '../../hooks/useElementSize';
import { prepareCanvas2d } from '../../utils/canvas';
import {
  exportCanvasToPNG,
  formatSpectrumCSV,
  formatSpectrumJSON,
  triggerFileDownload,
} from '../../utils/exporters';
import {
  formatFrequency,
  frequencyToNoteInfo,
  normToFreq,
  panFreqRange,
  timeConstantMsToAlpha,
  zoomFreqRange,
} from '../../utils/music';
import { dspBridge } from '../../wasm/dspBridge';
import { FreqAxisZoomBar } from '../controls/FreqAxisZoomBar';
import { MobileControlsBar } from '../controls/MobileControlsBar';
import { EmptyAudioOverlay } from '../layout/EmptyAudioOverlay';
import { AnalyzerControls } from './AnalyzerControls';
import {
  SPECTRUM_PLOT_PADDING,
  computeTiltOffset,
  getSpectrumPlotBounds,
  renderSpectrumCanvas,
} from './spectrumRenderer';

export const SpectrumAnalyzerView: React.FC = () => {
  const { preferences, updateAnalyzerPrefs } = usePreferencesContext();
  const {
    sampleRate,
    isAudioActive,
    analyzerPaused: isPaused,
    latestBinsRef,
    toggleAnalyzerPause,
    startMicrophone,
  } = useAudio();
  const frameTick = useAudioFrame();

  const prefs = preferences.analyzer;
  const fftSize = preferences.audio.fftSize;
  const nyquist = sampleRate / 2;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(containerRef);
  const [controlsOpen, setControlsOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 900 && window.innerHeight > 540 : true
  );

  // DSP buffers
  const timeSmoothedRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const octaveSmoothedRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const peakHoldRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
  const lastFrameMsRef = useRef<number>(performance.now());

  // Cursor / touch zoom & pan state
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const hudFreqRef = useRef<HTMLElement>(null);
  const hudNoteRef = useRef<HTMLSpanElement>(null);
  const hudDbRef = useRef<HTMLElement>(null);
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

  // Resize buffers when FFT size changes
  useEffect(() => {
    const bins = fftSize / 2;
    timeSmoothedRef.current = new Float32Array(bins).fill(-110);
    octaveSmoothedRef.current = new Float32Array(bins).fill(-110);
    peakHoldRef.current = new Float32Array(bins).fill(-110);
  }, [fftSize]);

  const resetPeakHold = useCallback(() => {
    peakHoldRef.current.fill(-120);
  }, []);

  // Process DSP & render canvas whenever a frame arrives or settings/size change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas2d(canvas, size.width, size.height);
    if (!prepared) return;

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

    const tracked = renderSpectrumCanvas(prepared.ctx, {
      width: size.width,
      height: size.height,
      dpr: prepared.dpr,
      prefs,
      sampleRate,
      fftSize,
      numBins,
      isAudioActive,
      displayData: octaveSmoothedRef.current,
      peakHoldData: peakHoldRef.current,
      cursor: cursorRef.current,
    });

    if (tracked) {
      if (hudFreqRef.current) hudFreqRef.current.textContent = formatFrequency(tracked.freq);
      if (hudNoteRef.current) hudNoteRef.current.textContent = `(${tracked.noteText})`;
      if (hudDbRef.current) hudDbRef.current.textContent = `${tracked.db.toFixed(1)} dB`;
    }
  }, [frameTick, isAudioActive, isPaused, prefs, sampleRate, fftSize, size, latestBinsRef]);

  const updateCursorFromClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    cursorRef.current = { x, y };

    const { padLeft, padTop, plotW, plotH } = getSpectrumPlotBounds(rect.width, rect.height);
    if (x < padLeft || x > padLeft + plotW || y < padTop || y > padTop + plotH) {
      setCursorReadout(null);
      return;
    }

    const normX = (x - padLeft) / plotW;
    const normY = (y - padTop) / plotH;
    const freq = normToFreq(normX, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    let db = prefs.maxDb - normY * Math.max(10, prefs.maxDb - prefs.minDb);
    if (isAudioActive && octaveSmoothedRef.current.length > 1) {
      const binWidth = sampleRate / fftSize;
      const bf = freq / binWidth;
      const b0 = Math.max(1, Math.min(octaveSmoothedRef.current.length - 1, Math.floor(bf)));
      const b1 = Math.max(1, Math.min(octaveSmoothedRef.current.length - 1, Math.ceil(bf)));
      const frac = bf - b0;
      db =
        octaveSmoothedRef.current[b0] * (1 - frac) +
        octaveSmoothedRef.current[b1] * frac +
        computeTiltOffset(freq, prefs.tiltSlope);
    }
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
    const { padLeft, plotW } = getSpectrumPlotBounds(rect.width, rect.height);
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left - padLeft) / plotW));
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
    const anchorFreq = normToFreq(norm, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const [lo, hi] = zoomFreqRange(
      prefs.minFreq,
      prefs.maxFreq,
      anchorFreq,
      zoomFactor,
      nyquist,
      prefs.freqScale
    );
    updateAnalyzerPrefs({ minFreq: lo, maxFreq: hi });
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
    const { plotW } = getSpectrumPlotBounds(rect.width, rect.height);
    const dxNorm = (e.clientX - dragRef.current.startX) / plotW;
    const [lo, hi] = panFreqRange(
      dragRef.current.startMin,
      dragRef.current.startMax,
      -dxNorm,
      nyquist,
      prefs.freqScale
    );
    updateAnalyzerPrefs({ minFreq: lo, maxFreq: hi });
  };

  const handleMouseUp = () => {
    dragRef.current = null;
  };

  // Touch support: single-finger pans frequency range; two-finger pinch zooms
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
      const { padLeft, plotW } = getSpectrumPlotBounds(rect.width, rect.height);
      const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
      const norm = Math.max(0, Math.min(1, (midX - padLeft) / plotW));
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
      const { plotW } = getSpectrumPlotBounds(rect.width, rect.height);
      const dxNorm = (t.clientX - dragRef.current.startX) / plotW;
      const [lo, hi] = panFreqRange(
        dragRef.current.startMin,
        dragRef.current.startMax,
        -dxNorm,
        nyquist,
        prefs.freqScale
      );
      updateAnalyzerPrefs({ minFreq: lo, maxFreq: hi });
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
      updateAnalyzerPrefs({ minFreq: lo, maxFreq: hi });
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

  const octLabel = prefs.octaveSmoothing === 0 ? 'Off' : `1/${prefs.octaveSmoothing} Oct`;

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
              <strong ref={hudFreqRef}>{formatFrequency(cursorReadout.freq)}</strong>
              <span ref={hudNoteRef}>({cursorReadout.note})</span>
              <strong ref={hudDbRef}>{cursorReadout.db.toFixed(1)} dB</strong>
            </div>
          )}
        </div>

        {!isAudioActive && (
          <EmptyAudioOverlay
            title="Spectrum Analyzer Ready"
            description="Start your microphone for real-time acoustic analysis. Pinch with two fingers to zoom or drag to pan frequency ranges."
            onStartMic={() => void startMicrophone()}
          />
        )}
      </div>

      <FreqAxisZoomBar
        minFreq={prefs.minFreq}
        maxFreq={prefs.maxFreq}
        nyquist={nyquist}
        freqScale={prefs.freqScale}
        padLeft={SPECTRUM_PLOT_PADDING.left}
        padRight={SPECTRUM_PLOT_PADDING.right}
        onRangeChange={(minFreq, maxFreq) => updateAnalyzerPrefs({ minFreq, maxFreq })}
      />

      <MobileControlsBar
        summaryText={`${octLabel} • ${prefs.timeSmoothingMs}ms • ${prefs.freqScale.toUpperCase()}`}
        isPaused={isPaused}
        canPause={isAudioActive}
        controlsOpen={controlsOpen}
        pauseLabel="Pause Spectrum Analyzer"
        resumeLabel="Resume Spectrum Analyzer"
        toggleControlsLabel="Toggle Analyzer Controls"
        onTogglePause={toggleAnalyzerPause}
        onToggleControls={() => setControlsOpen((v) => !v)}
      />

      <AnalyzerControls
        controlsOpen={controlsOpen}
        nyquist={nyquist}
        onResetPeakHold={resetPeakHold}
        onExportPNG={handleExportPNG}
        onExportCSV={handleExportCSV}
        onExportJSON={handleExportJSON}
      />
    </div>
  );
};
