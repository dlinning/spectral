import { Pause, Play, RotateCcw } from "lucide-react";
import React from "react";
import { DbRangeControls } from "~/components/controls/DbRangeControls";
import { ExportControls } from "~/components/controls/ExportControls";
import { FrequencyRangeSlider, FrequencyScaleControl } from "~/components/controls/FrequencyZoomControls";
import { SegmentedControl, SegmentedOption } from "~/components/controls/SegmentedControl";
import { useAudio } from "~/contexts/AudioContext";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import { OctaveSmoothing, TiltSlope } from "~/types/preferences";

const OCTAVE_OPTIONS: readonly SegmentedOption<OctaveSmoothing>[] = [
	{ value: 0, label: "Off" },
	{ value: 24, label: "1/24" },
	{ value: 12, label: "1/12" },
	{ value: 6, label: "1/6" },
	{ value: 3, label: "1/3" },
	{ value: 2, label: "1/2" },
];

const TILT_OPTIONS: readonly SegmentedOption<TiltSlope>[] = [
	{ value: 0, label: "Flat" },
	{ value: 3, label: "+3dB" },
	{ value: 4.5, label: "+4.5dB" },
];

interface AnalyzerControlsProps {
	controlsOpen: boolean;
	nyquist: number;
	onResetPeakHold: () => void;
	onExportPNG: () => void;
	onExportCSV: () => void;
	onExportJSON: () => void;
}

export const AnalyzerControls: React.FC<AnalyzerControlsProps> = ({
	controlsOpen,
	nyquist,
	onResetPeakHold,
	onExportPNG,
	onExportCSV,
	onExportJSON,
}) => {
	const { preferences, updateAnalyzerPrefs } = usePreferencesContext();
	const { isAudioActive, analyzerPaused, toggleAnalyzerPause } = useAudio();
	const prefs = preferences.analyzer;

	return (
		<div className={`controls-dock controls-dock-grouped ${controlsOpen ? "" : "collapsed"}`}>
			<div className="controls-row controls-row-toggles">
				<div className="control-group">
					<span className="control-label">Octave Smooth</span>
					<SegmentedControl
						ariaLabel="Octave Smoothing"
						options={OCTAVE_OPTIONS}
						value={prefs.octaveSmoothing}
						onChange={octaveSmoothing => updateAnalyzerPrefs({ octaveSmoothing })}
					/>
				</div>

				<div className="control-group">
					<span className="control-label">Slope</span>
					<SegmentedControl
						ariaLabel="Spectral Tilt"
						options={TILT_OPTIONS}
						value={prefs.tiltSlope ?? 0}
						onChange={tiltSlope => updateAnalyzerPrefs({ tiltSlope })}
					/>
				</div>

				<FrequencyScaleControl
					freqScale={prefs.freqScale}
					onScaleChange={freqScale => updateAnalyzerPrefs({ freqScale })}
				/>

				<div className="control-group">
					<button
						type="button"
						className={`btn desktop-only-btn ${analyzerPaused ? "btn-active-mic" : ""}`}
						disabled={!isAudioActive}
						title="Pause / Resume (Space)"
						onClick={toggleAnalyzerPause}>
						{analyzerPaused ? <Play size={13} /> : <Pause size={13} />}
						<span>{analyzerPaused ? "Resume" : "Pause"}</span>
					</button>
					<button
						type="button"
						className={`btn ${prefs.showPeakHold ? "btn-active-demo" : ""}`}
						onClick={() => updateAnalyzerPrefs({ showPeakHold: !prefs.showPeakHold })}>
						Peak Hold
					</button>
					{prefs.showPeakHold && (
						<button
							type="button"
							className="btn btn-icon-only"
							title="Clear Peak Hold"
							aria-label="Clear Peak Hold"
							onClick={onResetPeakHold}>
							<RotateCcw size={13} />
						</button>
					)}
				</div>
			</div>

			<div className="controls-row controls-row-sliders">
				<div className="control-group">
					<span className="control-label">Time Smooth</span>
					<input
						type="range"
						aria-label="Spectrum Time Smoothing"
						className="range-slider"
						min={0}
						max={300}
						step={10}
						value={prefs.timeSmoothingMs}
						onChange={e => updateAnalyzerPrefs({ timeSmoothingMs: Number(e.target.value) })}
					/>
					<span className="mono-val">{prefs.timeSmoothingMs} ms</span>
				</div>

				<FrequencyRangeSlider
					minFreq={prefs.minFreq}
					maxFreq={prefs.maxFreq}
					nyquist={nyquist}
					onRangeChange={(minFreq, maxFreq) => updateAnalyzerPrefs({ minFreq, maxFreq })}
				/>

				<DbRangeControls
					minDb={prefs.minDb}
					maxDb={prefs.maxDb}
					onChange={(minDb, maxDb) => updateAnalyzerPrefs({ minDb, maxDb })}
				/>
			</div>

			<ExportControls onExportPNG={onExportPNG} onExportCSV={onExportCSV} onExportJSON={onExportJSON} />
		</div>
	);
};
