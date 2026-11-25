export type AppTab = "analyzer" | "spectrogram" | "tuner" | "decibels";

export type FreqScale = "log" | "linear";

/** 0 = Off, otherwise denominator of 1/N octave smoothing */
export type OctaveSmoothing = 0 | 24 | 12 | 6 | 3 | 2;

export type HistoryDurationSec = 5 | 15 | 30 | 60;

export type ColormapId = "magma" | "viridis" | "inferno" | "plasma" | "grayscale";

export type FftSizeOption = 2048 | 4096 | 8192 | 16384;

export interface AudioPreferences {
	fftSize: FftSizeOption;
	inputDeviceId: string;
	minDecibels: number;
	maxDecibels: number;
}

export type TiltSlope = 0 | 3 | 4.5;

export interface SpectrumAnalyzerPreferences {
	minFreq: number;
	maxFreq: number;
	freqScale: FreqScale;
	timeSmoothingMs: number; // 0 to 1000 ms
	octaveSmoothing: OctaveSmoothing;
	tiltSlope: TiltSlope;
	minDb: number;
	maxDb: number;
	showPeakHold: boolean;
	peakDecayRate: number; // dB per frame
	fillArea: boolean;
	showNoteOverlay: boolean;
}

export interface SpectrogramPreferences {
	minFreq: number;
	maxFreq: number;
	freqScale: FreqScale;
	timeSmoothingMs: number; // 0 to 1000 ms
	historyDurationSec: HistoryDurationSec;
	colormap: ColormapId;
	minDb: number;
	maxDb: number;
}

export interface MusicalTunerPreferences {
	referenceA4: number; // 415 to 466 Hz
	clarityThreshold: number; // 0.5 to 0.95
	viewMode: "both" | "needle" | "strobe";
	toneGenWaveform: "sine" | "triangle";
	toneGenFreqHz: number; // 20 to 5000 Hz (default 440 = A4)
	toneGenNoteIndex: number; // MIDI note (default 69 = A4)
	toneGenVolume: number; // 0.05 to 0.5
}

export interface UserPreferences {
	version: 1;
	activeTab: AppTab;
	audio: AudioPreferences;
	analyzer: SpectrumAnalyzerPreferences;
	spectrogram: SpectrogramPreferences;
	tuner: MusicalTunerPreferences;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
	version: 1,
	activeTab: "analyzer",
	audio: {
		fftSize: 4096,
		inputDeviceId: "default",
		minDecibels: -100,
		maxDecibels: 0,
	},
	analyzer: {
		minFreq: 20,
		maxFreq: 20000,
		freqScale: "log",
		timeSmoothingMs: 60,
		octaveSmoothing: 0,
		tiltSlope: 0,
		minDb: -100,
		maxDb: 0,
		showPeakHold: true,
		peakDecayRate: 0.08,
		fillArea: true,
		showNoteOverlay: true,
	},
	spectrogram: {
		minFreq: 20,
		maxFreq: 20000,
		freqScale: "log",
		timeSmoothingMs: 30,
		historyDurationSec: 30,
		colormap: "magma",
		minDb: -95,
		maxDb: -5,
	},
	tuner: {
		referenceA4: 440,
		clarityThreshold: 0.78,
		viewMode: "needle",
		toneGenWaveform: "sine",
		toneGenFreqHz: 440,
		toneGenNoteIndex: 69,
		toneGenVolume: 0.2,
	},
};
