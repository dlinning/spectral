import { RotateCcw } from "lucide-react";
import React from "react";
import { useAudio } from "~/contexts/AudioContext";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import { FftSizeOption } from "~/types/preferences";

const FFT_OPTIONS: readonly FftSizeOption[] = [2048, 4096, 8192, 16384];

interface AudioSettingsPopoverProps {
	onClose: () => void;
}

export const AudioSettingsPopover: React.FC<AudioSettingsPopoverProps> = ({ onClose }) => {
	const { preferences, updateAudioPrefs, resetPreferences } = usePreferencesContext();
	const { sampleRate, devices, sourceKind, startMicrophone } = useAudio();

	return (
		<div className="popover-panel" role="dialog" aria-label="Audio Settings">
			<div className="popover-row">
				<label htmlFor="fft-size-select">FFT Resolution</label>
				<select
					id="fft-size-select"
					className="select-compact"
					value={preferences.audio.fftSize}
					onChange={e => updateAudioPrefs({ fftSize: Number(e.target.value) as FftSizeOption })}>
					{FFT_OPTIONS.map(sz => (
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
						onChange={e => {
							const inputDeviceId = e.target.value;
							updateAudioPrefs({ inputDeviceId });
							if (sourceKind === "mic") {
								void startMicrophone(inputDeviceId);
							}
						}}>
						<option value="default">System Default</option>
						{devices.map(d => (
							<option key={d.deviceId} value={d.deviceId}>
								{d.label}
							</option>
						))}
					</select>
				</div>
			)}

			<div style={{ display: "flex", justifyContent: "space-between", paddingTop: 4 }}>
				<button
					type="button"
					className="btn"
					onClick={() => {
						resetPreferences();
						onClose();
					}}>
					<RotateCcw size={13} /> Reset All Prefs
				</button>
				<button type="button" className="btn btn-primary" onClick={onClose}>
					Done
				</button>
			</div>
		</div>
	);
};
