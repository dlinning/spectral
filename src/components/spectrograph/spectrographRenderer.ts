import React from 'react';
import { SpectrographBuffer } from '../../audio/SpectrographBuffer';
import { SpectrographPreferences } from '../../types/preferences';
import { getColormapLUT } from '../../utils/colormaps';
import {
  formatFreqTick,
  formatFrequency,
  freqToNorm,
  frequencyToNoteInfo,
  getFrequencyTicks,
  normToFreq,
} from '../../utils/music';

export const SPECTROGRAPH_PLOT_PADDING = {
  left: 52, // Frequency Y-axis labels
  right: 52, // dB colorbar legend
  top: 16,
  bottom: 28, // Time X-axis labels
} as const;

export function getSpectrographPlotBounds(width: number, height: number, labelFontPx = 11) {
  const extra = Math.max(0, labelFontPx - 11);
  const padLeft = SPECTROGRAPH_PLOT_PADDING.left + extra * 3;
  const padRight = SPECTROGRAPH_PLOT_PADDING.right + extra * 4;
  const padTop = SPECTROGRAPH_PLOT_PADDING.top;
  const padBottom = SPECTROGRAPH_PLOT_PADDING.bottom + extra * 2;
  return {
    padLeft,
    padRight,
    padTop,
    padBottom,
    plotW: Math.max(10, Math.floor(width - padLeft - padRight)),
    plotH: Math.max(10, Math.floor(height - padTop - padBottom)),
  };
}

export function getSpectrographPeakDbInRange(
  buffer: SpectrographBuffer,
  prefs: SpectrographPreferences,
  sampleRate: number,
  fftSize: number,
  effectiveScrollBack: number,
  frameCount: number,
  latestMs: number
): number | null {
  if (frameCount <= 0) return null;
  const numBins = buffer.getNumBins();
  if (numBins <= 1) return null;

  const durationMs = prefs.historyDurationSec * 1000;
  const viewEndMs = latestMs - effectiveScrollBack * 1000;
  const viewStartMs = viewEndMs - durationMs;
  const binWidth = sampleRate / fftSize;
  const bLo = Math.max(1, Math.min(numBins - 1, Math.floor(prefs.minFreq / binWidth)));
  const bHi = Math.max(bLo, Math.min(numBins - 1, Math.ceil(prefs.maxFreq / binWidth)));

  let peakDb = -Infinity;
  for (let i = frameCount - 1; i >= 0; i--) {
    const ts = buffer.getTimestampAt(i);
    if (ts < viewStartMs) break;
    if (ts > viewEndMs) continue;
    const frame = buffer.getFrameView(i);
    if (!frame) continue;
    for (let b = bLo; b <= bHi; b++) {
      const val = frame[b];
      if (Number.isFinite(val) && val > peakDb) peakDb = val;
    }
  }

  return Number.isFinite(peakDb) && peakDb > -150 ? peakDb : null;
}

export function getSpectrographTargetPoint(
  target: SpectrographHoverInfo,
  width: number,
  height: number,
  prefs: SpectrographPreferences,
  effectiveScrollBack: number,
  labelFontPx = 11
): { x: number; y: number } | null {
  const { padLeft, padTop, plotW, plotH } = getSpectrographPlotBounds(width, height, labelFontPx);
  const normX = 1 - (-target.timeOffsetSec - effectiveScrollBack) / prefs.historyDurationSec;
  const normY = freqToNorm(target.freq, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
  if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;
  return {
    x: padLeft + normX * plotW,
    y: padTop + (1 - normY) * plotH,
  };
}

export interface SpectrographRenderParams {
  width: number;
  height: number;
  dpr: number;
  prefs: SpectrographPreferences;
  buffer: SpectrographBuffer;
  sampleRate: number;
  fftSize: number;
  effectiveScrollBack: number;
  frameCount: number;
  earliestMs: number;
  latestMs: number;
  target?: SpectrographHoverInfo | null;
  labelFontPx?: number;
}

export function renderSpectrographCanvas(
  ctx: CanvasRenderingContext2D,
  offscreenRef: React.MutableRefObject<HTMLCanvasElement | null>,
  imageDataRef: React.MutableRefObject<ImageData | null>,
  params: SpectrographRenderParams
): void {
  const {
    width: w,
    height: h,
    dpr,
    prefs,
    buffer,
    sampleRate,
    fftSize,
    effectiveScrollBack,
    frameCount,
    earliestMs,
    latestMs,
    target,
    labelFontPx = 11,
  } = params;

  const { padLeft, padTop, plotW, plotH } = getSpectrographPlotBounds(w, h, labelFontPx);

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
        const targetTs = viewStartMs + (px / Math.max(1, plotW - 1)) * durationMs;

        while (frameCursor > 0 && buffer.getTimestampAt(frameCursor) > targetTs) {
          frameCursor--;
        }

        const ts = buffer.getTimestampAt(frameCursor);
        if (targetTs >= earliestMs - 250 && Math.abs(targetTs - ts) <= 500) {
          colFrameIdx[px] = frameCursor;
        }
      }

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
          const colorIdx = Math.max(0, Math.min(255, Math.round((db - prefs.minDb) * invDbSpan)));
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
  const freqTicks = getFrequencyTicks(prefs.minFreq, prefs.maxFreq, prefs.freqScale, plotH);

  ctx.font = `${labelFontPx}px JetBrains Mono, monospace`;
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

  // Target reticle & axis badges
  if (target) {
    const pt = getSpectrographTargetPoint(target, w, h, prefs, effectiveScrollBack, labelFontPx);
    if (pt) {
      const { x: tx, y: ty } = pt;

      ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, padTop);
      ctx.lineTo(tx, padTop + plotH);
      ctx.moveTo(padLeft, ty);
      ctx.lineTo(padLeft + plotW, ty);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(tx, ty, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.25;
      ctx.stroke();

      ctx.font = `bold ${labelFontPx}px JetBrains Mono, monospace`;
      const badgeH = labelFontPx + 7;
      const freqText = formatFrequency(target.freq);
      const freqBadgeW = padLeft - 4;
      const freqBadgeY = Math.max(padTop, Math.min(padTop + plotH - badgeH, ty - badgeH / 2));
      ctx.fillStyle = '#0e7490';
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(2, freqBadgeY, freqBadgeW, badgeH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(freqText, padLeft - 6, freqBadgeY + badgeH / 2);

      const timeText =
        Math.abs(target.timeOffsetSec) < 0.05 ? '0s' : `${target.timeOffsetSec.toFixed(1)}s`;
      const timeBadgeW = ctx.measureText(timeText).width + 14;
      const timeBadgeX = Math.max(
        padLeft,
        Math.min(padLeft + plotW - timeBadgeW, tx - timeBadgeW / 2)
      );
      const timeBadgeY = padTop + plotH + 4;
      ctx.fillStyle = '#0e7490';
      ctx.strokeStyle = '#22d3ee';
      ctx.beginPath();
      ctx.roundRect(timeBadgeX, timeBadgeY, timeBadgeW, badgeH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeText, timeBadgeX + timeBadgeW / 2, timeBadgeY + badgeH / 2);
    }
  }

  ctx.restore();
}

export interface SpectrographHoverInfo {
  freq: number;
  note: string;
  timeOffsetSec: number;
  db: number | null;
}

export function inspectSpectrographPoint(
  buffer: SpectrographBuffer,
  clientX: number,
  clientY: number,
  rect: DOMRect,
  prefs: SpectrographPreferences,
  fftSize: number,
  sampleRate: number,
  effectiveScrollBack: number,
  frameCount: number,
  latestMs: number
): SpectrographHoverInfo | null {
  const { padLeft, padTop, plotW, plotH } = getSpectrographPlotBounds(rect.width, rect.height);
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  if (x < padLeft || x > padLeft + plotW || y < padTop || y > padTop + plotH) {
    return null;
  }

  const normX = (x - padLeft) / plotW;
  const normY = 1 - (y - padTop) / plotH;
  const freq = normToFreq(normY, prefs.minFreq, prefs.maxFreq, prefs.freqScale);
  const timeOffsetSec = -(effectiveScrollBack + (1 - normX) * prefs.historyDurationSec);
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

  return { freq, note, timeOffsetSec, db };
}
