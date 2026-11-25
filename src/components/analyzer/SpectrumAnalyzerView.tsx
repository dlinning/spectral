import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAudio, useAudioFrame } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { useElementSize } from '../../hooks/useElementSize';
import { prepareCanvas2d } from '../../utils/canvas';
import {
  EXPORT_LABEL_FONT_PX,
  computePaddedExportMaxDb,
  createHighResExportCanvas,
  exportCanvasToPNG,
  formatSpectrumCSV,
  formatSpectrumJSON,
  getPngExportDimensions,
  triggerFileDownload,
} from '../../utils/exporters';
import {
  MAX_DISPLAY_FREQ_HZ,
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
  computeTiltOffset,
  getSpectrumPeakDbInRange,
  getSpectrumPlotBounds,
  renderSpectrumCanvas,
  scaleSpectrumCursor,
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
  const nyquist = Math.min(MAX_DISPLAY_FREQ_HZ, sampleRate / 2);

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
    mode: 'reticle' | 'pan';
    startX: number;
    startY: number;
    startedOnReticle: boolean;
    moved: boolean;
    startMin: number;
    startMax: number;
  } | null>(null);

  const touchTapRef = useRef<{
    startX: number;
    startY: number;
    startedOnReticle: boolean;
    moved: boolean;
  } | null>(null);

  const lastTouchTimeRef = useRef<number>(-Infinity);
  const lastRenderedFrameTickRef = useRef<number>(-1);

  const pinchRef = useRef<{
    initialDist: number;
    startMidX: number;
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

    const frameAdvanced = frameTick !== lastRenderedFrameTickRef.current;
    lastRenderedFrameTickRef.current = frameTick;

    if (isAudioActive && numBins > 0) {
      if (!isPaused && frameAdvanced) {
        const alpha = timeConstantMsToAlpha(prefs.timeSmoothingMs, dtMs);
        dspBridge.applyTimeSmoothing(raw, timeSmoothedRef.current, alpha);
      }
      dspBridge.applyOctaveSmoothing(
        timeSmoothedRef.current,
        octaveSmoothedRef.current,
        prefs.octaveSmoothing
      );
      if (prefs.showPeakHold && !isPaused && frameAdvanced) {
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
  }, [
    frameTick,
    isAudioActive,
    isPaused,
    prefs,
    sampleRate,
    fftSize,
    size,
    latestBinsRef,
    cursorReadout,
  ]);

  const isInsidePlot = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { padLeft, padTop, plotW, plotH } = getSpectrumPlotBounds(rect.width, rect.height);
    return x >= padLeft && x <= padLeft + plotW && y >= padTop && y <= padTop + plotH;
  };

  const isOnActiveReticle = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !cursorRef.current) return false;
    if (!isInsidePlot(clientX, clientY)) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.abs(x - cursorRef.current.x) <= 18;
  };

  const clearReticle = () => {
    cursorRef.current = null;
    setCursorReadout(null);
  };

  const updateCursorFromClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const { padLeft, padTop, plotW, plotH } = getSpectrumPlotBounds(rect.width, rect.height);
    if (x < padLeft || x > padLeft + plotW || y < padTop || y > padTop + plotH) {
      return;
    }
    cursorRef.current = { x, y };

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
    if (performance.now() - lastTouchTimeRef.current < 800) return;
    if (e.shiftKey || e.button === 1) {
      dragRef.current = {
        active: true,
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        startedOnReticle: false,
        moved: false,
        startMin: prefs.minFreq,
        startMax: prefs.maxFreq,
      };
      return;
    }

    const inside = isInsidePlot(e.clientX, e.clientY);
    const startedOnReticle = inside && isOnActiveReticle(e.clientX, e.clientY);
    dragRef.current = {
      active: inside,
      mode: 'reticle',
      startX: e.clientX,
      startY: e.clientY,
      startedOnReticle,
      moved: false,
      startMin: prefs.minFreq,
      startMax: prefs.maxFreq,
    };
    if (inside && !startedOnReticle) {
      updateCursorFromClient(e.clientX, e.clientY);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchTimeRef.current < 800) return;
    if (!dragRef.current?.active || !canvasRef.current) return;
    if (Math.hypot(e.clientX - dragRef.current.startX, e.clientY - dragRef.current.startY) > 4) {
      dragRef.current.moved = true;
    }

    if (dragRef.current.mode === 'pan') {
      if (!dragRef.current.moved) return;
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
      return;
    }

    if (dragRef.current.moved || !dragRef.current.startedOnReticle) {
      updateCursorFromClient(e.clientX, e.clientY);
    }
  };

  const handleMouseUp = () => {
    if (performance.now() - lastTouchTimeRef.current < 800) {
      dragRef.current = null;
      return;
    }
    if (
      dragRef.current?.active &&
      dragRef.current.mode === 'reticle' &&
      dragRef.current.startedOnReticle &&
      !dragRef.current.moved
    ) {
      clearReticle();
    }
    dragRef.current = null;
  };

  // Touch support: single-finger tap toggles/moves reticle; drag inspects; two-finger pinch zooms & pans
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchTimeRef.current = performance.now();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      dragRef.current = null;
      pinchRef.current = null;
      if (isInsidePlot(t.clientX, t.clientY)) {
        const startedOnReticle = isOnActiveReticle(t.clientX, t.clientY);
        touchTapRef.current = {
          startX: t.clientX,
          startY: t.clientY,
          startedOnReticle,
          moved: false,
        };
        if (!startedOnReticle) {
          updateCursorFromClient(t.clientX, t.clientY);
        }
      } else {
        touchTapRef.current = null;
      }
    } else if (e.touches.length === 2 && canvasRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const rect = canvasRef.current.getBoundingClientRect();
      const { padLeft, plotW } = getSpectrumPlotBounds(rect.width, rect.height);
      const startMidX = (t1.clientX + t2.clientX) / 2;
      const norm = Math.max(0, Math.min(1, (startMidX - rect.left - padLeft) / plotW));
      const centerFreq = normToFreq(norm, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
      pinchRef.current = {
        initialDist: Math.max(10, dist),
        startMidX,
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
        updateCursorFromClient(t.clientX, t.clientY);
      }
    } else if (e.touches.length === 2 && pinchRef.current && canvasRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const rect = canvasRef.current.getBoundingClientRect();
      const { plotW } = getSpectrumPlotBounds(rect.width, rect.height);
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = pinchRef.current.initialDist / Math.max(10, dist);
      const [zoomedLo, zoomedHi] = zoomFreqRange(
        pinchRef.current.startMin,
        pinchRef.current.startMax,
        pinchRef.current.centerFreq,
        scale,
        nyquist,
        prefs.freqScale
      );
      const midX = (t1.clientX + t2.clientX) / 2;
      const dxNorm = (midX - pinchRef.current.startMidX) / Math.max(1, plotW);
      const [lo, hi] = panFreqRange(zoomedLo, zoomedHi, -dxNorm, nyquist, prefs.freqScale);
      updateAnalyzerPrefs({ minFreq: lo, maxFreq: hi });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchTimeRef.current = performance.now();
    dragRef.current = null;
    if (
      e.touches.length === 0 &&
      touchTapRef.current?.startedOnReticle &&
      !touchTapRef.current.moved
    ) {
      clearReticle();
    }
    if (e.touches.length === 0) {
      touchTapRef.current = null;
    }
    if (e.touches.length < 2) {
      pinchRef.current = null;
    }
  };

  const handleExportPNG = () => {
    const numBins = Math.min(latestBinsRef.current.length, timeSmoothedRef.current.length);
    const { width: exportW, height: exportH } = getPngExportDimensions(size.width, size.height);
    const exportBounds = getSpectrumPlotBounds(exportW, exportH, EXPORT_LABEL_FONT_PX);
    const peakDb = isAudioActive
      ? getSpectrumPeakDbInRange(
          octaveSmoothedRef.current,
          peakHoldRef.current,
          prefs.showPeakHold,
          prefs,
          sampleRate,
          fftSize,
          numBins,
          exportBounds.plotW
        )
      : null;
    const exportPrefs = {
      ...prefs,
      maxDb: computePaddedExportMaxDb(peakDb, prefs.minDb, prefs.maxDb),
    };

    const exportCanvas = createHighResExportCanvas(
      size.width,
      size.height,
      `Spectrum Analyzer • ${formatFrequency(prefs.minFreq)} – ${formatFrequency(prefs.maxFreq)}`,
      (ctx, width, height, dpr) => {
        renderSpectrumCanvas(ctx, {
          width,
          height,
          dpr,
          prefs: exportPrefs,
          sampleRate,
          fftSize,
          numBins,
          isAudioActive,
          displayData: octaveSmoothedRef.current,
          peakHoldData: peakHoldRef.current,
          cursor: scaleSpectrumCursor(
            cursorRef.current,
            size.width,
            size.height,
            width,
            height,
            EXPORT_LABEL_FONT_PX
          ),
          labelFontPx: EXPORT_LABEL_FONT_PX,
        });
      },
      exportBounds.padLeft,
      exportBounds.padRight
    );
    exportCanvasToPNG(exportCanvas, 'spectral_analyzer');
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
      <div className="viz-stage-col">
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
              title="Spectrum Analyzer"
              description="Enable the microphone to begin. Drag with one finger to inspect frequencies, or use two fingers to scroll and pinch-zoom."
              onStartMic={() => void startMicrophone()}
            />
          )}
        </div>

        <FreqAxisZoomBar
          minFreq={prefs.minFreq}
          maxFreq={prefs.maxFreq}
          nyquist={nyquist}
          freqScale={prefs.freqScale}
          padLeft={getSpectrumPlotBounds(size.width, size.height).padLeft}
          padRight={getSpectrumPlotBounds(size.width, size.height).padRight}
          onRangeChange={(minFreq, maxFreq) => updateAnalyzerPrefs({ minFreq, maxFreq })}
        />
      </div>

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
