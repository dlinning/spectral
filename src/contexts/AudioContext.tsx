import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AudioDeviceInfo, AudioEngine, AudioSourceKind } from "~/audio/AudioEngine";
import { SpectrogramBuffer } from "~/audio/SpectrogramBuffer";
import { usePreferencesContext } from "~/contexts/PreferencesContext";
import { timeConstantMsToAlpha } from "~/utils/music";
import { dspBridge } from "~/wasm/dspBridge";

export interface SavedDecibelReading {
	id: number;
	db: number;
	timestamp: number;
}

interface AudioContextValue {
	sourceKind: AudioSourceKind;
	isAudioActive: boolean;
	sampleRate: number;
	devices: AudioDeviceInfo[];
	errorMsg: string | null;
	analyzerPaused: boolean;
	spectrogramPaused: boolean;
	isTonePlaying: boolean;
	spectrogramBuffer: SpectrogramBuffer;
	latestBinsRef: React.MutableRefObject<Float32Array>;
	latestTimeDomainRef: React.MutableRefObject<Float32Array>;
	savedDecibelReadings: SavedDecibelReading[];
	saveDecibelReading: (db: number) => void;
	startMicrophone: (deviceIdOverride?: string) => Promise<void>;
	stopAudio: () => void;
	clearError: () => void;
	toggleAnalyzerPause: () => void;
	toggleSpectrogramPause: () => void;
	clearSpectrogramBuffer: () => void;
	startReferenceTone: (freqHz: number, waveform: "sine" | "triangle", volume: number) => Promise<void>;
	updateReferenceTone: (freqHz: number, waveform: "sine" | "triangle", volume: number) => void;
	stopReferenceTone: () => void;
}

const AudioStateContext = createContext<AudioContextValue | null>(null);

// Separate context for 60fps frame ticks so non-canvas UI (e.g. header) does not re-render every frame
const AudioFrameContext = createContext<number>(0);

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { preferences } = usePreferencesContext();
	const { fftSize, inputDeviceId } = preferences.audio;
	const spectroTimeSmoothingMs = preferences.spectrogram.timeSmoothingMs;

	const audioEngineRef = useRef<AudioEngine | null>(null);
	if (!audioEngineRef.current) {
		audioEngineRef.current = new AudioEngine();
	}
	const audioEngine = audioEngineRef.current;

	const spectrogramBufferRef = useRef<SpectrogramBuffer | null>(null);
	if (!spectrogramBufferRef.current) {
		spectrogramBufferRef.current = new SpectrogramBuffer(3600, fftSize / 2, 48000, 60);
	}
	const spectrogramBuffer = spectrogramBufferRef.current;

	const [sourceKind, setSourceKind] = useState<AudioSourceKind>("none");
	const [sampleRate, setSampleRate] = useState<number>(48000);
	const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [analyzerPaused, setAnalyzerPaused] = useState<boolean>(false);
	const [spectrogramPaused, setSpectrogramPaused] = useState<boolean>(false);
	const [isTonePlaying, setIsTonePlaying] = useState<boolean>(false);
	const [frameTick, setFrameTick] = useState<number>(0);
	const [savedDecibelReadings, setSavedDecibelReadings] = useState<SavedDecibelReading[]>([]);
	const nextSavedIdRef = useRef<number>(1);

	const latestBinsRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
	const spectroSmoothedRef = useRef<Float32Array>(new Float32Array(fftSize / 2).fill(-110));
	const latestTimeDomainRef = useRef<Float32Array>(new Float32Array(fftSize));

	// Initialize WASM DSP kernel and clean up audio engine on unmount
	useEffect(() => {
		void dspBridge.init("./wasm/spectral_dsp.wasm");
		return () => {
			audioEngine.dispose();
		};
	}, [audioEngine]);

	// Keep AudioEngine and typed buffers synced to FFT size and sample rate
	useEffect(() => {
		audioEngine.setFftSize(fftSize);
		const numBins = fftSize / 2;
		if (latestBinsRef.current.length !== numBins) {
			latestBinsRef.current = new Float32Array(numBins).fill(-110);
			spectroSmoothedRef.current = new Float32Array(numBins).fill(-110);
		}
		if (latestTimeDomainRef.current.length !== fftSize) {
			latestTimeDomainRef.current = new Float32Array(fftSize);
		}
		spectrogramBuffer.configure(numBins, sampleRate);
	}, [fftSize, audioEngine, spectrogramBuffer, sampleRate]);

	// Continuous 60fps audio polling loop feeding Spectrum, Spectrogram 60s Ring Buffer, and Tuner
	useEffect(() => {
		if (sourceKind === "none") return;
		let rafId = 0;
		let lastNowMs = performance.now();

		const tick = (nowMs: number) => {
			const dtMs = nowMs - lastNowMs;
			lastNowMs = nowMs;

			const hasFreq = audioEngine.getFrequencyData(latestBinsRef.current);
			audioEngine.getTimeDomainData(latestTimeDomainRef.current);

			if (hasFreq) {
				if (!spectrogramPaused) {
					const alpha = timeConstantMsToAlpha(spectroTimeSmoothingMs, dtMs);
					dspBridge.applyTimeSmoothing(latestBinsRef.current, spectroSmoothedRef.current, alpha);
					spectrogramBuffer.pushFrame(spectroSmoothedRef.current, nowMs);
				}
				setFrameTick(t => (t + 1) & 0x7fffffff);
			}
			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [sourceKind, audioEngine, spectrogramBuffer, spectrogramPaused, spectroTimeSmoothingMs]);

	// Stop reference tone playback whenever browser loses focus or is hidden
	useEffect(() => {
		const stopToneOnFocusLoss = () => {
			audioEngine.stopReferenceTone();
			setIsTonePlaying(false);
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				stopToneOnFocusLoss();
			}
		};

		window.addEventListener("blur", stopToneOnFocusLoss);
		window.addEventListener("pagehide", stopToneOnFocusLoss);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.removeEventListener("blur", stopToneOnFocusLoss);
			window.removeEventListener("pagehide", stopToneOnFocusLoss);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [audioEngine]);

	const startMicrophone = useCallback(
		async (deviceIdOverride?: string) => {
			setErrorMsg(null);
			try {
				await audioEngine.startMicrophone(deviceIdOverride ?? inputDeviceId);
				const sr = audioEngine.getSampleRate();
				setSampleRate(sr);
				spectrogramBuffer.configure(fftSize / 2, sr);
				setSourceKind("mic");
				const list = await audioEngine.listInputDevices();
				setDevices(list);
			} catch (err) {
				setErrorMsg(err instanceof Error ? err.message : "Unable to access microphone.");
				setSourceKind("none");
			}
		},
		[audioEngine, inputDeviceId, fftSize, spectrogramBuffer]
	);

	const stopAudio = useCallback(() => {
		audioEngine.stopSource();
		setSourceKind("none");
	}, [audioEngine]);

	const clearError = useCallback(() => setErrorMsg(null), []);
	const toggleAnalyzerPause = useCallback(() => setAnalyzerPaused(p => !p), []);
	const toggleSpectrogramPause = useCallback(() => setSpectrogramPaused(p => !p), []);

	const clearSpectrogramBuffer = useCallback(() => {
		spectrogramBuffer.clear();
		setFrameTick(t => (t + 1) & 0x7fffffff);
	}, [spectrogramBuffer]);

	const startReferenceTone = useCallback(
		async (freqHz: number, waveform: "sine" | "triangle", volume: number) => {
			await audioEngine.startReferenceTone(freqHz, waveform, volume);
			setIsTonePlaying(true);
		},
		[audioEngine]
	);

	const updateReferenceTone = useCallback(
		(freqHz: number, waveform: "sine" | "triangle", volume: number) => {
			audioEngine.updateReferenceTone(freqHz, waveform, volume);
		},
		[audioEngine]
	);

	const stopReferenceTone = useCallback(() => {
		audioEngine.stopReferenceTone();
		setIsTonePlaying(false);
	}, [audioEngine]);

	const saveDecibelReading = useCallback((db: number) => {
		const id = nextSavedIdRef.current++;
		const timestamp = Date.now();
		setSavedDecibelReadings(prev => [{ id, db, timestamp }, ...prev]);
	}, []);

	const value = useMemo<AudioContextValue>(
		() => ({
			sourceKind,
			isAudioActive: sourceKind !== "none",
			sampleRate,
			devices,
			errorMsg,
			analyzerPaused,
			spectrogramPaused,
			isTonePlaying,
			spectrogramBuffer,
			latestBinsRef,
			latestTimeDomainRef,
			savedDecibelReadings,
			saveDecibelReading,
			startMicrophone,
			stopAudio,
			clearError,
			toggleAnalyzerPause,
			toggleSpectrogramPause,
			clearSpectrogramBuffer,
			startReferenceTone,
			updateReferenceTone,
			stopReferenceTone,
		}),
		[
			sourceKind,
			sampleRate,
			devices,
			errorMsg,
			analyzerPaused,
			spectrogramPaused,
			isTonePlaying,
			spectrogramBuffer,
			savedDecibelReadings,
			saveDecibelReading,
			startMicrophone,
			stopAudio,
			clearError,
			toggleAnalyzerPause,
			toggleSpectrogramPause,
			clearSpectrogramBuffer,
			startReferenceTone,
			updateReferenceTone,
			stopReferenceTone,
		]
	);

	return (
		<AudioStateContext.Provider value={value}>
			<AudioFrameContext.Provider value={frameTick}>{children}</AudioFrameContext.Provider>
		</AudioStateContext.Provider>
	);
};

export function useAudio(): AudioContextValue {
	const ctx = useContext(AudioStateContext);
	if (!ctx) {
		throw new Error("useAudio must be used within an AudioProvider");
	}
	return ctx;
}

export function useAudioFrame(): number {
	return useContext(AudioFrameContext);
}
