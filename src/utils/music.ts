import { FreqScale } from '../types/preferences';

export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export interface MusicalNoteInfo {
  midi: number;
  noteName: string;
  octave: number;
  label: string;
  targetFreq: number;
  cents: number; // -50 to +50
}

export const TONE_MIN_FREQ_HZ = 20;
export const TONE_MAX_FREQ_HZ = 5000;
export const MAX_DISPLAY_FREQ_HZ = 20000;

export function clampToneFrequency(freq: number): number {
  if (!Number.isFinite(freq)) return 440;
  return Math.max(TONE_MIN_FREQ_HZ, Math.min(TONE_MAX_FREQ_HZ, freq));
}

/**
 * Computes the frequency of `noteIdx` (0=C .. 11=B) in `octave`, shifting by octaves
 * if necessary so the result stays within [TONE_MIN_FREQ_HZ, TONE_MAX_FREQ_HZ].
 */
export function selectToneNoteInOctave(noteIdx: number, octave: number, referenceA4 = 440): number {
  const midi = (octave + 1) * 12 + noteIdx;
  let freq = midiToFrequency(midi, referenceA4);
  while (freq < TONE_MIN_FREQ_HZ) {
    freq *= 2;
  }
  while (freq > TONE_MAX_FREQ_HZ) {
    freq /= 2;
  }
  return clampToneFrequency(freq);
}

export function midiToFrequency(midi: number, referenceA4 = 440): number {
  return referenceA4 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteLabel(midi: number): { noteName: string; octave: number; label: string } {
  const rounded = Math.round(midi);
  const noteIdx = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const noteName = NOTE_NAMES[noteIdx];
  return {
    noteName,
    octave,
    label: `${noteName}${octave}`,
  };
}

export function frequencyToNoteInfo(freq: number, referenceA4 = 440): MusicalNoteInfo | null {
  if (!Number.isFinite(freq) || freq <= 0) return null;
  const midiFloat = 69 + 12 * Math.log2(freq / referenceA4);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  const targetFreq = midiToFrequency(midi, referenceA4);
  const { noteName, octave, label } = midiToNoteLabel(midi);
  return {
    midi,
    noteName,
    octave,
    label,
    targetFreq,
    cents,
  };
}

export function formatFrequency(freq: number): string {
  if (freq >= 1000) {
    const khz = freq / 1000;
    return khz >= 10 ? `${khz.toFixed(1)} kHz` : `${khz.toFixed(2)} kHz`;
  }
  return freq >= 100 ? `${freq.toFixed(0)} Hz` : `${freq.toFixed(1)} Hz`;
}

/**
 * Maps frequency in [minFreq, maxFreq] to normalized [0, 1] position.
 */
export function freqToNorm(
  freq: number,
  minFreq: number,
  maxFreq: number,
  scale: FreqScale
): number {
  if (maxFreq <= minFreq) return 0;
  if (scale === 'linear') {
    return (freq - minFreq) / (maxFreq - minFreq);
  }
  const safeMin = Math.max(1, minFreq);
  const safeFreq = Math.max(safeMin, freq);
  const logMin = Math.log10(safeMin);
  const logMax = Math.log10(Math.max(safeMin + 1, maxFreq));
  return (Math.log10(safeFreq) - logMin) / (logMax - logMin);
}

/**
 * Maps normalized [0, 1] position to frequency in [minFreq, maxFreq].
 */
export function normToFreq(
  norm: number,
  minFreq: number,
  maxFreq: number,
  scale: FreqScale
): number {
  const t = Math.max(0, Math.min(1, norm));
  if (scale === 'linear') {
    return minFreq + t * (maxFreq - minFreq);
  }
  const safeMin = Math.max(1, minFreq);
  const logMin = Math.log10(safeMin);
  const logMax = Math.log10(Math.max(safeMin + 1, maxFreq));
  return Math.pow(10, logMin + t * (logMax - logMin));
}

export function clampFreqRange(
  minFreq: number,
  maxFreq: number,
  nyquist: number,
  minSpanHz = 20
): [number, number] {
  const absMin = 20;
  const absMax = Math.min(MAX_DISPLAY_FREQ_HZ, Math.max(1000, nyquist));
  let lo = Math.max(absMin, Math.min(absMax - minSpanHz, minFreq));
  let hi = Math.min(absMax, Math.max(absMin + minSpanHz, maxFreq));
  if (hi - lo < minSpanHz) {
    hi = Math.min(absMax, lo + minSpanHz);
    lo = Math.max(absMin, hi - minSpanHz);
  }
  return [Math.round(lo), Math.round(hi)];
}

/**
 * Converts a time-smoothing constant in milliseconds (tauMs) and frame interval (dtMs)
 * into a 1-pole EMA smoothing coefficient alpha = exp(-dtMs / tauMs).
 */
export function timeConstantMsToAlpha(tauMs: number, dtMs = 1000 / 60): number {
  if (!Number.isFinite(tauMs) || tauMs <= 0) return 0;
  const safeDt = Math.max(1, Math.min(100, dtMs));
  return Math.exp(-safeDt / tauMs);
}

export const LOG_STANDARD_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

const LOG_ZOOM_CANDIDATES = [
  10, 15, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000,
  4000, 5000, 6000, 8000, 10000, 12000, 15000, 20_000,
];

const LINEAR_STEP_CANDIDATES = [25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/**
 * Computes clean, standard round frequency axis tick values for either Log or Linear scale.
 */
export function getFrequencyTicks(
  minFreq: number,
  maxFreq: number,
  scale: FreqScale,
  axisLengthPx = 700
): number[] {
  const safeMin = Math.max(20, minFreq);
  const safeMax = Math.max(safeMin + 10, maxFreq);

  if (scale === 'log') {
    const ratio = safeMax / safeMin;
    if (ratio >= 6) {
      return LOG_STANDARD_TICKS.filter((f) => f >= safeMin - 0.5 && f <= safeMax + 0.5);
    }
    const minGapPx = 28;
    const ticks: number[] = [];
    let lastPx = -Infinity;

    for (const f of LOG_ZOOM_CANDIDATES) {
      if (f < safeMin - 0.5 || f > safeMax + 0.5) continue;
      const px = freqToNorm(f, safeMin, safeMax, 'log') * axisLengthPx;
      if (px - lastPx >= minGapPx || ticks.length === 0) {
        ticks.push(f);
        lastPx = px;
      }
    }
    return ticks;
  }

  // Linear scale: choose a standard round step so ticks are clean numbers like 1k, 2k, 5k, 10k, 20k
  const span = safeMax - safeMin;
  const maxTicks = Math.max(4, Math.min(12, Math.floor(axisLengthPx / 58)));
  let step = LINEAR_STEP_CANDIDATES[LINEAR_STEP_CANDIDATES.length - 1];
  for (const candidate of LINEAR_STEP_CANDIDATES) {
    if (Math.floor(span / candidate) <= maxTicks) {
      step = candidate;
      break;
    }
  }

  const ticks: number[] = [];
  const first = Math.ceil(safeMin / step) * step;
  for (let f = first; f <= safeMax + 0.5; f += step) {
    ticks.push(Math.round(f));
  }
  return ticks;
}

export function formatFreqTick(f: number): string {
  if (f >= 1000) {
    const k = f / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${Math.round(f)}`;
}

/**
 * Pans [startMin, startMax] by `deltaNorm` fraction of its own span while preserving
 * the exact span width (no accidental zooming at 20 Hz or Nyquist boundaries).
 */
export function panFreqRange(
  startMin: number,
  startMax: number,
  deltaNorm: number,
  nyquist: number,
  scale: FreqScale
): [number, number] {
  const absMin = 20;
  const absMax = Math.min(MAX_DISPLAY_FREQ_HZ, Math.max(1000, nyquist));

  if (scale === 'log') {
    const lMin = Math.log10(Math.max(absMin, startMin));
    const lMax = Math.log10(Math.max(absMin + 1, startMax));
    const lSpan = lMax - lMin;
    const lAbsMin = Math.log10(absMin);
    const lAbsMax = Math.log10(absMax);
    let nextLo = lMin + deltaNorm * lSpan;
    let nextHi = lMax + deltaNorm * lSpan;
    if (nextLo < lAbsMin) {
      nextLo = lAbsMin;
      nextHi = Math.min(lAbsMax, lAbsMin + lSpan);
    }
    if (nextHi > lAbsMax) {
      nextHi = lAbsMax;
      nextLo = Math.max(lAbsMin, lAbsMax - lSpan);
    }
    return clampFreqRange(Math.pow(10, nextLo), Math.pow(10, nextHi), absMax);
  }

  const span = startMax - startMin;
  let nextLo = startMin + deltaNorm * span;
  let nextHi = startMax + deltaNorm * span;
  if (nextLo < absMin) {
    nextLo = absMin;
    nextHi = Math.min(absMax, absMin + span);
  }
  if (nextHi > absMax) {
    nextHi = absMax;
    nextLo = Math.max(absMin, absMax - span);
  }
  return clampFreqRange(nextLo, nextHi, absMax);
}

/**
 * Zooms [startMin, startMax] around `anchorFreq` by `zoomFactor` (>1 zooms out, <1 zooms in)
 * while clamping within [20, maxFreqLimit] and preserving at least `minSpanHz`.
 */
export function zoomFreqRange(
  startMin: number,
  startMax: number,
  anchorFreq: number,
  zoomFactor: number,
  maxFreqLimit: number,
  scale: FreqScale,
  minSpanHz = 40
): [number, number] {
  const absMin = 20;
  const absMax = Math.min(MAX_DISPLAY_FREQ_HZ, Math.max(1000, maxFreqLimit));

  if (scale === 'log') {
    const lMin = Math.log10(Math.max(absMin, startMin));
    const lMax = Math.log10(Math.max(absMin + 1, startMax));
    const lAnchor = Math.log10(Math.max(absMin, anchorFreq));
    const ratio = Math.max(0, Math.min(1, (lAnchor - lMin) / Math.max(0.001, lMax - lMin)));
    const nextSpan = Math.max(
      0.08,
      Math.min(Math.log10(absMax / absMin), (lMax - lMin) * zoomFactor)
    );
    return clampFreqRange(
      Math.pow(10, lAnchor - ratio * nextSpan),
      Math.pow(10, lAnchor + (1 - ratio) * nextSpan),
      absMax,
      minSpanHz
    );
  }

  const span = startMax - startMin;
  const ratio = Math.max(0, Math.min(1, (anchorFreq - startMin) / Math.max(1, span)));
  const nextSpan = Math.max(minSpanHz, Math.min(absMax - absMin, span * zoomFactor));
  return clampFreqRange(
    anchorFreq - ratio * nextSpan,
    anchorFreq + (1 - ratio) * nextSpan,
    absMax,
    minSpanHz
  );
}
