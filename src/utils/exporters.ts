import { SpectrographBuffer } from '../audio/SpectrographBuffer';
import { SpectrographPreferences, SpectrumAnalyzerPreferences } from '../types/preferences';

export interface SpectrumExportMeta {
  exportedAt: string;
  sampleRate: number;
  fftSize: number;
  minFreq: number;
  maxFreq: number;
  freqScale: string;
  timeSmoothingMs: number;
  octaveSmoothing: string;
}

export interface SpectrographExportMeta {
  exportedAt: string;
  sampleRate: number;
  fftSize: number;
  minFreq: number;
  maxFreq: number;
  freqScale: string;
  timeSmoothingMs: number;
  historyDurationSec: number;
  colormap: string;
  frameCount: number;
}

function octaveLabel(denom: number): string {
  return denom <= 0 ? 'Off' : `1/${denom}`;
}

export function triggerFileDownload(content: BlobPart, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCanvasToPNG(canvas: HTMLCanvasElement, filenamePrefix: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dataUrl = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `${filenamePrefix}_${ts}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function formatSpectrumCSV(
  smoothedDb: Float32Array,
  peakDb: Float32Array | null,
  sampleRate: number,
  fftSize: number,
  prefs: SpectrumAnalyzerPreferences
): string {
  const binWidth = sampleRate / fftSize;
  const lines: string[] = ['Frequency_Hz,Magnitude_dB,Peak_dB'];

  for (let i = 1; i < smoothedDb.length; i++) {
    const freq = i * binWidth;
    if (freq < prefs.minFreq || freq > prefs.maxFreq) continue;
    const mag = Number.isFinite(smoothedDb[i]) ? smoothedDb[i].toFixed(3) : '-120.000';
    const peak = peakDb && Number.isFinite(peakDb[i]) ? peakDb[i].toFixed(3) : mag;
    lines.push(`${freq.toFixed(2)},${mag},${peak}`);
  }
  return lines.join('\n');
}

export function formatSpectrumJSON(
  smoothedDb: Float32Array,
  peakDb: Float32Array | null,
  sampleRate: number,
  fftSize: number,
  prefs: SpectrumAnalyzerPreferences
): string {
  const binWidth = sampleRate / fftSize;
  const points: { frequencyHz: number; magnitudeDb: number; peakDb?: number }[] = [];

  for (let i = 1; i < smoothedDb.length; i++) {
    const freq = i * binWidth;
    if (freq < prefs.minFreq || freq > prefs.maxFreq) continue;
    const item: { frequencyHz: number; magnitudeDb: number; peakDb?: number } = {
      frequencyHz: Number(freq.toFixed(2)),
      magnitudeDb: Number((Number.isFinite(smoothedDb[i]) ? smoothedDb[i] : -120).toFixed(3)),
    };
    if (peakDb) {
      item.peakDb = Number((Number.isFinite(peakDb[i]) ? peakDb[i] : -120).toFixed(3));
    }
    points.push(item);
  }

  const meta: SpectrumExportMeta = {
    exportedAt: new Date().toISOString(),
    sampleRate,
    fftSize,
    minFreq: prefs.minFreq,
    maxFreq: prefs.maxFreq,
    freqScale: prefs.freqScale,
    timeSmoothingMs: prefs.timeSmoothingMs,
    octaveSmoothing: octaveLabel(prefs.octaveSmoothing),
  };

  return JSON.stringify({ metadata: meta, data: points }, null, 2);
}

/**
 * Downsamples frequency bins inside [minFreq, maxFreq] for tractable CSV/JSON file sizes
 * while preserving full resolution when the zoomed bin count is <= maxColumns.
 */
function selectBinIndices(
  numBins: number,
  sampleRate: number,
  fftSize: number,
  minFreq: number,
  maxFreq: number,
  maxColumns = 256
): number[] {
  const binWidth = sampleRate / fftSize;
  const inRange: number[] = [];
  for (let i = 1; i < numBins; i++) {
    const f = i * binWidth;
    if (f >= minFreq && f <= maxFreq) {
      inRange.push(i);
    }
  }
  if (inRange.length <= maxColumns) return inRange;

  const sampled: number[] = [];
  const step = (inRange.length - 1) / (maxColumns - 1);
  for (let k = 0; k < maxColumns; k++) {
    sampled.push(inRange[Math.round(k * step)]);
  }
  return sampled;
}

export function formatSpectrographCSV(
  buffer: SpectrographBuffer,
  fftSize: number,
  prefs: SpectrographPreferences,
  referenceNowMs?: number
): string {
  const slice = buffer.getHistorySlice(prefs.historyDurationSec, referenceNowMs);
  const binWidth = slice.sampleRate / fftSize;
  const binIndices = selectBinIndices(
    slice.numBins,
    slice.sampleRate,
    fftSize,
    prefs.minFreq,
    prefs.maxFreq,
    256
  );

  const header = [
    'Time_Offset_s',
    ...binIndices.map((b) => `${(b * binWidth).toFixed(1)}_Hz`),
  ].join(',');

  if (slice.frames.length === 0) {
    return header;
  }

  const latestMs = slice.timestampsMs[slice.timestampsMs.length - 1];
  const lines: string[] = [header];

  // Downsample frames if exporting 3600 frames to keep CSV snappy (~600 rows max)
  const frameStep = Math.max(1, Math.floor(slice.frames.length / 600));
  for (let f = 0; f < slice.frames.length; f += frameStep) {
    const offsetSec = (slice.timestampsMs[f] - latestMs) / 1000;
    const frame = slice.frames[f];
    const row = [
      offsetSec.toFixed(3),
      ...binIndices.map((b) => {
        const v = frame[b];
        return Number.isFinite(v) ? v.toFixed(2) : '-120.00';
      }),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

export function formatSpectrographJSON(
  buffer: SpectrographBuffer,
  fftSize: number,
  prefs: SpectrographPreferences,
  referenceNowMs?: number
): string {
  const slice = buffer.getHistorySlice(prefs.historyDurationSec, referenceNowMs);
  const binWidth = slice.sampleRate / fftSize;
  const binIndices = selectBinIndices(
    slice.numBins,
    slice.sampleRate,
    fftSize,
    prefs.minFreq,
    prefs.maxFreq,
    256
  );

  const latestMs =
    slice.timestampsMs.length > 0 ? slice.timestampsMs[slice.timestampsMs.length - 1] : 0;

  const frameStep = Math.max(1, Math.floor(slice.frames.length / 600));
  const framesOut: { timeOffsetSec: number; magnitudesDb: number[] }[] = [];

  for (let f = 0; f < slice.frames.length; f += frameStep) {
    const offsetSec = Number(((slice.timestampsMs[f] - latestMs) / 1000).toFixed(3));
    const frame = slice.frames[f];
    framesOut.push({
      timeOffsetSec: offsetSec,
      magnitudesDb: binIndices.map((b) =>
        Number((Number.isFinite(frame[b]) ? frame[b] : -120).toFixed(2))
      ),
    });
  }

  const meta: SpectrographExportMeta = {
    exportedAt: new Date().toISOString(),
    sampleRate: slice.sampleRate,
    fftSize,
    minFreq: prefs.minFreq,
    maxFreq: prefs.maxFreq,
    freqScale: prefs.freqScale,
    timeSmoothingMs: prefs.timeSmoothingMs,
    historyDurationSec: prefs.historyDurationSec,
    colormap: prefs.colormap,
    frameCount: framesOut.length,
  };

  return JSON.stringify(
    {
      metadata: meta,
      frequenciesHz: binIndices.map((b) => Number((b * binWidth).toFixed(2))),
      frames: framesOut,
    },
    null,
    2
  );
}
