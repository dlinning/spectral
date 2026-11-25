import React, { useEffect } from "react";
import { SpectrumAnalyzerView } from "~/components/analyzer/SpectrumAnalyzerView";
import { DecibelsView } from "~/components/decibels/DecibelsView";
import { AppHeader } from "~/components/layout/AppHeader";
import { SpectrogramView } from "~/components/spectrogram/SpectrogramView";
import { MusicalTunerView } from "~/components/tuner/MusicalTunerView";
import { AudioProvider, useAudio } from "~/contexts/AudioContext";
import { PreferencesProvider, usePreferencesContext } from "~/contexts/PreferencesContext";

const AppShell: React.FC = () => {
	const { preferences } = usePreferencesContext();
	const { isAudioActive, spectrogramBuffer, errorMsg, clearError, toggleAnalyzerPause, toggleSpectrogramPause } =
		useAudio();

	// Space key pauses/resumes Spectrum Analyzer or Spectrogram on desktop
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code !== "Space" && e.key !== " ") return;
			if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

			const target = e.target as HTMLElement | null;
			if (target) {
				const tag = target.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
					return;
				}
			}

			if (preferences.activeTab === "analyzer" && isAudioActive) {
				e.preventDefault();
				toggleAnalyzerPause();
			} else if (preferences.activeTab === "spectrogram" && (isAudioActive || spectrogramBuffer.getFrameCount() > 0)) {
				e.preventDefault();
				toggleSpectrogramPause();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [preferences.activeTab, isAudioActive, spectrogramBuffer, toggleAnalyzerPause, toggleSpectrogramPause]);

	return (
		<div className="app-shell">
			<AppHeader />

			{errorMsg && (
				<div className="error-banner" role="alert">
					<span>{errorMsg}</span>
					<button type="button" className="btn" onClick={clearError}>
						Dismiss
					</button>
				</div>
			)}

			<main className="app-main">
				{preferences.activeTab === "analyzer" && <SpectrumAnalyzerView />}
				{preferences.activeTab === "spectrogram" && <SpectrogramView />}
				{preferences.activeTab === "tuner" && <MusicalTunerView />}
				{preferences.activeTab === "decibels" && <DecibelsView />}
			</main>
		</div>
	);
};

export const App: React.FC = () => (
	<PreferencesProvider>
		<AudioProvider>
			<AppShell />
		</AudioProvider>
	</PreferencesProvider>
);

export default App;
