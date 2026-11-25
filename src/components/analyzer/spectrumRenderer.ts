import { FreqScale, OctaveSmoothing, SpectrumAnalyzerPreferences } from '../../types/preferences';
import {
  formatFreqTick,
  formatFrequency,
  freqToNorm,
  frequencyToNoteInfo,
  getFrequencyTicks,
  normToFreq,
} from '../../utils/music';

export const SPECTRUM_PLOT_PADDING = {
  left: 46,
  right: 22,
  top: 18,
  bottom: 28,
} as const;

export interface PlotBounds {
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  plotW: number;
  plotH: number;
}

export function getSpectrumPlotBounds(width: number, height: number): PlotBounds {
  const { left: padLeft, right: padRight, top: padTop, bottom: padBottom } = SPECTRUM_PLOT_PADDING;
  return {
    padLeft,
    padRight,
    padTop,
    padBottom,
    plotW: Math.max(10, width - padLeft - padRight),
    plotH: Math.max(10, height - padTop - padBottom),
  };
}

export function computeTiltOffset(freqHz: number, tiltSlope: number): number {
  return tiltSlope ? tiltSlope * Math.log2(Math.max(20, freqHz) / 1000) : 0;
}

/**
 * Samples the spectrum dB value for a horizontal pixel column, using max-pooling
 * across FFT bins when multiple bins fall inside a single pixel (above ~1 kHz on log axes).
 */
export function sampleSpectrumColumnDb(
  arr: Float32Array,
  px: number,
  plotW: number,
  minFreq: number,
  maxFreq: number,
  freqScale: FreqScale,
  binWidth: number,
  numBins: number,
  octaveSmoothing: OctaveSmoothing,
  tiltSlope: number
): number {
  const fCenter = normToFreq(px / plotW, minFreq, maxFreq, freqScale);
  const f0 = normToFreq(Math.max(0, px - 0.5) / plotW, minFreq, maxFreq, freqScale);
  const f1 = normToFreq(Math.min(plotW, px + 0.5) / plotW, minFreq, maxFreq, freqScale);

  const bf0 = f0 / binWidth;
  const bf1 = f1 / binWidth;
  const bf = fCenter / binWidth;
  const b0 = Math.max(1, Math.min(numBins - 1, Math.floor(bf)));
  const b1 = Math.max(1, Math.min(numBins - 1, Math.ceil(bf)));
  const frac = bf - b0;
  let rawDb = arr[b0] * (1 - frac) + arr[b1] * frac;

  if (octaveSmoothing === 0 && bf1 - bf0 >= 1.0) {
    const bStart = Math.max(1, Math.min(numBins - 1, Math.floor(bf0)));
    const bEnd = Math.max(1, Math.min(numBins - 1, Math.ceil(bf1)));
    for (let b = bStart; b <= bEnd; b++) {
      if (arr[b] > rawDb) rawDb = arr[b];
    }
  }
  return rawDb + computeTiltOffset(fCenter, tiltSlope);
}

export interface SpectrumRenderParams {
  width: number;
  height: number;
  dpr: number;
  prefs: SpectrumAnalyzerPreferences;
  sampleRate: number;
  fftSize: number;
  numBins: number;
  isAudioActive: boolean;
  displayData: Float32Array;
  peakHoldData: Float32Array;
  cursor: { x: number; y: number } | null;
}

export interface SpectrumCursorTrack {
  freq: number;
  db: number;
  noteText: string;
}

export function renderSpectrumCanvas(
  ctx: CanvasRenderingContext2D,
  params: SpectrumRenderParams
): SpectrumCursorTrack | null {
  const {
    width: w,
    height: h,
    dpr,
    prefs,
    sampleRate,
    fftSize,
    numBins,
    isAudioActive,
    displayData,
    peakHoldData,
    cursor,
  } = params;

  const { padLeft, padTop, plotW, plotH } = getSpectrumPlotBounds(w, h);

  ctx.save();
  ctx.scale(dpr, dpr);

  // Background & plot surface
  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#09101d';
  ctx.fillRect(padLeft, padTop, plotW, plotH);

  // Horizontal dB grid lines
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

  // Vertical frequency grid lines
  const freqTicks = getFrequencyTicks(prefs.minFreq, prefs.maxFreq, prefs.freqScale, plotW);

  ctx.textBaseline = 'top';
  for (const f of freqTicks) {
    const norm = freqToNorm(f, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const x = padLeft + norm * plotW;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = x > padLeft + plotW - 14 ? 'right' : x < padLeft + 14 ? 'left' : 'center';
    ctx.fillText(formatFreqTick(f), x, padTop + plotH + 6);
  }

  // Clip to plot region for spectrum curves
  ctx.save();
  ctx.beginPath();
  ctx.rect(padLeft, padTop, plotW, plotH);
  ctx.clip();

  const binWidth = sampleRate / fftSize;

  const mapDbToY = (db: number) => {
    const clamped = Math.max(dbMin, Math.min(dbMax, db));
    return padTop + ((dbMax - clamped) / dbSpan) * plotH;
  };

  const sampleCol = (arr: Float32Array, px: number) =>
    sampleSpectrumColumnDb(
      arr,
      px,
      plotW,
      prefs.minFreq,
      prefs.maxFreq,
      prefs.freqScale,
      binWidth,
      numBins,
      prefs.octaveSmoothing,
      prefs.tiltSlope
    );

  // Peak Hold curve
  if (prefs.showPeakHold && isAudioActive && numBins > 1) {
    ctx.beginPath();
    for (let px = 0; px <= plotW; px += 1) {
      const x = padLeft + px;
      const y = mapDbToY(sampleCol(peakHoldData, px));
      if (px === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Live Spectrum curve
  if (isAudioActive && numBins > 1) {
    ctx.beginPath();
    let firstX = padLeft;
    let lastX = padLeft;

    for (let px = 0; px <= plotW; px += 1) {
      const x = padLeft + px;
      const y = mapDbToY(sampleCol(displayData, px));
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
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Cursor Crosshair — tracks live dB at the targeted frequency
  const cursorInPlot =
    cursor !== null &&
    cursor.x >= padLeft &&
    cursor.x <= padLeft + plotW &&
    cursor.y >= padTop &&
    cursor.y <= padTop + plotH;

  let tracked: SpectrumCursorTrack | null = null;
  let trackedY = 0;

  if (cursorInPlot && cursor) {
    const px = cursor.x - padLeft;
    const trackedFreq = normToFreq(px / plotW, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
    const trackedDb =
      isAudioActive && numBins > 1
        ? sampleCol(displayData, px)
        : dbMax - ((cursor.y - padTop) / plotH) * dbSpan;
    trackedY = Math.max(padTop, Math.min(padTop + plotH, mapDbToY(trackedDb)));

    // Crosshair lines intersecting at (cursor.x, trackedY)
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.42)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cursor.x, padTop);
    ctx.lineTo(cursor.x, padTop + plotH);
    ctx.moveTo(padLeft, trackedY);
    ctx.lineTo(padLeft + plotW, trackedY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Target marker dot following the curve at targeted frequency
    ctx.beginPath();
    ctx.arc(cursor.x, trackedY, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.28)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cursor.x, trackedY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#22d3ee';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    const noteInfo = frequencyToNoteInfo(trackedFreq);
    const noteText = noteInfo
      ? `${noteInfo.label} ${noteInfo.cents >= 0 ? '+' : ''}${noteInfo.cents.toFixed(0)}¢`
      : '—';

    tracked = { freq: trackedFreq, db: trackedDb, noteText };
  }

  ctx.restore(); // unclip

  // Plot border
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // Highlighted axis badges for targeted dB and frequency
  if (tracked && cursor) {
    ctx.font = 'bold 11px JetBrains Mono, monospace';

    const dbText = `${tracked.db.toFixed(1)}`;
    const dbBadgeW = padLeft - 4;
    const dbBadgeH = 18;
    const dbBadgeY = Math.max(padTop, Math.min(padTop + plotH - dbBadgeH, trackedY - dbBadgeH / 2));
    ctx.fillStyle = '#0e7490';
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(2, dbBadgeY, dbBadgeW, dbBadgeH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(dbText, padLeft - 6, dbBadgeY + dbBadgeH / 2);

    const freqText = formatFrequency(tracked.freq);
    const freqTextW = ctx.measureText(freqText).width;
    const freqBadgeW = freqTextW + 12;
    const freqBadgeH = 18;
    const freqBadgeX = Math.max(
      padLeft,
      Math.min(padLeft + plotW - freqBadgeW, cursor.x - freqBadgeW / 2)
    );
    const freqBadgeY = padTop + plotH + 4;
    ctx.fillStyle = '#0e7490';
    ctx.strokeStyle = '#22d3ee';
    ctx.beginPath();
    ctx.roundRect(freqBadgeX, freqBadgeY, freqBadgeW, freqBadgeH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(freqText, freqBadgeX + freqBadgeW / 2, freqBadgeY + freqBadgeH / 2);
  }

  ctx.restore();
  return tracked;
}
