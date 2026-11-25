import { Mic } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { SegmentedControl, SegmentedOption } from "~/components/controls/SegmentedControl";
import { ToneGeneratorCard } from "~/components/tuner/ToneGeneratorCard";
import { TunerCalibrationCard } from "~/components/tuner/TunerCalibrationCard";
import { TunerNeedle, TunerStatus } from "~/components/tuner/TunerNeedle";
import { TunerStrobe } from "~/components/tuner/TunerStrobe";
import { useAudio, useAudioFrame } from "~/contexts/AudioContext";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import { MusicalTunerPreferences } from "~/types/preferences";
import { frequencyToNoteInfo } from "~/utils/music";
import { dspBridge } from "~/wasm/dspBridge";

const VIEW_MODE_OPTIONS: readonly SegmentedOption<MusicalTunerPreferences["viewMode"]>[] = [
	{ value: "both", label: "Both" },
	{ value: "needle", label: "Needle" },
	{ value: "strobe", label: "Strobe" },
];

export const MusicalTunerView: React.FC = () => {
	const { preferences, updateTunerPrefs } = usePreferencesContext();
	const { sampleRate, isAudioActive, latestTimeDomainRef, startMicrophone } = useAudio();
	const frameTick = useAudioFrame();
	const prefs = preferences.tuner;

	const [detectedFreq, setDetectedFreq] = useState<number>(-1);
	const [smoothedCents, setSmoothedCents] = useState<number>(0);
	const [clarity, setClarity] = useState<number>(0);

	const holdTimerRef = useRef<number>(0);
	const lastDetectMsRef = useRef<number>(0);
	const smoothedFreqRef = useRef<number>(-1);

	// Run MPM pitch detection throttled (~110 ms) with frequency & cents smoothing to prevent flickering
	useEffect(() => {
		if (!isAudioActive) {
			smoothedFreqRef.current = -1;
			setDetectedFreq(-1);
			setClarity(0);
			return;
		}

		const now = performance.now();
		if (now - lastDetectMsRef.current < 110) {
			return;
		}
		lastDetectMsRef.current = now;

		const td = latestTimeDomainRef.current;
		if (td.length < 256) return;

		const result = dspBridge.detectPitchMPM(td, sampleRate, prefs.clarityThreshold);

		if (result.frequency > 25 && result.frequency < 4500) {
			holdTimerRef.current = now;

			// Smooth frequency if tracking the same note (within ~1 semitone), snap on note change
			const prevFreq = smoothedFreqRef.current;
			const sameNote = prevFreq > 0 && Math.abs(Math.log2(result.frequency / prevFreq)) < 0.05;
			const nextFreq = sameNote ? prevFreq * 0.7 + result.frequency * 0.3 : result.frequency;

			smoothedFreqRef.current = nextFreq;
			setDetectedFreq(nextFreq);
			setClarity(result.clarity);

			const note = frequencyToNoteInfo(nextFreq, prefs.referenceA4);
			if (note) {
				setSmoothedCents(prev => (sameNote ? prev * 0.65 + note.cents * 0.35 : note.cents));
			}
		} else if (now - holdTimerRef.current > 1000) {
			smoothedFreqRef.current = -1;
			setDetectedFreq(-1);
			setClarity(result.clarity);
		}
	}, [frameTick, isAudioActive, sampleRate, prefs.clarityThreshold, prefs.referenceA4, latestTimeDomainRef]);

	const noteInfo = detectedFreq > 0 ? frequencyToNoteInfo(detectedFreq, prefs.referenceA4) : null;

	const statusClass: TunerStatus = !noteInfo
		? "idle"
		: Math.abs(smoothedCents) <= 3
			? "in-tune"
			: smoothedCents > 0
				? "sharp"
				: "flat";

	return (
		<div className="tuner-view">
			{/* Left/Primary Card: Note Readout + Needle + Strobe */}
			<div className="tuner-card tuner-main-card">
				<div
					style={{
						width: "100%",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						gap: 8,
						flexWrap: "wrap",
					}}>
					<span className="control-label">Chromatic Tuner</span>
					<SegmentedControl
						ariaLabel="Tuner Meter View"
						options={VIEW_MODE_OPTIONS}
						value={prefs.viewMode}
						onChange={viewMode => updateTunerPrefs({ viewMode })}
					/>
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
						<span>{noteInfo ? `${detectedFreq.toFixed(1)} Hz` : "Listening..."}</span>
						<span>•</span>
						<span>{noteInfo ? `${smoothedCents >= 0 ? "+" : ""}${smoothedCents.toFixed(1)} ¢` : "0.0 ¢"}</span>
					</div>

					{noteInfo ? (
						<span className={`tuner-status-pill ${statusClass}`}>
							{statusClass === "in-tune" ? "In Tune" : statusClass === "sharp" ? "Sharp ♯" : "Flat ♭"}
						</span>
					) : (
						<span style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
							{isAudioActive ? "Play a note or sing into microphone" : "Enable Mic to tune"}
						</span>
					)}
				</div>

				<div className="tuner-gauge-wrap">
					{prefs.viewMode !== "strobe" && (
						<TunerNeedle cents={smoothedCents} hasNote={Boolean(noteInfo)} status={statusClass} />
					)}
					{prefs.viewMode !== "needle" && <TunerStrobe active={detectedFreq > 0} cents={smoothedCents} />}
				</div>

				{!isAudioActive && (
					<div className="empty-overlay-actions">
						<button type="button" className="btn btn-primary" onClick={() => void startMicrophone()}>
							<Mic size={14} /> Enable Mic
						</button>
					</div>
				)}
			</div>

			{/* Right/Secondary Column: A4 Calibration + Target Tone Generator */}
			<div className="tuner-side-stack">
				<TunerCalibrationCard clarity={clarity} />
				<ToneGeneratorCard />
			</div>
		</div>
	);
};
