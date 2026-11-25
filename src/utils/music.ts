import { FreqScale } from '../types/preferences';

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

export interface MusicalNoteInfo {
  midi: number;
  noteName: string;
  octave: number;
  label: string;
  targetFreq: number;
  cents: number; // -50 to +50
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
  const absMax = Math.max(1000, nyquist);
  let lo = Math.max(absMin, Math.min(absMax - minSpanHz, minFreq));
  let hi = Math.min(absMax, Math.max(absMin + minSpanHz, maxFreq));
  if (hi - lo < minSpanHz) {
    hi = Math.min(absMax, lo + minSpanHz);
    lo = Math.max(absMin, hi - minSpanHz);
  }
  return [Math.round(lo), Math.round(hi)];
}
