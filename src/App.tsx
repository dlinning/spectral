import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Gauge,
  Mic,
  MicOff,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import {
  AppTab,
  FftSizeOption,
} from './types/preferences';
import { usePreferences } from './hooks/usePreferences';
import { AudioDeviceInfo, AudioEngine, AudioSourceKind } from './audio/AudioEngine';
import { SpectrographBuffer } from './audio/SpectrographBuffer';
import { dspBridge } from './wasm/dspBridge';
import { timeConstantMsToAlpha } from './utils/music';
import { SpectrumAnalyzerView } from './components/SpectrumAnalyzerView';
import { SpectrographView } from './components/SpectrographView';
import { MusicalTunerView } from './components/MusicalTunerView';

const FFT_OPTIONS: FftSizeOption[] = [2048, 4096, 8192, 16384];

export const App: React.FC = () => {
  const { preferences, updatePreferences, resetPreferences } = usePreferences();

  const audioEngineRef = useRef<AudioEngine | null>(null);
  if (!audioEngineRef.current) {
    audioEngineRef.current = new AudioEngine();
  }
  const audioEngine = audioEngineRef.current;

  const spectrographBufferRef = useRef<SpectrographBuffer | null>(null);
  if (!spectrographBufferRef.current) {
    spectrographBufferRef.current = new SpectrographBuffer(
      3600,
      preferences.audio.fftSize / 2,
      48000,
      60
    );
  }
  const spectrographBuffer = spectrographBufferRef.current;

  const [sourceKind, setSourceKind] = useState<AudioSourceKind>('none');
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [analyzerPaused, setAnalyzerPaused] = useState<boolean>(false);
  const [spectrographPaused, setSpectrographPaused] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [frameTick, setFrameTick] = useState<number>(0);
  const isRequestingMicRef = useRef<boolean>(false);

  const latestBinsRef = useRef<Float32Array>(
    new Float32Array(preferences.audio.fftSize / 2).fill(-110)
  );
  const spectroSmoothedRef = useRef<Float32Array>(
    new Float32Array(preferences.audio.fftSize / 2).fill(-110)
  );
  const latestTimeDomainRef = useRef<Float32Array>(
    new Float32Array(preferences.audio.fftSize)
  );

  // Initialize WASM DSP kernel
  useEffect(() => {
    void dspBridge.init('./wasm/spectral_dsp.wasm');
    return () => {
      audioEngine.dispose();
    };
  }, [audioEngine]);

  // Keep AudioEngine and buffers synced to FFT size preference
  useEffect(() => {
    const fftSize = preferences.audio.fftSize;
    audioEngine.setFftSize(fftSize);
    const numBins = fftSize / 2;
    if (latestBinsRef.current.length !== numBins) {
      latestBinsRef.current = new Float32Array(numBins).fill(-110);
      spectroSmoothedRef.current = new Float32Array(numBins).fill(-110);
    }
    if (latestTimeDomainRef.current.length !== fftSize) {
      latestTimeDomainRef.current = new Float32Array(fftSize);
    }
    spectrographBuffer.configure(numBins, sampleRate);
  }, [preferences.audio.fftSize, audioEngine, spectrographBuffer, sampleRate]);

  // Continuous 60fps audio polling loop feeding Spectrum, Spectrograph 60s Ring Buffer, and Tuner
  useEffect(() => {
    if (sourceKind === 'none') return;
    let rafId = 0;
    let lastNowMs = performance.now();

    const tick = (nowMs: number) => {
      const dtMs = nowMs - lastNowMs;
      lastNowMs = nowMs;

      const hasFreq = audioEngine.getFrequencyData(latestBinsRef.current);
      audioEngine.getTimeDomainData(latestTimeDomainRef.current);

      if (hasFreq) {
        if (!spectrographPaused) {
          const alpha = timeConstantMsToAlpha(
            preferences.spectrograph.timeSmoothingMs,
            dtMs
          );
          dspBridge.applyTimeSmoothing(
            latestBinsRef.current,
            spectroSmoothedRef.current,
            alpha
          );
          spectrographBuffer.pushFrame(spectroSmoothedRef.current, nowMs);
        }
        setFrameTick((t) => (t + 1) & 0x7fffffff);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    sourceKind,
    audioEngine,
    spectrographBuffer,
    spectrographPaused,
    preferences.spectrograph.timeSmoothingMs,
  ]);

  const handleStartMic = useCallback(async () => {
    setErrorMsg(null);
    isRequestingMicRef.current = true;
    try {
      await audioEngine.startMicrophone(preferences.audio.inputDeviceId);
      const sr = audioEngine.getSampleRate();
      setSampleRate(sr);
      spectrographBuffer.configure(preferences.audio.fftSize / 2, sr);
      setSourceKind('mic');
      const list = await audioEngine.listInputDevices();
      setDevices(list);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Unable to access microphone.'
      );
      setSourceKind('none');
    } finally {
      isRequestingMicRef.current = false;
    }
  }, [audioEngine, preferences.audio.inputDeviceId, preferences.audio.fftSize, spectrographBuffer]);

  const handleStopAudio = useCallback(() => {
    audioEngine.stopSource();
    setSourceKind('none');
  }, [audioEngine]);

  // Stop recording & audio playback whenever browser loses focus or is hidden
  useEffect(() => {
    const stopOnFocusLoss = () => {
      if (isRequestingMicRef.current) return;
      if (audioEngine.getSourceKind() !== 'none') {
        audioEngine.stopSource();
        setSourceKind('none');
      }
      audioEngine.stopReferenceTone();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopOnFocusLoss();
      }
    };

    window.addEventListener('blur', stopOnFocusLoss);
    window.addEventListener('pagehide', stopOnFocusLoss);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', stopOnFocusLoss);
      window.removeEventListener('pagehide', stopOnFocusLoss);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [audioEngine]);

  // Space key pauses/resumes Spectrum Analyzer or Spectrograph on desktop
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      if (preferences.activeTab === 'analyzer' && sourceKind !== 'none') {
        e.preventDefault();
        setAnalyzerPaused((p) => !p);
      } else if (
        preferences.activeTab === 'spectrograph' &&
        (sourceKind !== 'none' || spectrographBuffer.getFrameCount() > 0)
      ) {
        e.preventDefault();
        setSpectrographPaused((p) => !p);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [preferences.activeTab, sourceKind, spectrographBuffer]);

  const setActiveTab = (tab: AppTab) => {
    updatePreferences((prev) => ({ ...prev, activeTab: tab }));
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-group">
          <img src="./logo/icon.svg" alt="Spectral Logo" className="brand-icon" />
          <div className="brand-text">
            <span className="brand-title">Spectral</span>
          </div>
        </div>

        <nav className="top-tabs" role="tablist" aria-label="Primary Views">
          <button
            type="button"
            role="tab"
            aria-selected={preferences.activeTab === 'analyzer'}
            className={`tab-btn ${preferences.activeTab === 'analyzer' ? 'active' : ''}`}
            onClick={() => setActiveTab('analyzer')}
          >
            <BarChart3 size={15} />
            <span>Spectrum Analyzer</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preferences.activeTab === 'spectrograph'}
            className={`tab-btn ${preferences.activeTab === 'spectrograph' ? 'active' : ''}`}
            onClick={() => setActiveTab('spectrograph')}
          >
            <Activity size={15} />
            <span>Spectrograph</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preferences.activeTab === 'tuner'}
            className={`tab-btn ${preferences.activeTab === 'tuner' ? 'active' : ''}`}
            onClick={() => setActiveTab('tuner')}
          >
            <Gauge size={15} />
            <span>Tuner</span>
          </button>
        </nav>

        <div className="audio-controls-bar">
          {sourceKind === 'mic' ? (
            <button type="button" className="btn btn-active-mic" onClick={handleStopAudio}>
              <MicOff size={14} />
              <span className="desktop-only-label">Stop Mic</span>
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void handleStartMic()}>
              <Mic size={14} />
              <span className="desktop-only-label">Mic</span>
            </button>
          )}

          <div className="audio-settings-wrapper">
            <button
              type="button"
              className="btn btn-icon-only"
              aria-label="Audio & App Settings"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <Settings2 size={15} />
            </button>

            {settingsOpen && (
              <div className="popover-panel" role="dialog" aria-label="Audio Settings">
                <div className="popover-row">
                  <label htmlFor="fft-size-select">FFT Resolution</label>
                  <select
                    id="fft-size-select"
                    className="select-compact"
                    value={preferences.audio.fftSize}
                    onChange={(e) =>
                      updatePreferences((prev) => ({
                        ...prev,
                        audio: {
                          ...prev.audio,
                          fftSize: Number(e.target.value) as FftSizeOption,
                        },
                      }))
                    }
                  >
                    {FFT_OPTIONS.map((sz) => (
                      <option key={sz} value={sz}>
                        {sz} pts ({(sampleRate / sz).toFixed(1)} Hz/bin)
                      </option>
                    ))}
                  </select>
                </div>

                {devices.length > 0 && (
                  <div className="popover-row">
                    <label htmlFor="mic-device-select">Input Device</label>
                    <select
                      id="mic-device-select"
                      className="select-compact"
                      value={preferences.audio.inputDeviceId}
                      onChange={(e) => {
                        const inputDeviceId = e.target.value;
                        updatePreferences((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, inputDeviceId },
                        }));
                        if (sourceKind === 'mic') {
                          void audioEngine.startMicrophone(inputDeviceId);
                        }
                      }}
                    >
                      <option value="default">System Default</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      resetPreferences();
                      setSettingsOpen(false);
                    }}
                  >
                    <RotateCcw size={13} /> Reset All Prefs
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setSettingsOpen(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {errorMsg && (
        <div className="error-banner" role="alert">
          <span>{errorMsg}</span>
          <button type="button" className="btn" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="app-main">
        {preferences.activeTab === 'analyzer' && (
          <SpectrumAnalyzerView
            prefs={preferences.analyzer}
            fftSize={preferences.audio.fftSize}
            sampleRate={sampleRate}
            isAudioActive={sourceKind !== 'none'}
            isPaused={analyzerPaused}
            latestBinsRef={latestBinsRef}
            frameTick={frameTick}
            onTogglePause={() => setAnalyzerPaused((p) => !p)}
            onUpdatePrefs={(patch) =>
              updatePreferences((prev) => ({
                ...prev,
                analyzer: { ...prev.analyzer, ...patch },
              }))
            }
            onStartMic={() => void handleStartMic()}
          />
        )}

        {preferences.activeTab === 'spectrograph' && (
          <SpectrographView
            prefs={preferences.spectrograph}
            buffer={spectrographBuffer}
            fftSize={preferences.audio.fftSize}
            sampleRate={sampleRate}
            isAudioActive={sourceKind !== 'none'}
            isPaused={spectrographPaused}
            frameTick={frameTick}
            onTogglePause={() => setSpectrographPaused((p) => !p)}
            onUpdatePrefs={(patch) =>
              updatePreferences((prev) => ({
                ...prev,
                spectrograph: { ...prev.spectrograph, ...patch },
              }))
            }
            onClearBuffer={() => {
              spectrographBuffer.clear();
              setFrameTick((t) => (t + 1) & 0x7fffffff);
            }}
            onStartMic={() => void handleStartMic()}
          />
        )}

        {preferences.activeTab === 'tuner' && (
          <MusicalTunerView
            prefs={preferences.tuner}
            audioEngine={audioEngine}
            sampleRate={sampleRate}
            isAudioActive={sourceKind !== 'none'}
            latestTimeDomainRef={latestTimeDomainRef}
            frameTick={frameTick}
            onUpdatePrefs={(patch) =>
              updatePreferences((prev) => ({
                ...prev,
                tuner: { ...prev.tuner, ...patch },
              }))
            }
            onStartMic={() => void handleStartMic()}
          />
        )}
      </main>
    </div>
  );
};

export default App;
