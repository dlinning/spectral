import React, { useEffect, useRef, useState } from 'react';
import { Mic, Radio, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { MusicalTunerPreferences } from '../types/preferences';
import { dspBridge } from '../wasm/dspBridge';
import {
  NOTE_NAMES,
  frequencyToNoteInfo,
  midiToFrequency,
  midiToNoteLabel,
} from '../utils/music';
import { AudioEngine } from '../audio/AudioEngine';

interface MusicalTunerViewProps {
  prefs: MusicalTunerPreferences;
  audioEngine: AudioEngine;
  sampleRate: number;
  isAudioActive: boolean;
  latestTimeDomainRef: React.MutableRefObject<Float32Array>;
  frameTick: number;
  onUpdatePrefs: (patch: Partial<MusicalTunerPreferences>) => void;
  onStartMic: () => void;
  onStartDemo: () => void;
}

export const MusicalTunerView: React.FC<MusicalTunerViewProps> = ({
  prefs,
  audioEngine,
  sampleRate,
  isAudioActive,
  latestTimeDomainRef,
  frameTick,
  onUpdatePrefs,
  onStartMic,
  onStartDemo,
}) => {
  const [detectedFreq, setDetectedFreq] = useState<number>(-1);
  const [smoothedCents, setSmoothedCents] = useState<number>(0);
  const [clarity, setClarity] = useState<number>(0);
  const [tonePlaying, setTonePlaying] = useState<boolean>(false);

  const strobeCanvasRef = useRef<HTMLCanvasElement>(null);
  const strobePhaseRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(performance.now());
  const holdTimerRef = useRef<number>(0);

  // Stop reference tone if unmounting
  useEffect(() => {
    return () => {
      audioEngine.stopReferenceTone();
    };
  }, [audioEngine]);

  // Run MPM pitch detection whenever audio frames arrive
  useEffect(() => {
    if (!isAudioActive) {
      setDetectedFreq(-1);
      setClarity(0);
      return;
    }
    const td = latestTimeDomainRef.current;
    if (td.length < 256) return;

    const result = dspBridge.detectPitchMPM(td, sampleRate, prefs.clarityThreshold);
    const now = performance.now();

    if (result.frequency > 25 && result.frequency < 4500) {
      holdTimerRef.current = now;
      setDetectedFreq(result.frequency);
      setClarity(result.clarity);

      const note = frequencyToNoteInfo(result.frequency, prefs.referenceA4);
      if (note) {
        setSmoothedCents((prev) => prev * 0.65 + note.cents * 0.35);
      }
    } else if (now - holdTimerRef.current > 700) {
      setDetectedFreq(-1);
      setClarity(result.clarity);
    }
  }, [
    frameTick,
    isAudioActive,
    sampleRate,
    prefs.clarityThreshold,
    prefs.referenceA4,
    latestTimeDomainRef,
  ]);

  // Animate Strobe Display
  useEffect(() => {
    if (prefs.viewMode === 'needle') return;
    let rafId = 0;

    const renderStrobe = (now: number) => {
      const dt = Math.min(0.05, (now - lastFrameTimeRef.current) / 1000);
      lastFrameTimeRef.current = now;

      const canvas = strobeCanvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(100, Math.floor(rect.width * dpr));
        const h = Math.max(24, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const active = detectedFreq > 0;
          const speed = active ? smoothedCents * 7.5 : 0;
          strobePhaseRef.current = (strobePhaseRef.current + speed * dt) % 48;

          ctx.fillStyle = '#070b14';
          ctx.fillRect(0, 0, w, h);

          const period = 48 * dpr;
          const half = period / 2;
          const phase = ((strobePhaseRef.current * dpr) % period + period) % period;
          const inTune = active && Math.abs(smoothedCents) <= 3;

          ctx.fillStyle = !active
            ? 'rgba(100, 116, 139, 0.25)'
            : inTune
            ? '#10b981'
            : smoothedCents > 0
            ? '#f59e0b'
            : '#22d3ee';

          for (let x = -period + phase; x < w + period; x += period) {
            ctx.fillRect(x, 0, half, h);
          }

          // Center reference tick
          ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
          ctx.fillRect(w / 2 - 1 * dpr, 0, 2 * dpr, h);
        }
      }

      rafId = requestAnimationFrame(renderStrobe);
    };

    rafId = requestAnimationFrame(renderStrobe);
    return () => cancelAnimationFrame(rafId);
  }, [detectedFreq, smoothedCents, prefs.viewMode]);

  // Keep reference tone parameters synced while playing
  const targetToneFreq = midiToFrequency(prefs.toneGenNoteIndex, prefs.referenceA4);
  const targetToneLabel = midiToNoteLabel(prefs.toneGenNoteIndex);

  useEffect(() => {
    if (tonePlaying) {
      audioEngine.updateReferenceTone(
        targetToneFreq,
        prefs.toneGenWaveform,
        prefs.toneGenVolume
      );
    }
  }, [
    tonePlaying,
    targetToneFreq,
    prefs.toneGenWaveform,
    prefs.toneGenVolume,
    audioEngine,
  ]);

  const toggleReferenceTone = async () => {
    if (tonePlaying) {
      audioEngine.stopReferenceTone();
      setTonePlaying(false);
    } else {
      await audioEngine.startReferenceTone(
        targetToneFreq,
        prefs.toneGenWaveform,
        prefs.toneGenVolume
      );
      setTonePlaying(true);
    }
  };

  const noteInfo =
    detectedFreq > 0
      ? frequencyToNoteInfo(detectedFreq, prefs.referenceA4)
      : null;

  const clampedCents = Math.max(-50, Math.min(50, smoothedCents));
  const statusClass = !noteInfo
    ? 'idle'
    : Math.abs(noteInfo.cents) <= 3
    ? 'in-tune'
    : noteInfo.cents > 0
    ? 'sharp'
    : 'flat';

  // Needle SVG geometry (-50 to +50 deg)
  const angleDeg = (clampedCents / 50) * 52;
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = 180;
  const cy = 155;
  const radius = 122;
  const tipX = cx + Math.cos(angleRad) * radius;
  const tipY = cy + Math.sin(angleRad) * radius;

  const selectedOctave = targetToneLabel.octave;
  const selectedNoteIdx = ((prefs.toneGenNoteIndex % 12) + 12) % 12;

  return (
    <div className="tuner-view">
      {/* Left/Primary Card: Note Readout + Needle + Strobe */}
      <div className="tuner-card tuner-main-card">
        <div
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span className="control-label">Chromatic Tuner</span>
          <div className="segmented" role="group" aria-label="Tuner Meter View">
            {(['both', 'needle', 'strobe'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`seg-btn ${prefs.viewMode === mode ? 'active' : ''}`}
                onClick={() => onUpdatePrefs({ viewMode: mode })}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="tuner-note-readout">
          <div className={`tuner-note-big ${statusClass}`}>
            {noteInfo ? (
              <>
                <span>{noteInfo.noteName}</span>
                <span className="tuner-octave">{noteInfo.octave}</span>
              </>
            ) : (
              <span>--</span>
            )}
          </div>

          <div className="tuner-metrics-row">
            <span>{noteInfo ? `${detectedFreq.toFixed(2)} Hz` : 'Listening...'}</span>
            <span>•</span>
            <span>
              {noteInfo
                ? `${noteInfo.cents >= 0 ? '+' : ''}${noteInfo.cents.toFixed(1)} ¢`
                : '0.0 ¢'}
            </span>
          </div>

          {noteInfo ? (
            <span className={`tuner-status-pill ${statusClass}`}>
              {statusClass === 'in-tune'
                ? 'In Tune'
                : statusClass === 'sharp'
                ? 'Sharp ♯'
                : 'Flat ♭'}
            </span>
          ) : (
            <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              {isAudioActive
                ? 'Play a note or sing into microphone'
                : 'Start Mic or Demo Signal to tune'}
            </span>
          )}
        </div>

        <div className="tuner-gauge-wrap">
          {prefs.viewMode !== 'strobe' && (
            <svg viewBox="0 0 360 175" className="tuner-needle-svg" aria-label="Cents Needle Meter">
              {/* Outer scale arc */}
              <path
                d="M 48 110 A 136 136 0 0 1 312 110"
                fill="none"
                stroke="rgba(148,163,184,0.22)"
                strokeWidth="10"
                strokeLinecap="round"
              />
              {/* Center green in-tune arc */}
              <path
                d="M 168 20 A 136 136 0 0 1 192 20"
                fill="none"
                stroke="#10b981"
                strokeWidth="10"
                strokeLinecap="round"
              />

              {/* Tick marks */}
              {[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((c) => {
                const a = (((c / 50) * 52 - 90) * Math.PI) / 180;
                const r1 = c % 25 === 0 || c === 0 ? 114 : 120;
                const r2 = 132;
                return (
                  <g key={c}>
                    <line
                      x1={cx + Math.cos(a) * r1}
                      y1={cy + Math.sin(a) * r1}
                      x2={cx + Math.cos(a) * r2}
                      y2={cy + Math.sin(a) * r2}
                      stroke={c === 0 ? '#10b981' : '#64748b'}
                      strokeWidth={c === 0 ? 3 : 1.5}
                    />
                    {c % 25 === 0 && (
                      <text
                        x={cx + Math.cos(a) * 147}
                        y={cy + Math.sin(a) * 147}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#94a3b8"
                        fontSize="10"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {c > 0 ? `+${c}` : c}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Needle */}
              <line
                x1={cx}
                y1={cy}
                x2={noteInfo ? tipX : cx}
                y2={noteInfo ? tipY : cy - radius}
                stroke={
                  !noteInfo
                    ? '#475569'
                    : statusClass === 'in-tune'
                    ? '#10b981'
                    : statusClass === 'sharp'
                    ? '#f59e0b'
                    : '#22d3ee'
                }
                strokeWidth="3.5"
                strokeLinecap="round"
              />
              <circle cx={cx} cy={cy} r="7" fill="#e2e8f0" />
            </svg>
          )}

          {prefs.viewMode !== 'needle' && (
            <div className="strobe-strip" title="Strobe phase indicator (locks still when in tune)">
              <canvas ref={strobeCanvasRef} className="strobe-canvas" />
            </div>
          )}
        </div>

        {!isAudioActive && (
          <div className="empty-overlay-actions">
            <button type="button" className="btn btn-primary" onClick={onStartMic}>
              <Mic size={14} /> Start Mic
            </button>
            <button type="button" className="btn" onClick={onStartDemo}>
              <Radio size={14} /> Demo A4 / Harmonics
            </button>
          </div>
        )}
      </div>

      {/* Right/Secondary Column: A4 Calibration + Target Tone Generator */}
      <div className="tuner-side-stack">
        <div className="tuner-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="control-label">A4 Calibration</span>
            <button
              type="button"
              className="btn btn-icon-only"
              title="Reset A4 = 440 Hz"
              onClick={() => onUpdatePrefs({ referenceA4: 440 })}
            >
              <RotateCcw size={13} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn"
              onClick={() =>
                onUpdatePrefs({ referenceA4: Math.max(415, prefs.referenceA4 - 1) })
              }
            >
              -1
            </button>
            <input
              type="range"
              aria-label="A4 Reference Pitch"
              className="range-slider"
              style={{ flex: 1 }}
              min={415}
              max={466}
              step={1}
              value={prefs.referenceA4}
              onChange={(e) => onUpdatePrefs({ referenceA4: Number(e.target.value) })}
            />
            <button
              type="button"
              className="btn"
              onClick={() =>
                onUpdatePrefs({ referenceA4: Math.min(466, prefs.referenceA4 + 1) })
              }
            >
              +1
            </button>
            <span className="mono-val" style={{ minWidth: 64, textAlign: 'right' }}>
              {prefs.referenceA4} Hz
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            <span>Clarity Gate: {Math.round(prefs.clarityThreshold * 100)}%</span>
            <span>Signal Clarity: {Math.round(clarity * 100)}%</span>
          </div>
          <input
            type="range"
            aria-label="Pitch Clarity Gate"
            className="range-slider"
            style={{ width: '100%' }}
            min={0.5}
            max={0.95}
            step={0.01}
            value={prefs.clarityThreshold}
            onChange={(e) => onUpdatePrefs({ clarityThreshold: Number(e.target.value) })}
          />
        </div>

        <div className="tuner-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="control-label">Reference Tone Generator</span>
            <span className="mono-val" style={{ color: 'var(--accent-cyan)' }}>
              {targetToneLabel.label} ({targetToneFreq.toFixed(1)} Hz)
            </span>
          </div>

          <div className="note-grid">
            {NOTE_NAMES.map((name, idx) => (
              <button
                key={name}
                type="button"
                className={`note-chip ${selectedNoteIdx === idx ? 'active' : ''}`}
                onClick={() =>
                  onUpdatePrefs({ toneGenNoteIndex: (selectedOctave + 1) * 12 + idx })
                }
              >
                {name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div className="control-group">
              <span className="control-label">Oct</span>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  onUpdatePrefs({
                    toneGenNoteIndex: Math.max(24, prefs.toneGenNoteIndex - 12),
                  })
                }
              >
                -
              </button>
              <span className="mono-val" style={{ textAlign: 'center', minWidth: 20 }}>
                {selectedOctave}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  onUpdatePrefs({
                    toneGenNoteIndex: Math.min(96, prefs.toneGenNoteIndex + 12),
                  })
                }
              >
                +
              </button>
            </div>

            <div className="segmented" role="group" aria-label="Tone Waveform">
              {(['sine', 'triangle'] as const).map((wf) => (
                <button
                  key={wf}
                  type="button"
                  className={`seg-btn ${prefs.toneGenWaveform === wf ? 'active' : ''}`}
                  onClick={() => onUpdatePrefs({ toneGenWaveform: wf })}
                >
                  {wf === 'sine' ? 'Sine' : 'Tri'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="control-label">Vol</span>
            <input
              type="range"
              aria-label="Reference Tone Volume"
              className="range-slider"
              style={{ flex: 1 }}
              min={0.05}
              max={0.5}
              step={0.01}
              value={prefs.toneGenVolume}
              onChange={(e) => onUpdatePrefs({ toneGenVolume: Number(e.target.value) })}
            />
            <button
              type="button"
              className={`btn ${tonePlaying ? 'btn-active-demo' : 'btn-primary'}`}
              onClick={() => void toggleReferenceTone()}
            >
              {tonePlaying ? (
                <>
                  <VolumeX size={15} /> Stop Tone
                </>
              ) : (
                <>
                  <Volume2 size={15} /> Play {targetToneLabel.label}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
