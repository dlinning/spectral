import React, { useEffect } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useAudio } from '../../contexts/AudioContext';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { NOTE_NAMES, midiToFrequency, midiToNoteLabel } from '../../utils/music';
import { SegmentedControl, SegmentedOption } from '../controls/SegmentedControl';

const WAVEFORM_OPTIONS: readonly SegmentedOption<'sine' | 'triangle'>[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Tri' },
];

export const ToneGeneratorCard: React.FC = () => {
  const { preferences, updateTunerPrefs } = usePreferencesContext();
  const { isTonePlaying, startReferenceTone, updateReferenceTone, stopReferenceTone } = useAudio();
  const prefs = preferences.tuner;

  const targetToneFreq = midiToFrequency(prefs.toneGenNoteIndex, prefs.referenceA4);
  const targetToneLabel = midiToNoteLabel(prefs.toneGenNoteIndex);
  const selectedOctave = targetToneLabel.octave;
  const selectedNoteIdx = ((prefs.toneGenNoteIndex % 12) + 12) % 12;

  // Keep reference tone parameters synced while playing
  useEffect(() => {
    if (isTonePlaying) {
      updateReferenceTone(targetToneFreq, prefs.toneGenWaveform, prefs.toneGenVolume);
    }
  }, [
    isTonePlaying,
    targetToneFreq,
    prefs.toneGenWaveform,
    prefs.toneGenVolume,
    updateReferenceTone,
  ]);

  // Stop reference tone when navigating away from Tuner
  useEffect(() => {
    return () => {
      stopReferenceTone();
    };
  }, [stopReferenceTone]);

  const toggleReferenceTone = async () => {
    if (isTonePlaying) {
      stopReferenceTone();
    } else {
      await startReferenceTone(targetToneFreq, prefs.toneGenWaveform, prefs.toneGenVolume);
    }
  };

  return (
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
            onClick={() => updateTunerPrefs({ toneGenNoteIndex: (selectedOctave + 1) * 12 + idx })}
          >
            {name}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div className="control-group">
          <span className="control-label">Oct</span>
          <button
            type="button"
            className="btn"
            onClick={() =>
              updateTunerPrefs({ toneGenNoteIndex: Math.max(24, prefs.toneGenNoteIndex - 12) })
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
              updateTunerPrefs({ toneGenNoteIndex: Math.min(96, prefs.toneGenNoteIndex + 12) })
            }
          >
            +
          </button>
        </div>

        <SegmentedControl
          ariaLabel="Tone Waveform"
          options={WAVEFORM_OPTIONS}
          value={prefs.toneGenWaveform}
          onChange={(toneGenWaveform) => updateTunerPrefs({ toneGenWaveform })}
        />
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
          onChange={(e) => updateTunerPrefs({ toneGenVolume: Number(e.target.value) })}
        />
        <button
          type="button"
          className={`btn ${isTonePlaying ? 'btn-active-demo' : 'btn-primary'}`}
          onClick={() => void toggleReferenceTone()}
        >
          {isTonePlaying ? (
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
  );
};
