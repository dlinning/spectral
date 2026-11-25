import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../audio/AudioEngine';
import { AnalyzerControls } from '../components/analyzer/AnalyzerControls';
import { SpectrumAnalyzerView } from '../components/analyzer/SpectrumAnalyzerView';
import { FrequencyZoomControls } from '../components/controls/FrequencyZoomControls';
import { SpectrographControls } from '../components/spectrograph/SpectrographControls';
import { ToneGeneratorCard } from '../components/tuner/ToneGeneratorCard';
import { MusicalTunerView } from '../components/tuner/MusicalTunerView';
import { AudioProvider, useAudio } from '../contexts/AudioContext';
import { PreferencesProvider } from '../contexts/PreferencesContext';
import {
  PREFERENCES_STORAGE_KEY,
  mergePreferences,
  savePreferences,
} from '../hooks/usePreferences';
import { DEFAULT_PREFERENCES } from '../types/preferences';
import {
  TONE_MAX_FREQ_HZ,
  TONE_MIN_FREQ_HZ,
  clampFreqRange,
  clampToneFrequency,
  midiToFrequency,
  panFreqRange,
  selectToneNoteInOctave,
  zoomFreqRange,
} from '../utils/music';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function setRangeValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  nativeSetter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Tuner Defaults, Tone Frequency Slider & Focus-Loss Behavior', () => {
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('defaults Tuner viewMode to "needle" with strobe disabled', () => {
    expect(DEFAULT_PREFERENCES.tuner.viewMode).toBe('needle');

    render(
      <PreferencesProvider>
        <AudioProvider>
          <MusicalTunerView />
        </AudioProvider>
      </PreferencesProvider>
    );

    expect(container.querySelector('[aria-label="Cents Needle Meter"]')).not.toBeNull();
    expect(container.querySelector('.strobe-strip')).toBeNull();

    const needleBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Needle'
    );
    const strobeBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Strobe'
    );
    expect(needleBtn?.classList.contains('active')).toBe(true);
    expect(strobeBtn?.classList.contains('active')).toBe(false);

    act(() => {
      strobeBtn?.click();
    });
    expect(container.querySelector('.strobe-strip')).not.toBeNull();
    expect(container.querySelector('[aria-label="Cents Needle Meter"]')).toBeNull();
  });

  it('keeps microphone recording active on focus loss while stopping the tuning tone', async () => {
    let sourceKind: 'none' | 'mic' = 'none';
    const startMicSpy = vi
      .spyOn(AudioEngine.prototype, 'startMicrophone')
      .mockImplementation(async () => {
        sourceKind = 'mic';
      });
    vi.spyOn(AudioEngine.prototype, 'getSourceKind').mockImplementation(() => sourceKind);
    vi.spyOn(AudioEngine.prototype, 'getSampleRate').mockReturnValue(48000);
    vi.spyOn(AudioEngine.prototype, 'listInputDevices').mockResolvedValue([]);
    vi.spyOn(AudioEngine.prototype, 'getFrequencyData').mockReturnValue(false);
    vi.spyOn(AudioEngine.prototype, 'getTimeDomainData').mockReturnValue(false);
    const stopSourceSpy = vi.spyOn(AudioEngine.prototype, 'stopSource').mockImplementation(() => {
      sourceKind = 'none';
    });
    const startToneSpy = vi.spyOn(AudioEngine.prototype, 'startReferenceTone').mockResolvedValue();
    const stopToneSpy = vi
      .spyOn(AudioEngine.prototype, 'stopReferenceTone')
      .mockImplementation(() => {});

    let latestCtx: ReturnType<typeof useAudio> | null = null;
    const Harness = () => {
      latestCtx = useAudio();
      return null;
    };

    render(
      <PreferencesProvider>
        <AudioProvider>
          <Harness />
        </AudioProvider>
      </PreferencesProvider>
    );

    await act(async () => {
      await latestCtx!.startMicrophone();
      await latestCtx!.startReferenceTone(440, 'sine', 0.2);
    });

    expect(startMicSpy).toHaveBeenCalledTimes(1);
    expect(startToneSpy).toHaveBeenCalledTimes(1);
    expect(latestCtx!.isAudioActive).toBe(true);
    expect(latestCtx!.isTonePlaying).toBe(true);

    // 1. Window blur stops tone, keeps mic recording
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(latestCtx!.isTonePlaying).toBe(false);
    expect(latestCtx!.isAudioActive).toBe(true);
    expect(stopToneSpy).toHaveBeenCalledTimes(1);
    expect(stopSourceSpy).not.toHaveBeenCalled();

    // 2. Visibility hidden stops tone, keeps mic recording
    await act(async () => {
      await latestCtx!.startReferenceTone(440, 'sine', 0.2);
    });
    expect(latestCtx!.isTonePlaying).toBe(true);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(latestCtx!.isTonePlaying).toBe(false);
    expect(latestCtx!.isAudioActive).toBe(true);
    expect(stopToneSpy).toHaveBeenCalledTimes(2);
    expect(stopSourceSpy).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    // 3. Pagehide stops tone, keeps mic recording
    await act(async () => {
      await latestCtx!.startReferenceTone(440, 'sine', 0.2);
    });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(latestCtx!.isTonePlaying).toBe(false);
    expect(latestCtx!.isAudioActive).toBe(true);
    expect(stopToneSpy).toHaveBeenCalledTimes(3);
    expect(stopSourceSpy).not.toHaveBeenCalled();
  });

  it('controls tuner tone via 20 Hz to 5 kHz slider while preserving key and octave shortcuts', async () => {
    const startToneSpy = vi.spyOn(AudioEngine.prototype, 'startReferenceTone').mockResolvedValue();
    vi.spyOn(AudioEngine.prototype, 'stopReferenceTone').mockImplementation(() => {});

    render(
      <PreferencesProvider>
        <AudioProvider>
          <ToneGeneratorCard />
        </AudioProvider>
      </PreferencesProvider>
    );

    const slider = container.querySelector<HTMLInputElement>(
      'input[aria-label="Reference Tone Frequency"]'
    );
    expect(slider).not.toBeNull();
    expect(container.textContent).toContain('A4 (440.0 Hz)');

    // Slide to minimum (20 Hz)
    setRangeValue(slider!, slider!.min);
    expect(container.textContent).toContain('20.0 Hz');

    // Slide to maximum (5000 Hz)
    setRangeValue(slider!, slider!.max);
    expect(container.textContent).toContain('5000.0 Hz');

    // Key shortcut: click C in current octave, then switch to A4
    const cBtn = Array.from(container.querySelectorAll('button.note-chip')).find(
      (b) => b.textContent?.trim() === 'C'
    );
    expect(cBtn).not.toBeUndefined();
    act(() => {
      cBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // From 5000 Hz (octave 8), C8 is 4186.0 Hz
    expect(container.textContent).toContain('C8 (4186.0 Hz)');

    // Octave - shortcut steps down to C7 (2093.0 Hz)
    const octDownBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '-'
    );
    act(() => {
      octDownBtn!.click();
    });
    expect(container.textContent).toContain('C7 (2093.0 Hz)');

    // Octave + shortcut steps back up to C8 (4186.0 Hz), then disables + since C9 > 5000 Hz
    const octUpBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '+'
    );
    act(() => {
      octUpBtn!.click();
    });
    expect(container.textContent).toContain('C8 (4186.0 Hz)');
    expect(octUpBtn!.disabled).toBe(true);

    // Play tone uses current frequency
    const playBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Play')
    );
    await act(async () => {
      playBtn!.click();
    });
    expect(startToneSpy).toHaveBeenCalledWith(
      expect.closeTo(midiToFrequency(108, 440), 1),
      'sine',
      0.2
    );
  });

  it('clamps tone frequencies to [20, 5000] and migrates legacy note-only preferences', () => {
    expect(clampToneFrequency(5)).toBe(TONE_MIN_FREQ_HZ);
    expect(clampToneFrequency(10000)).toBe(TONE_MAX_FREQ_HZ);
    expect(selectToneNoteInOctave(0, 0, 440)).toBeCloseTo(midiToFrequency(24, 440), 3); // C0 -> C1 (>= 20 Hz)
    expect(selectToneNoteInOctave(4, 8, 440)).toBeCloseTo(midiToFrequency(100, 440), 3); // E8 -> E7 (<= 5000 Hz)

    const migrated = mergePreferences({
      tuner: {
        toneGenNoteIndex: 60, // C4
      },
    });
    expect(migrated.tuner.toneGenFreqHz).toBeCloseTo(midiToFrequency(60, 440), 3);
    expect(migrated.tuner.viewMode).toBe('needle');
  });

  it('requires 2 fingers to scroll/pan on Spectrum Analyzer touch while 1 finger moves cursor', () => {
    class MockResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const zoomedPrefs = structuredClone(DEFAULT_PREFERENCES);
    zoomedPrefs.analyzer.minFreq = 200;
    zoomedPrefs.analyzer.maxFreq = 2000;
    savePreferences(zoomedPrefs);

    render(
      <PreferencesProvider>
        <AudioProvider>
          <SpectrumAnalyzerView />
        </AudioProvider>
      </PreferencesProvider>
    );

    const canvas = container.querySelector('canvas.viz-canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 420,
      width: 800,
      height: 420,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const dispatchTouch = (type: string, touches: Array<{ clientX: number; clientY: number }>) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'touches', { value: touches });
      act(() => {
        canvas.dispatchEvent(evt);
      });
    };

    // Single-finger touch moves cursor but does not scroll/pan frequency range
    dispatchTouch('touchstart', [{ clientX: 250, clientY: 150 }]);
    dispatchTouch('touchmove', [{ clientX: 450, clientY: 150 }]);
    dispatchTouch('touchend', []);

    const storedAfterOneFinger = JSON.parse(
      window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}'
    );
    expect(storedAfterOneFinger.analyzer.minFreq).toBe(200);
    expect(storedAfterOneFinger.analyzer.maxFreq).toBe(2000);
    expect(container.textContent).toContain('200 Hz – 2.00 kHz');
    expect(container.textContent).toContain('dB');

    // Two-finger horizontal drag (same finger spacing) pans/scrolls the zoomed range
    dispatchTouch('touchstart', [
      { clientX: 300, clientY: 150 },
      { clientX: 400, clientY: 150 },
    ]);
    dispatchTouch('touchmove', [
      { clientX: 400, clientY: 150 },
      { clientX: 500, clientY: 150 },
    ]);
    dispatchTouch('touchend', []);

    const storedAfterTwoFingers = JSON.parse(
      window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}'
    );
    expect(storedAfterTwoFingers.analyzer.minFreq).toBeLessThan(200);
    expect(storedAfterTwoFingers.analyzer.maxFreq).toBeLessThan(2000);

    vi.unstubAllGlobals();
  });

  it('uses logarithmic mapping on FrequencyZoomControls regardless of Scale so lower frequencies are easy to select', () => {
    const onRangeChange = vi.fn();

    render(
      <FrequencyZoomControls
        minFreq={20}
        maxFreq={10000}
        nyquist={24000}
        freqScale="linear"
        onRangeChange={onRangeChange}
        onScaleChange={() => {}}
      />
    );

    const minSlider = container.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum Frequency Hz"]'
    );
    expect(minSlider).not.toBeNull();

    // Moving min slider to 50% of its travel should land near geometric midpoint (~632 Hz for 20..20k), not linear 10000 Hz
    const midStep = Math.round(Number(minSlider!.max) / 2);
    setRangeValue(minSlider!, String(midStep));
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    const [nextMin, nextMax] = onRangeChange.mock.calls[0];
    expect(nextMin).toBeGreaterThan(500);
    expect(nextMin).toBeLessThan(800);
    expect(nextMax).toBe(10000);

    // Moving max slider to maximum must cap at 20000 Hz, not 24000 Hz
    const maxSlider = container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum Frequency Hz"]'
    );
    expect(maxSlider).not.toBeNull();
    setRangeValue(maxSlider!, maxSlider!.max);
    const [, clampedMax] = onRangeChange.mock.calls[1];
    expect(clampedMax).toBe(20000);
  });

  it('clamps frequency ranges everywhere to 20 kHz instead of 24 kHz', () => {
    expect(clampFreqRange(20, 24000, 24000)).toEqual([20, 20000]);
    expect(panFreqRange(10000, 20000, 0.5, 24000, 'linear')).toEqual([10000, 20000]);
    const [, zoomedHi] = zoomFreqRange(20, 20000, 1000, 2, 24000, 'log');
    expect(zoomedHi).toBe(20000);

    const migrated = mergePreferences({
      analyzer: { minFreq: 20, maxFreq: 24000 },
      spectrograph: { minFreq: 20, maxFreq: 24000 },
    });
    expect(migrated.analyzer.maxFreq).toBe(20000);
    expect(migrated.spectrograph.maxFreq).toBe(20000);
  });

  it('groups AnalyzerControls into a toggles/buttons row above a range sliders row', () => {
    render(
      <PreferencesProvider>
        <AudioProvider>
          <AnalyzerControls
            controlsOpen={true}
            nyquist={20000}
            onResetPeakHold={() => {}}
            onExportPNG={() => {}}
            onExportCSV={() => {}}
            onExportJSON={() => {}}
          />
        </AudioProvider>
      </PreferencesProvider>
    );

    const dock = container.querySelector('.controls-dock-grouped');
    expect(dock).not.toBeNull();

    const children = Array.from(dock!.children);
    expect(children).toHaveLength(3);

    const [togglesRow, slidersRow, exportGroup] = children;
    expect(togglesRow.classList.contains('controls-row-toggles')).toBe(true);
    expect(togglesRow.querySelector('[aria-label="Octave Smoothing"]')).not.toBeNull();
    expect(togglesRow.querySelector('[aria-label="Spectral Tilt"]')).not.toBeNull();
    expect(togglesRow.querySelector('[aria-label="Frequency Scale"]')).not.toBeNull();
    expect(togglesRow.textContent).toContain('Peak Hold');
    expect(togglesRow.querySelectorAll('input[type="range"]')).toHaveLength(0);

    expect(slidersRow.classList.contains('controls-row-sliders')).toBe(true);
    expect(slidersRow.querySelector('[aria-label="Spectrum Time Smoothing"]')).not.toBeNull();
    expect(slidersRow.querySelector('[aria-label="Frequency Zoom Range Slider"]')).not.toBeNull();
    expect(slidersRow.querySelector('[aria-label="Decibel Range Slider"]')).not.toBeNull();

    // Export is placed after sliders in DOM/mobile flow so it sits at the bottom on mobile
    expect(exportGroup.classList.contains('export-group')).toBe(true);
    expect(exportGroup.textContent).toContain('Export');
  });

  it('places the Clear button to the left of the Pause button in SpectrographControls', () => {
    render(
      <PreferencesProvider>
        <AudioProvider>
          <SpectrographControls
            controlsOpen={true}
            nyquist={20000}
            frameCount={10}
            maxScrollBackSec={5}
            effectiveScrollBack={0}
            onScrollBackChange={() => {}}
            onClearHistory={() => {}}
            onExportPNG={() => {}}
            onExportCSV={() => {}}
            onExportJSON={() => {}}
          />
        </AudioProvider>
      </PreferencesProvider>
    );

    const clearBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Clear')
    );
    const pauseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Pause')
    );
    expect(clearBtn).not.toBeUndefined();
    expect(pauseBtn).not.toBeUndefined();
    expect(clearBtn!.parentElement).toBe(pauseBtn!.parentElement);

    const groupButtons = Array.from(clearBtn!.parentElement!.querySelectorAll('button'));
    expect(groupButtons.indexOf(clearBtn!)).toBeLessThan(groupButtons.indexOf(pauseBtn!));
  });
});
