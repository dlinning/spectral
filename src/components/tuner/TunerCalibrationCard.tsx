import { RotateCcw } from "lucide-react";
import React from "react";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import { formatFrequency } from "~/utils/music";

interface TunerCalibrationCardProps {
	clarity: number;
}

export const TunerCalibrationCard: React.FC<TunerCalibrationCardProps> = ({ clarity }) => {
	const { preferences, updateTunerPrefs } = usePreferencesContext();
	const prefs = preferences.tuner;

	return (
		<div className="tuner-card">
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
				<span className="control-label">A4 Calibration</span>
				<button
					type="button"
					className="btn btn-icon-only"
					title="Reset A4 = 440 Hz"
					onClick={() => updateTunerPrefs({ referenceA4: 440 })}>
					<RotateCcw size={13} />
				</button>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<button
					type="button"
					className="btn"
					onClick={() => updateTunerPrefs({ referenceA4: Math.max(415, prefs.referenceA4 - 1) })}>
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
					onChange={e => updateTunerPrefs({ referenceA4: Number(e.target.value) })}
				/>
				<button
					type="button"
					className="btn"
					onClick={() => updateTunerPrefs({ referenceA4: Math.min(466, prefs.referenceA4 + 1) })}>
					+1
				</button>
				<span className="mono-val" style={{ minWidth: 64, textAlign: "right" }}>
					{formatFrequency(prefs.referenceA4)}
				</span>
			</div>

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					fontSize: "0.76rem",
					color: "var(--text-secondary)",
				}}>
				<span>Clarity Gate: {Math.round(prefs.clarityThreshold * 100)}%</span>
				<span>Signal Clarity: {Math.round(clarity * 100)}%</span>
			</div>
			<input
				type="range"
				aria-label="Pitch Clarity Gate"
				className="range-slider"
				style={{ width: "100%" }}
				min={0.5}
				max={0.95}
				step={0.01}
				value={prefs.clarityThreshold}
				onChange={e => updateTunerPrefs({ clarityThreshold: Number(e.target.value) })}
			/>
		</div>
	);
};
