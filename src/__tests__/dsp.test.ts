import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dspBridge, detectPitchMPMFallback } from '../wasm/dspBridge';
import { SpectrographBuffer } from '../audio/SpectrographBuffer';
import {
  formatSpectrumCSV,
  formatSpectrumJSON,
  formatSpectrographCSV,
  formatSpectrographJSON,
} from '../utils/exporters';
import { DEFAULT_PREFERENCES, OctaveSmoothing } from '../types/preferences';
import { PREFERENCES_STORAGE_KEY, loadPreferences, savePreferences } from '../hooks/usePreferences';
import {
  formatFreqTick,
  frequencyToNoteInfo,
  getFrequencyTicks,
  timeConstantMsToAlpha,
  zoomFreqRange,
} from '../utils/music';

function generateSine(freqHz: number, sampleRate: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function centsBetween(measuredHz: number, expectedHz: number): number {
  return 1200 * Math.log2(measuredHz / expectedHz);
}

describe('Spectral WASM DSP & Core Modules', () => {
  beforeAll(async () => {
    const wasmPath = path.resolve(process.cwd(), 'public/wasm/spectral_dsp.wasm');
    const bytes = fs.readFileSync(wasmPath);
    const loaded = await dspBridge.initFromBytes(bytes);
    expect(loaded).toBe(true);
    expect(dspBridge.isWasmReady()).toBe(true);
  });

  describe('Fractional-Octave Smoothing (Off, 1/24, 1/12, 1/6, 1/3, 1/2)', () => {
    it('preserves approximate total linear power and progressively widens narrow peaks', () => {
      const len = 1024;
      const inputDb = new Float32Array(len).fill(-90);
      // Narrow peak centered at bin 200
      inputDb[199] = -15;
      inputDb[200] = 0;
      inputDb[201] = -15;

      const denoms: OctaveSmoothing[] = [0, 24, 12, 6, 3, 2];
      const peakWidths: number[] = [];
      const peakHeights: number[] = [];

      const totalPower = (arr: Float32Array) => {
        let sum = 0;
        for (let i = 50; i < 600; i++) {
          sum += Math.pow(10, arr[i] / 10);
        }
        return sum;
      };

      const basePower = totalPower(inputDb);

      for (const denom of denoms) {
        const out = new Float32Array(len);
        dspBridge.applyOctaveSmoothing(inputDb, out, denom);

        if (denom === 0) {
          expect(out[200]).toBeCloseTo(0, 4);
          expect(out[100]).toBeCloseTo(-90, 4);
        } else {
          // Total energy in the surrounding region stays within same order (power-conserving average)
          const p = totalPower(out);
          expect(p).toBeGreaterThan(basePower * 0.5);
          expect(p).toBeLessThan(basePower * 1.6);
        }

        // Measure peak width above -30 dB and peak height
        let width = 0;
        for (let i = 50; i < 600; i++) {
          if (out[i] > -30) width++;
        }
        peakWidths.push(width);
        peakHeights.push(out[200]);
      }

      // Wider octave fractions produce strictly non-decreasing peak width & non-increasing peak height
      for (let i = 1; i < peakWidths.length; i++) {
        expect(peakWidths[i]).toBeGreaterThanOrEqual(peakWidths[i - 1]);
        expect(peakHeights[i]).toBeLessThanOrEqual(peakHeights[i - 1]);
      }
      expect(peakWidths[peakWidths.length - 1]).toBeGreaterThan(peakWidths[0]);
    });
  });

  describe('Time Smoothing & Peak Hold', () => {
    it('converts time smoothing constants in ms to exponential smoothing alpha', () => {
      expect(timeConstantMsToAlpha(0, 16.67)).toBe(0);
      const alpha60 = timeConstantMsToAlpha(60, 1000 / 60);
      const alpha500 = timeConstantMsToAlpha(500, 1000 / 60);
      expect(alpha60).toBeGreaterThan(0.7);
      expect(alpha60).toBeLessThan(0.8);
      expect(alpha500).toBeGreaterThan(alpha60);
      expect(alpha500).toBeLessThan(1);
    });

    it('applies exponential moving average and tracks decaying peak hold', () => {
      const curr = new Float32Array([-20, -40, -60]);
      const smoothed = new Float32Array([-80, -80, -80]);
      dspBridge.applyTimeSmoothing(curr, smoothed, 0.5);

      expect(smoothed[0]).toBeCloseTo(-50, 3);
      expect(smoothed[1]).toBeCloseTo(-60, 3);
      expect(smoothed[2]).toBeCloseTo(-70, 3);

      const peak = new Float32Array([-30, -30, -30]);
      dspBridge.updatePeakHold(curr, peak, 1.0);
      expect(peak[0]).toBeCloseTo(-20, 3); // new high
      expect(peak[1]).toBeCloseTo(-31, 3); // decayed by 1 dB
      expect(peak[2]).toBeCloseTo(-31, 3);
    });
  });

  describe('McLeod Pitch Method (MPM) Pitch Detection', () => {
    const sampleRate = 48000;
    const bufferLen = 4096;

    it('detects A4 = 440.0 Hz, E2 = 82.41 Hz, and C6 = 1046.50 Hz within ±0.5 cents', () => {
      const targets = [
        { name: 'A4', hz: 440.0 },
        { name: 'E2', hz: 82.4069 },
        { name: 'C6', hz: 1046.5023 },
      ];

      for (const target of targets) {
        const sine = generateSine(target.hz, sampleRate, bufferLen);
        const wasmResult = dspBridge.detectPitchMPM(sine, sampleRate, 0.78);
        const tsResult = detectPitchMPMFallback(sine, sampleRate, 0.78);

        expect(wasmResult.frequency).toBeGreaterThan(0);
        expect(wasmResult.clarity).toBeGreaterThan(0.95);
        expect(Math.abs(centsBetween(wasmResult.frequency, target.hz))).toBeLessThan(0.5);
        expect(Math.abs(centsBetween(tsResult.frequency, target.hz))).toBeLessThan(0.5);

        const noteInfo = frequencyToNoteInfo(wasmResult.frequency, 440);
        expect(noteInfo?.label).toBe(target.name);
      }
    });

    it('returns -1 for silence below RMS noise gate', () => {
      const silence = new Float32Array(bufferLen);
      const res = dspBridge.detectPitchMPM(silence, sampleRate, 0.78);
      expect(res.frequency).toBe(-1);
    });
  });

  describe('Spectrograph 60-Second Ring Buffer', () => {
    it('stores up to 3600 frames (60s at 60fps) and slices 5s, 15s, 30s, 60s accurately', () => {
      const numBins = 64;
      const buffer = new SpectrographBuffer(3600, numBins, 48000, 60);
      const frame = new Float32Array(numBins);

      // Push 4000 frames at exact 16.6667ms intervals (~66.6s) to test ring wrap-around
      const dt = 1000 / 60;
      for (let i = 0; i < 4000; i++) {
        frame.fill(-100 + (i % 80));
        buffer.pushFrame(frame, i * dt, true);
      }

      expect(buffer.getFrameCount()).toBe(3600);

      const slice5 = buffer.getHistorySlice(5);
      const slice15 = buffer.getHistorySlice(15);
      const slice30 = buffer.getHistorySlice(30);
      const slice60 = buffer.getHistorySlice(60);

      expect(slice5.frames.length).toBeGreaterThanOrEqual(299);
      expect(slice5.frames.length).toBeLessThanOrEqual(302);
      expect(slice15.frames.length).toBeGreaterThanOrEqual(899);
      expect(slice15.frames.length).toBeLessThanOrEqual(902);
      expect(slice30.frames.length).toBeGreaterThanOrEqual(1799);
      expect(slice30.frames.length).toBeLessThanOrEqual(1802);
      expect(slice60.frames.length).toBe(3600);

      // Oldest frame after 4000 pushes in 3600-capacity ring is frame #400
      const oldestView = buffer.getFrameView(0);
      expect(oldestView?.[0]).toBeCloseTo(-100 + (400 % 80), 3);

      // Scrolled-back window slice (5s ending 10s before latest)
      const latestTs = buffer.getLatestTimestamp();
      const scrolledSlice = buffer.getHistorySlice(5, latestTs - 10000);
      expect(scrolledSlice.frames.length).toBeGreaterThanOrEqual(299);
      expect(scrolledSlice.frames.length).toBeLessThanOrEqual(302);
      expect(scrolledSlice.timestampsMs[scrolledSlice.timestampsMs.length - 1]).toBeLessThanOrEqual(
        latestTs - 10000
      );
    });
  });

  describe('CSV & JSON Exporters', () => {
    it('exports Spectrum Analyzer data to valid CSV and JSON', () => {
      const bins = new Float32Array(1024).fill(-55);
      const peaks = new Float32Array(1024).fill(-40);
      bins[10] = -12.5;
      peaks[10] = -8.25;

      const csv = formatSpectrumCSV(bins, peaks, 48000, 2048, DEFAULT_PREFERENCES.analyzer);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('Frequency_Hz,Magnitude_dB,Peak_dB');
      expect(lines.length).toBeGreaterThan(100);

      const jsonText = formatSpectrumJSON(bins, peaks, 48000, 2048, DEFAULT_PREFERENCES.analyzer);
      const parsed = JSON.parse(jsonText);
      expect(parsed.metadata.fftSize).toBe(2048);
      expect(parsed.metadata.octaveSmoothing).toBe('Off');
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data.length).toBeGreaterThan(100);
    });

    it('exports Spectrograph data to valid CSV and JSON', () => {
      const buffer = new SpectrographBuffer(3600, 128, 48000, 60);
      const frame = new Float32Array(128).fill(-65);
      for (let i = 0; i < 10; i++) {
        frame[4] = -20 - i;
        buffer.pushFrame(frame, i * 100, true);
      }

      const csv = formatSpectrographCSV(buffer, 256, DEFAULT_PREFERENCES.spectrograph);
      const lines = csv.split('\n');
      expect(lines[0].startsWith('Time_Offset_s,')).toBe(true);
      expect(lines.length).toBe(11); // header + 10 frames

      const jsonText = formatSpectrographJSON(buffer, 256, DEFAULT_PREFERENCES.spectrograph);
      const parsed = JSON.parse(jsonText);
      expect(parsed.metadata.historyDurationSec).toBe(30);
      expect(parsed.frames.length).toBe(10);
      expect(Array.isArray(parsed.frequenciesHz)).toBe(true);
    });
  });

  describe('User Preferences Persistence', () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it('persists and restores active tab and view preferences via localStorage', () => {
      const custom = structuredClone(DEFAULT_PREFERENCES);
      custom.activeTab = 'spectrograph';
      custom.analyzer.octaveSmoothing = 12;
      custom.analyzer.freqScale = 'linear';
      custom.spectrograph.historyDurationSec = 60;
      custom.tuner.referenceA4 = 442;

      savePreferences(custom);
      expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).not.toBeNull();

      const restored = loadPreferences();
      expect(restored.activeTab).toBe('spectrograph');
      expect(restored.analyzer.octaveSmoothing).toBe(12);
      expect(restored.analyzer.freqScale).toBe('linear');
      expect(restored.spectrograph.historyDurationSec).toBe(60);
      expect(restored.tuner.referenceA4).toBe(442);
    });
  });

  describe('Standard Frequency Axis Ticks', () => {
    it('includes 1k, 2k, and 20k on log scale even on mobile widths and uses clean round ticks on linear scale', () => {
      const logMobile = getFrequencyTicks(20, 20000, 'log', 280);
      expect(logMobile).toContain(1000);
      expect(logMobile).toContain(2000);
      expect(logMobile).toContain(20000);

      const linearDesktop = getFrequencyTicks(20, 24000, 'linear', 800);
      expect(linearDesktop).toContain(20000);
      for (const t of linearDesktop) {
        expect(t % 1000).toBe(0);
        const label = formatFreqTick(t);
        expect(label.includes('.')).toBe(false);
      }
    });

    it('zooms frequency ranges around an anchor frequency for both log and linear scales', () => {
      const [logLo, logHi] = zoomFreqRange(20, 20000, 1000, 0.5, 24000, 'log');
      expect(logLo).toBeGreaterThan(20);
      expect(logHi).toBeLessThan(20000);
      expect(logLo).toBeLessThan(1000);
      expect(logHi).toBeGreaterThan(1000);

      const [linLo, linHi] = zoomFreqRange(1000, 5000, 3000, 0.5, 24000, 'linear');
      expect(linLo).toBe(2000);
      expect(linHi).toBe(4000);
    });
  });
});
