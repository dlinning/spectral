import { Volume2, VolumeX } from "lucide-react";
import React, { useEffect } from "react";
import { SegmentedControl, SegmentedOption } from "~/components/controls/SegmentedControl";
import { useAudio } from "~/contexts/AudioContext";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import {
	NOTE_NAMES,
	TONE_MAX_FREQ_HZ,
	TONE_MIN_FREQ_HZ,
	clampToneFrequency,
	formatFrequency,
	freqToNorm,
	frequencyToNoteInfo,
	normToFreq,
	selectToneNoteInOctave,
} from "~/utils/music";

const WAVEFORM_OPTIONS: readonly SegmentedOption<"sine" | "triangle">[] = [
	{ value: "sine", label: "Sine" },
	{ value: "triangle", label: "Tri" },
];

const TONE_SLIDER_STEPS = 2000;

function freqToSliderPos(freqHz: number): number {
	const norm = freqToNorm(clampToneFrequency(freqHz), TONE_MIN_FREQ_HZ, TONE_MAX_FREQ_HZ, "log");
	return Math.round(Math.max(0, Math.min(1, norm)) * TONE_SLIDER_STEPS);
}

function sliderPosToFreq(pos: number): number {
	if (pos <= 0) return TONE_MIN_FREQ_HZ;
	if (pos >= TONE_SLIDER_STEPS) return TONE_MAX_FREQ_HZ;
	const raw = normToFreq(pos / TONE_SLIDER_STEPS, TONE_MIN_FREQ_HZ, TONE_MAX_FREQ_HZ, "log");
	return clampToneFrequency(Math.round(raw * 10) / 10);
}

export const ToneGeneratorCard: React.FC = () => {
	const { preferences, updateTunerPrefs } = usePreferencesContext();
	const { isTonePlaying, startReferenceTone, updateReferenceTone, stopReferenceTone } = useAudio();
	const prefs = preferences.tuner;

	const targetToneFreq = clampToneFrequency(prefs.toneGenFreqHz);
	const noteInfo = frequencyToNoteInfo(targetToneFreq, prefs.referenceA4);
	const selectedOctave = noteInfo ? noteInfo.octave : 4;
	const selectedNoteIdx = noteInfo ? ((noteInfo.midi % 12) + 12) % 12 : 9;
	const isOnNote = noteInfo ? Math.abs(noteInfo.cents) < 0.5 : false;
	const canOctaveDown = targetToneFreq / 2 >= TONE_MIN_FREQ_HZ;
	const canOctaveUp = targetToneFreq * 2 <= TONE_MAX_FREQ_HZ;

	const updateToneFrequency = (nextFreq: number) => {
		const clamped = clampToneFrequency(nextFreq);
		const nextNote = frequencyToNoteInfo(clamped, prefs.referenceA4);
		updateTunerPrefs({
			toneGenFreqHz: clamped,
			...(nextNote ? { toneGenNoteIndex: nextNote.midi } : {}),
		});
	};

	// Keep reference tone parameters synced while playing
	useEffect(() => {
		if (isTonePlaying) {
			updateReferenceTone(targetToneFreq, prefs.toneGenWaveform, prefs.toneGenVolume);
		}
	}, [isTonePlaying, targetToneFreq, prefs.toneGenWaveform, prefs.toneGenVolume, updateReferenceTone]);

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

	const centsRounded = noteInfo ? Math.round(noteInfo.cents) : 0;
	const frequencyLabel = formatFrequency(targetToneFreq, false, targetToneFreq <= 1000 ? 1 : 2);
	const headerReadout = noteInfo
		? isOnNote
			? `${noteInfo.label} (${frequencyLabel})`
			: `~${noteInfo.label} (${centsRounded >= 0 ? "+" : ""}${centsRounded}¢) · ${frequencyLabel}`
		: `${frequencyLabel}`;

	return (
		<div className="tuner-card">
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
				<span className="control-label">Reference Tone Generator</span>
				<span className="mono-val" style={{ color: "var(--accent-cyan)", textAlign: "right" }}>
					{headerReadout}
				</span>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<span className="control-label">Freq</span>
				<input
					type="range"
					aria-label="Reference Tone Frequency"
					aria-valuetext={`${targetToneFreq.toFixed(1)} Hz`}
					className="range-slider"
					style={{ flex: 1 }}
					min={0}
					max={TONE_SLIDER_STEPS}
					step={1}
					value={freqToSliderPos(targetToneFreq)}
					onChange={e => updateToneFrequency(sliderPosToFreq(Number(e.target.value)))}
				/>
				<span className="mono-val" style={{ minWidth: 64, textAlign: "right" }}>
					{formatFrequency(targetToneFreq)}
				</span>
			</div>

			<div className="note-grid">
				{NOTE_NAMES.map((name, idx) => (
					<button
						key={name}
						type="button"
						className={`note-chip ${selectedNoteIdx === idx ? "active" : ""}`}
						onClick={() => updateToneFrequency(selectToneNoteInOctave(idx, selectedOctave, prefs.referenceA4))}>
						{name}
					</button>
				))}
			</div>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					flexWrap: "wrap",
				}}>
				<div className="control-group">
					<span className="control-label">Oct</span>
					<button
						type="button"
						className="btn"
						disabled={!canOctaveDown}
						style={{
							opacity: canOctaveDown ? 1 : 0.4,
							cursor: canOctaveDown ? "pointer" : "default",
						}}
						onClick={() => updateToneFrequency(targetToneFreq / 2)}>
						-
					</button>
					<span className="mono-val" style={{ textAlign: "center", minWidth: 20 }}>
						{selectedOctave}
					</span>
					<button
						type="button"
						className="btn"
						disabled={!canOctaveUp}
						style={{ opacity: canOctaveUp ? 1 : 0.4, cursor: canOctaveUp ? "pointer" : "default" }}
						onClick={() => updateToneFrequency(targetToneFreq * 2)}>
						+
					</button>
				</div>

				<SegmentedControl
					ariaLabel="Tone Waveform"
					options={WAVEFORM_OPTIONS}
					value={prefs.toneGenWaveform}
					onChange={toneGenWaveform => updateTunerPrefs({ toneGenWaveform })}
				/>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
					onChange={e => updateTunerPrefs({ toneGenVolume: Number(e.target.value) })}
				/>
				<button
					type="button"
					className={`btn ${isTonePlaying ? "btn-active-demo" : "btn-primary"}`}
					onClick={() => void toggleReferenceTone()}>
					{isTonePlaying ? (
						<>
							<VolumeX size={15} /> Stop Tone
						</>
					) : (
						<>
							<Volume2 size={15} /> Play {isOnNote && noteInfo ? noteInfo.label : formatFrequency(targetToneFreq)}
						</>
					)}
				</button>
			</div>
		</div>
	);
};
