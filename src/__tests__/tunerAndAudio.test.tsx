import React, { act } from "react";
import { Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "~/audio/AudioEngine";
import { SpectrogramBuffer } from "~/audio/SpectrogramBuffer";
import { AnalyzerControls } from "~/components/analyzer/AnalyzerControls";
import { SpectrumAnalyzerView } from "~/components/analyzer/SpectrumAnalyzerView";
import {
	getSpectrumPeakDbInRange,
	getSpectrumPlotBounds,
	renderSpectrumCanvas,
	scaleSpectrumCursor,
} from "~/components/analyzer/spectrumRenderer";
import { FreqAxisZoomBar } from "~/components/controls/FreqAxisZoomBar";
import { FrequencyZoomControls } from "~/components/controls/FrequencyZoomControls";
import { MobileControlsBar } from "~/components/controls/MobileControlsBar";
import { SpectrogramControls } from "~/components/spectrogram/SpectrogramControls";
import { SpectrogramView } from "~/components/spectrogram/SpectrogramView";
import { getSpectrogramPeakDbInRange, renderSpectrogramCanvas } from "~/components/spectrogram/spectrogramRenderer";
import { MusicalTunerView } from "~/components/tuner/MusicalTunerView";
import { ToneGeneratorCard } from "~/components/tuner/ToneGeneratorCard";
import { AudioProvider, useAudio } from "~/contexts/AudioContext";
import { PreferencesProvider } from "~/contexts/PreferencesContext";
import { PREFERENCES_STORAGE_KEY, mergePreferences, savePreferences } from "~/hooks/usePreferences";
import { DEFAULT_PREFERENCES } from "~/types/preferences";
import {
	EXPORT_HEADER_HEIGHT,
	EXPORT_LABEL_FONT_PX,
	MIN_PNG_EXPORT_WIDTH,
	computePaddedExportMaxDb,
	createHighResExportCanvas,
	formatExportTimestamp,
	getPngExportDimensions,
} from "~/utils/exporters";
import {
	TONE_MAX_FREQ_HZ,
	TONE_MIN_FREQ_HZ,
	clampFreqRange,
	clampToneFrequency,
	midiToFrequency,
	panFreqRange,
	selectToneNoteInOctave,
	zoomFreqRange,
} from "~/utils/music";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
	act(() => {
		root.render(ui);
	});
}

function setRangeValue(input: HTMLInputElement, value: string) {
	const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	nativeSetter?.call(input, value);
	act(() => {
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("Tuner Defaults, Tone Frequency Slider & Focus-Loss Behavior", () => {
	beforeEach(() => {
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
	});

	it('defaults Tuner viewMode to "needle" with strobe disabled', () => {
		expect(DEFAULT_PREFERENCES.tuner.viewMode).toBe("needle");

		render(
			<PreferencesProvider>
				<AudioProvider>
					<MusicalTunerView />
				</AudioProvider>
			</PreferencesProvider>
		);

		expect(container.querySelector('[aria-label="Cents Needle Meter"]')).not.toBeNull();
		expect(container.querySelector(".strobe-strip")).toBeNull();

		const needleBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Needle");
		const strobeBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Strobe");
		expect(needleBtn?.classList.contains("active")).toBe(true);
		expect(strobeBtn?.classList.contains("active")).toBe(false);

		act(() => {
			strobeBtn?.click();
		});
		expect(container.querySelector(".strobe-strip")).not.toBeNull();
		expect(container.querySelector('[aria-label="Cents Needle Meter"]')).toBeNull();
	});

	it("keeps microphone recording active on focus loss while stopping the tuning tone", async () => {
		let sourceKind: "none" | "mic" = "none";
		const startMicSpy = vi.spyOn(AudioEngine.prototype, "startMicrophone").mockImplementation(async () => {
			sourceKind = "mic";
		});
		vi.spyOn(AudioEngine.prototype, "getSourceKind").mockImplementation(() => sourceKind);
		vi.spyOn(AudioEngine.prototype, "getSampleRate").mockReturnValue(48000);
		vi.spyOn(AudioEngine.prototype, "listInputDevices").mockResolvedValue([]);
		vi.spyOn(AudioEngine.prototype, "getFrequencyData").mockReturnValue(false);
		vi.spyOn(AudioEngine.prototype, "getTimeDomainData").mockReturnValue(false);
		const stopSourceSpy = vi.spyOn(AudioEngine.prototype, "stopSource").mockImplementation(() => {
			sourceKind = "none";
		});
		const startToneSpy = vi.spyOn(AudioEngine.prototype, "startReferenceTone").mockResolvedValue();
		const stopToneSpy = vi.spyOn(AudioEngine.prototype, "stopReferenceTone").mockImplementation(() => {});

		let latestCtx: ReturnType<typeof useAudio> | null = null;
		const Harness = () => {
			latestCtx = useAudio();
			return null;
		};

		render(
			<PreferencesProvider>
				<AudioProvider>
					<Harness />
				</AudioProvider>
			</PreferencesProvider>
		);

		await act(async () => {
			await latestCtx!.startMicrophone();
			await latestCtx!.startReferenceTone(440, "sine", 0.2);
		});

		expect(startMicSpy).toHaveBeenCalledTimes(1);
		expect(startToneSpy).toHaveBeenCalledTimes(1);
		expect(latestCtx!.isAudioActive).toBe(true);
		expect(latestCtx!.isTonePlaying).toBe(true);

		// 1. Window blur stops tone, keeps mic recording
		act(() => {
			window.dispatchEvent(new Event("blur"));
		});
		expect(latestCtx!.isTonePlaying).toBe(false);
		expect(latestCtx!.isAudioActive).toBe(true);
		expect(stopToneSpy).toHaveBeenCalledTimes(1);
		expect(stopSourceSpy).not.toHaveBeenCalled();

		// 2. Visibility hidden stops tone, keeps mic recording
		await act(async () => {
			await latestCtx!.startReferenceTone(440, "sine", 0.2);
		});
		expect(latestCtx!.isTonePlaying).toBe(true);

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(latestCtx!.isTonePlaying).toBe(false);
		expect(latestCtx!.isAudioActive).toBe(true);
		expect(stopToneSpy).toHaveBeenCalledTimes(2);
		expect(stopSourceSpy).not.toHaveBeenCalled();

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});

		// 3. Pagehide stops tone, keeps mic recording
		await act(async () => {
			await latestCtx!.startReferenceTone(440, "sine", 0.2);
		});
		act(() => {
			window.dispatchEvent(new Event("pagehide"));
		});
		expect(latestCtx!.isTonePlaying).toBe(false);
		expect(latestCtx!.isAudioActive).toBe(true);
		expect(stopToneSpy).toHaveBeenCalledTimes(3);
		expect(stopSourceSpy).not.toHaveBeenCalled();
	});

	it("controls tuner tone via 20 Hz to 5 kHz slider while preserving key and octave shortcuts", async () => {
		const startToneSpy = vi.spyOn(AudioEngine.prototype, "startReferenceTone").mockResolvedValue();
		vi.spyOn(AudioEngine.prototype, "stopReferenceTone").mockImplementation(() => {});

		render(
			<PreferencesProvider>
				<AudioProvider>
					<ToneGeneratorCard />
				</AudioProvider>
			</PreferencesProvider>
		);

		const slider = container.querySelector<HTMLInputElement>('input[aria-label="Reference Tone Frequency"]');
		expect(slider).not.toBeNull();
		expect(container.textContent).toContain("A4 (440.0Hz)");

		// Slide to minimum (20 Hz)
		setRangeValue(slider!, slider!.min);
		expect(container.textContent).toContain("20.0Hz");

		// Slide to maximum (5000 Hz)
		setRangeValue(slider!, slider!.max);
		expect(container.textContent).toContain("5.00kHz");

		// Key shortcut: click C in current octave, then switch to A4
		const cBtn = Array.from(container.querySelectorAll("button.note-chip")).find(b => b.textContent?.trim() === "C");
		expect(cBtn).not.toBeUndefined();
		act(() => {
			cBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// From 5000 Hz (octave 8), C8 is 4.19 kHz
		expect(container.textContent).toContain("C8 (4.19kHz)");

		// Octave - shortcut steps down to C7 (2.09 kHz)
		const octDownBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "-");
		act(() => {
			octDownBtn!.click();
		});
		expect(container.textContent).toContain("C7 (2.09kHz)");

		// Octave + shortcut steps back up to C8 (4.19 kHz), then disables + since C9 > 5000 Hz
		const octUpBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "+");
		act(() => {
			octUpBtn!.click();
		});
		expect(container.textContent).toContain("C8 (4.19kHz)");
		expect(octUpBtn!.disabled).toBe(true);

		// Play tone uses current frequency
		const playBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Play"));
		await act(async () => {
			playBtn!.click();
		});
		expect(startToneSpy).toHaveBeenCalledWith(expect.closeTo(midiToFrequency(108, 440), 1), "sine", 0.2);
	});

	it("clamps tone frequencies to [20, 5000] and migrates legacy note-only preferences", () => {
		expect(clampToneFrequency(5)).toBe(TONE_MIN_FREQ_HZ);
		expect(clampToneFrequency(10000)).toBe(TONE_MAX_FREQ_HZ);
		expect(selectToneNoteInOctave(0, 0, 440)).toBeCloseTo(midiToFrequency(24, 440), 3); // C0 -> C1 (>= 20 Hz)
		expect(selectToneNoteInOctave(4, 8, 440)).toBeCloseTo(midiToFrequency(100, 440), 3); // E8 -> E7 (<= 5000 Hz)

		const migrated = mergePreferences({
			tuner: {
				toneGenNoteIndex: 60, // C4
			},
		});
		expect(migrated.tuner.toneGenFreqHz).toBeCloseTo(midiToFrequency(60, 440), 3);
		expect(migrated.tuner.viewMode).toBe("needle");
	});

	it("requires 2 fingers to scroll/pan on Spectrum Analyzer touch while 1 finger moves cursor", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		const zoomedPrefs = structuredClone(DEFAULT_PREFERENCES);
		zoomedPrefs.analyzer.minFreq = 200;
		zoomedPrefs.analyzer.maxFreq = 2000;
		savePreferences(zoomedPrefs);

		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrumAnalyzerView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const canvas = container.querySelector("canvas.viz-canvas") as HTMLCanvasElement;
		expect(canvas).not.toBeNull();
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 800,
			bottom: 420,
			width: 800,
			height: 420,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		const dispatchTouch = (type: string, touches: Array<{ clientX: number; clientY: number }>) => {
			const evt = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(evt, "touches", { value: touches });
			act(() => {
				canvas.dispatchEvent(evt);
			});
		};

		// Single-finger touch moves cursor but does not scroll/pan frequency range
		dispatchTouch("touchstart", [{ clientX: 250, clientY: 150 }]);
		dispatchTouch("touchmove", [{ clientX: 450, clientY: 150 }]);
		dispatchTouch("touchend", []);

		const storedAfterOneFinger = JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}");
		expect(storedAfterOneFinger.analyzer.minFreq).toBe(200);
		expect(storedAfterOneFinger.analyzer.maxFreq).toBe(2000);
		expect(container.textContent).toContain("200Hz – 2.00kHz");
		expect(container.textContent).toContain("dB");

		// Two-finger horizontal drag (same finger spacing) pans/scrolls the zoomed range
		dispatchTouch("touchstart", [
			{ clientX: 300, clientY: 150 },
			{ clientX: 400, clientY: 150 },
		]);
		dispatchTouch("touchmove", [
			{ clientX: 400, clientY: 150 },
			{ clientX: 500, clientY: 150 },
		]);
		dispatchTouch("touchend", []);

		const storedAfterTwoFingers = JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}");
		expect(storedAfterTwoFingers.analyzer.minFreq).toBeLessThan(200);
		expect(storedAfterTwoFingers.analyzer.maxFreq).toBeLessThan(2000);

		vi.unstubAllGlobals();
	});

	it("uses logarithmic mapping on FrequencyZoomControls regardless of Scale so lower frequencies are easy to select", () => {
		const onRangeChange = vi.fn();

		render(
			<FrequencyZoomControls
				minFreq={20}
				maxFreq={10000}
				nyquist={24000}
				freqScale="linear"
				onRangeChange={onRangeChange}
				onScaleChange={() => {}}
			/>
		);

		const minSlider = container.querySelector<HTMLInputElement>('input[aria-label="Minimum Frequency Hz"]');
		expect(minSlider).not.toBeNull();

		// Moving min slider to 50% of its travel should land near geometric midpoint (~632 Hz for 20..20k), not linear 10000 Hz
		const midStep = Math.round(Number(minSlider!.max) / 2);
		setRangeValue(minSlider!, String(midStep));
		expect(onRangeChange).toHaveBeenCalledTimes(1);
		const [nextMin, nextMax] = onRangeChange.mock.calls[0];
		expect(nextMin).toBeGreaterThan(500);
		expect(nextMin).toBeLessThan(800);
		expect(nextMax).toBe(10000);

		// Moving max slider to maximum must cap at 20000 Hz, not 24000 Hz
		const maxSlider = container.querySelector<HTMLInputElement>('input[aria-label="Maximum Frequency Hz"]');
		expect(maxSlider).not.toBeNull();
		setRangeValue(maxSlider!, maxSlider!.max);
		const [, clampedMax] = onRangeChange.mock.calls[1];
		expect(clampedMax).toBe(20000);
	});

	it("clamps frequency ranges everywhere to 20 kHz instead of 24 kHz", () => {
		expect(clampFreqRange(20, 24000, 24000)).toEqual([20, 20000]);
		expect(panFreqRange(10000, 20000, 0.5, 24000, "linear")).toEqual([10000, 20000]);
		const [, zoomedHi] = zoomFreqRange(20, 20000, 1000, 2, 24000, "log");
		expect(zoomedHi).toBe(20000);

		const migrated = mergePreferences({
			analyzer: { minFreq: 20, maxFreq: 24000 },
			spectrogram: { minFreq: 20, maxFreq: 24000 },
		});
		expect(migrated.analyzer.maxFreq).toBe(20000);
		expect(migrated.spectrogram.maxFreq).toBe(20000);
	});

	it("groups AnalyzerControls into a toggles/buttons row above a range sliders row", () => {
		render(
			<PreferencesProvider>
				<AudioProvider>
					<AnalyzerControls
						controlsOpen={true}
						nyquist={20000}
						onResetPeakHold={() => {}}
						onExportPNG={() => {}}
						onExportCSV={() => {}}
						onExportJSON={() => {}}
					/>
				</AudioProvider>
			</PreferencesProvider>
		);

		const dock = container.querySelector(".controls-dock-grouped");
		expect(dock).not.toBeNull();

		const children = Array.from(dock!.children);
		expect(children).toHaveLength(3);

		const [togglesRow, slidersRow, exportGroup] = children;
		expect(togglesRow.classList.contains("controls-row-toggles")).toBe(true);
		expect(togglesRow.querySelector('[aria-label="Octave Smoothing"]')).not.toBeNull();
		expect(togglesRow.querySelector('[aria-label="Spectral Tilt"]')).not.toBeNull();
		expect(togglesRow.querySelector('[aria-label="Frequency Scale"]')).not.toBeNull();
		expect(togglesRow.textContent).toContain("Peak Hold");
		expect(togglesRow.querySelectorAll('input[type="range"]')).toHaveLength(0);

		expect(slidersRow.classList.contains("controls-row-sliders")).toBe(true);
		expect(slidersRow.querySelector('[aria-label="Spectrum Time Smoothing"]')).not.toBeNull();
		expect(slidersRow.querySelector('[aria-label="Frequency Zoom Range Slider"]')).not.toBeNull();
		expect(slidersRow.querySelector('[aria-label="Decibel Range Slider"]')).not.toBeNull();

		// Export is placed after sliders in DOM/mobile flow so it sits at the bottom on mobile
		expect(exportGroup.classList.contains("export-group")).toBe(true);
		expect(exportGroup.textContent).toContain("Export");
	});

	it("places the Clear button to the left of the Pause button in SpectrogramControls", () => {
		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrogramControls
						controlsOpen={true}
						nyquist={20000}
						frameCount={10}
						maxScrollBackSec={5}
						effectiveScrollBack={0}
						onScrollBackChange={() => {}}
						onClearHistory={() => {}}
						onExportPNG={() => {}}
						onExportCSV={() => {}}
						onExportJSON={() => {}}
					/>
				</AudioProvider>
			</PreferencesProvider>
		);

		const clearBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Clear"));
		const pauseBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Pause"));
		expect(clearBtn).not.toBeUndefined();
		expect(pauseBtn).not.toBeUndefined();
		expect(clearBtn!.parentElement).toBe(pauseBtn!.parentElement);

		const groupButtons = Array.from(clearBtn!.parentElement!.querySelectorAll("button"));
		expect(groupButtons.indexOf(clearBtn!)).toBeLessThan(groupButtons.indexOf(pauseBtn!));
	});

	it("places the Clear button to the left of the Pause button in MobileControlsBar when onClear is provided", () => {
		const onClear = vi.fn();
		render(
			<MobileControlsBar
				summaryText="30s • magma • LOG"
				isPaused={false}
				canPause={true}
				controlsOpen={false}
				pauseLabel="Pause Spectrogram"
				resumeLabel="Resume Spectrogram"
				toggleControlsLabel="Toggle Spectrogram Controls"
				clearLabel="Clear Spectrogram History"
				onTogglePause={() => {}}
				onToggleControls={() => {}}
				onClear={onClear}
			/>
		);

		const clearBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Clear"));
		const pauseBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Pause"));
		expect(clearBtn).not.toBeUndefined();
		expect(pauseBtn).not.toBeUndefined();
		expect(clearBtn!.parentElement).toBe(pauseBtn!.parentElement);

		const barButtons = Array.from(clearBtn!.parentElement!.querySelectorAll("button"));
		expect(barButtons.indexOf(clearBtn!)).toBeLessThan(barButtons.indexOf(pauseBtn!));

		act(() => {
			clearBtn!.click();
		});
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("exports PNG canvases at least 1500px wide with a timestamp at the top", () => {
		const mobileDims = getPngExportDimensions(390, 580, 2);
		expect(mobileDims.width * mobileDims.dpr).toBeGreaterThanOrEqual(MIN_PNG_EXPORT_WIDTH);

		const smallDesktopDims = getPngExportDimensions(1200, 600, 1);
		expect(smallDesktopDims.width * smallDesktopDims.dpr).toBeGreaterThanOrEqual(MIN_PNG_EXPORT_WIDTH);

		const retinaDesktopDims = getPngExportDimensions(1440, 720, 2);
		expect(retinaDesktopDims.width * retinaDesktopDims.dpr).toBe(2880);

		const fillTextSpy = vi.fn();
		const translateSpy = vi.fn();
		const mockCtx = {
			save: vi.fn(),
			restore: vi.fn(),
			scale: vi.fn(),
			translate: translateSpy,
			fillRect: vi.fn(),
			fillText: fillTextSpy,
			fillStyle: "",
			font: "",
			textAlign: "left",
			textBaseline: "alphabetic",
		} as unknown as CanvasRenderingContext2D;

		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(mockCtx);

		const fixedDate = new Date(2026, 10, 25, 10, 54, 6);
		const expectedTimestamp = formatExportTimestamp(fixedDate);
		expect(expectedTimestamp).toBe("2026-11-25 10:54:06");

		const renderChartSpy = vi.fn();
		const exportCanvas = createHighResExportCanvas(
			390,
			580,
			"Spectrum Analyzer • 20.0 Hz – 20.00 kHz",
			renderChartSpy,
			46,
			22,
			fixedDate
		);

		expect(exportCanvas.width).toBeGreaterThanOrEqual(1500);
		expect(fillTextSpy).toHaveBeenCalledWith("Spectrum Analyzer • 20.0 Hz – 20.00 kHz", 46, expect.any(Number));
		expect(fillTextSpy).toHaveBeenCalledWith("2026-11-25 10:54:06", expect.any(Number), expect.any(Number));
		const timestampCall = fillTextSpy.mock.calls.find(c => c[0] === "2026-11-25 10:54:06");
		expect(timestampCall?.[2]).toBeLessThan(EXPORT_HEADER_HEIGHT);
		expect(translateSpy).toHaveBeenCalledWith(0, EXPORT_HEADER_HEIGHT);
		expect(renderChartSpy).toHaveBeenCalledTimes(1);
	});

	it("scales active Spectrum Analyzer cursor reticle and renders active Spectrogram target in PNG exports", () => {
		expect(scaleSpectrumCursor(null, 390, 580, 1500, 1125)).toBeNull();
		expect(scaleSpectrumCursor({ x: 5, y: 5 }, 390, 580, 1500, 1125)).toBeNull();

		const srcBounds = getSpectrumPlotBounds(390, 580);
		const dstBounds = getSpectrumPlotBounds(1500, 1125);
		const centerCursor = {
			x: srcBounds.padLeft + srcBounds.plotW * 0.5,
			y: srcBounds.padTop + srcBounds.plotH * 0.25,
		};
		const scaled = scaleSpectrumCursor(centerCursor, 390, 580, 1500, 1125);
		expect(scaled).not.toBeNull();
		expect(scaled!.x).toBeCloseTo(dstBounds.padLeft + dstBounds.plotW * 0.5, 4);
		expect(scaled!.y).toBeCloseTo(dstBounds.padTop + dstBounds.plotH * 0.25, 4);

		// Spectrogram canvas renders reticle/badges when target is active
		const arcSpy = vi.fn();
		const fillTextSpy = vi.fn();
		const mockCtx = {
			save: vi.fn(),
			restore: vi.fn(),
			scale: vi.fn(),
			fillRect: vi.fn(),
			strokeRect: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			fill: vi.fn(),
			arc: arcSpy,
			roundRect: vi.fn(),
			setLineDash: vi.fn(),
			fillText: fillTextSpy,
			measureText: vi.fn(() => ({ width: 32 })),
			drawImage: vi.fn(),
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 1,
			font: "",
			textAlign: "left",
			textBaseline: "alphabetic",
		} as unknown as CanvasRenderingContext2D;

		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		const buffer = new SpectrogramBuffer(60, 64, 48000, 60);
		renderSpectrogramCanvas(
			mockCtx,
			{ current: null },
			{ current: null },
			{
				width: 1500,
				height: 750,
				dpr: 1,
				prefs: DEFAULT_PREFERENCES.spectrogram,
				buffer,
				sampleRate: 48000,
				fftSize: 128,
				effectiveScrollBack: 0,
				frameCount: 0,
				earliestMs: 0,
				latestMs: 0,
				target: {
					freq: 440,
					note: "A4",
					timeOffsetSec: -5.2,
					db: -32,
				},
			}
		);

		expect(arcSpy).toHaveBeenCalled();
		expect(fillTextSpy).toHaveBeenCalledWith("440Hz", expect.any(Number), expect.any(Number));
		expect(fillTextSpy).toHaveBeenCalledWith("-5.2s", expect.any(Number), expect.any(Number));
	});

	it("toggles, moves, and preserves the reticle on SpectrumAnalyzerView across mouseleave and PNG export", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAA");
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrumAnalyzerView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const canvas = container.querySelector("canvas.viz-canvas") as HTMLCanvasElement;
		expect(canvas).not.toBeNull();
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 800,
			bottom: 420,
			width: 800,
			height: 420,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		const tap = (clientX: number, clientY: number) => {
			const startEvt = new Event("touchstart", { bubbles: true, cancelable: true });
			Object.defineProperty(startEvt, "touches", { value: [{ clientX, clientY }] });
			const endEvt = new Event("touchend", { bubbles: true, cancelable: true });
			Object.defineProperty(endEvt, "touches", { value: [] });
			act(() => {
				canvas.dispatchEvent(startEvt);
				canvas.dispatchEvent(endEvt);
			});
		};

		const getHudFreq = () => {
			const pills = Array.from(container.querySelectorAll(".hud-pill"));
			const targetPill = pills.find(p => p.textContent?.includes("dB"));
			return targetPill?.querySelector("strong")?.textContent ?? null;
		};

		// Initially no reticle
		expect(getHudFreq()).toBeNull();

		// 1. First tap adds reticle
		tap(200, 150);
		const firstFreq = getHudFreq();
		expect(firstFreq).not.toBeNull();

		// 2. Mouseleave + clicking PNG button keeps the reticle active
		act(() => {
			canvas.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
		});
		expect(getHudFreq()).toBe(firstFreq);

		const pngBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("PNG"));
		expect(pngBtn).not.toBeUndefined();
		act(() => {
			pngBtn!.click();
		});
		expect(getHudFreq()).toBe(firstFreq);

		// 3. Tapping elsewhere moves reticle immediately
		tap(550, 200);
		const secondFreq = getHudFreq();
		expect(secondFreq).not.toBeNull();
		expect(secondFreq).not.toBe(firstFreq);

		// 4. Tapping on the same vertical y-axis line (same x, different y) removes it
		tap(550, 100);
		expect(getHudFreq()).toBeNull();

		vi.unstubAllGlobals();
	});

	it("toggles, moves, and preserves the target on SpectrogramView across mouseleave and PNG export", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAA");
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrogramView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const canvas = container.querySelector("canvas.viz-canvas") as HTMLCanvasElement;
		expect(canvas).not.toBeNull();
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 800,
			bottom: 420,
			width: 800,
			height: 420,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		const getTargetPill = () =>
			Array.from(container.querySelectorAll(".hud-pill")).find(
				p => !p.textContent?.includes("Window") && !p.textContent?.includes("Range") && p.textContent?.includes("(")
			) ?? null;

		// 1. Mouse click adds target (must advance past touch guard if any)
		act(() => {
			canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 250, clientY: 160 }));
			canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 250, clientY: 160 }));
		});
		const firstText = getTargetPill()?.textContent;
		expect(firstText).toBeTruthy();

		// 2. Mouseleave + clicking PNG preserves target
		act(() => {
			canvas.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
		});
		expect(getTargetPill()?.textContent).toBe(firstText);

		const pngBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("PNG"));
		act(() => {
			pngBtn!.click();
		});
		expect(getTargetPill()?.textContent).toBe(firstText);

		// 3. Clicking elsewhere moves target immediately
		act(() => {
			canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 520, clientY: 220 }));
			canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 520, clientY: 220 }));
		});
		const secondText = getTargetPill()?.textContent;
		expect(secondText).toBeTruthy();
		expect(secondText).not.toBe(firstText);

		// 4. Clicking same point/y-axis line removes target
		act(() => {
			canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 520, clientY: 220 }));
			canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 520, clientY: 220 }));
		});
		expect(getTargetPill()).toBeNull();

		vi.unstubAllGlobals();
	});

	it("zooms export maxDb to +10dB padded ceiling (e.g. -54dB peak -> -40dB) and uses larger label font", () => {
		expect(computePaddedExportMaxDb(-54, -100, 0)).toBe(-40);
		expect(computePaddedExportMaxDb(-5, -100, 0)).toBe(0);
		expect(computePaddedExportMaxDb(-105, -100, 0)).toBe(-90);
		expect(computePaddedExportMaxDb(null, -100, 0)).toBe(0);

		// Spectrum peak detection in range
		const displayData = new Float32Array(256).fill(-90);
		const peakData = new Float32Array(256).fill(-90);
		displayData[20] = -54;
		peakData[20] = -54;
		const specPeak = getSpectrumPeakDbInRange(
			displayData,
			peakData,
			true,
			DEFAULT_PREFERENCES.analyzer,
			48000,
			512,
			256,
			1400
		);
		expect(specPeak).not.toBeNull();
		expect(specPeak!).toBeGreaterThan(-56);
		expect(specPeak!).toBeLessThanOrEqual(-54);
		expect(computePaddedExportMaxDb(specPeak, -100, 0)).toBe(-40);

		// Spectrogram peak detection in range
		const buffer = new SpectrogramBuffer(60, 256, 48000, 60);
		const frame = new Float32Array(256).fill(-88);
		frame[15] = -54;
		buffer.pushFrame(frame, 1000, true);
		const spectroPeak = getSpectrogramPeakDbInRange(buffer, DEFAULT_PREFERENCES.spectrogram, 48000, 512, 0, 1, 1000);
		expect(spectroPeak).toBeCloseTo(-54, 1);
		expect(computePaddedExportMaxDb(spectroPeak, -95, -5)).toBe(-40);

		// Verify larger font size is applied in renderSpectrumCanvas when labelFontPx = EXPORT_LABEL_FONT_PX
		const fontsUsed: string[] = [];
		const mockCtx = {
			save: vi.fn(),
			restore: vi.fn(),
			scale: vi.fn(),
			fillRect: vi.fn(),
			strokeRect: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			fill: vi.fn(),
			arc: vi.fn(),
			roundRect: vi.fn(),
			clip: vi.fn(),
			rect: vi.fn(),
			setLineDash: vi.fn(),
			fillText: vi.fn(),
			measureText: vi.fn(() => ({ width: 32 })),
			createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 1,
			textAlign: "left",
			textBaseline: "alphabetic",
			set font(val: string) {
				fontsUsed.push(val);
			},
		} as unknown as CanvasRenderingContext2D;

		renderSpectrumCanvas(mockCtx, {
			width: 1500,
			height: 750,
			dpr: 1,
			prefs: { ...DEFAULT_PREFERENCES.analyzer, maxDb: -40 },
			sampleRate: 48000,
			fftSize: 512,
			numBins: 256,
			isAudioActive: true,
			displayData,
			peakHoldData: peakData,
			cursor: { x: 400, y: 200 },
			labelFontPx: EXPORT_LABEL_FONT_PX,
		});

		expect(fontsUsed).toContain(`${EXPORT_LABEL_FONT_PX}px JetBrains Mono, monospace`);
		expect(fontsUsed).toContain(`bold ${EXPORT_LABEL_FONT_PX}px JetBrains Mono, monospace`);
	});

	it("supports desktop mouse click-and-drag to move the reticle on SpectrumAnalyzerView and SpectrogramView", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		// 1. SpectrumAnalyzerView desktop click-and-drag
		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrumAnalyzerView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const specCanvas = container.querySelector("canvas.viz-canvas") as HTMLCanvasElement;
		vi.spyOn(specCanvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 800,
			bottom: 420,
			width: 800,
			height: 420,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		const getSpecFreq = () => {
			const pill = Array.from(container.querySelectorAll(".hud-pill")).find(p => p.textContent?.includes("dB"));
			return pill?.querySelector("strong")?.textContent ?? null;
		};

		// Click and drag from 200 -> 450 moves reticle immediately
		act(() => {
			specCanvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200, clientY: 160 }));
		});
		const at200 = getSpecFreq();
		expect(at200).not.toBeNull();

		act(() => {
			specCanvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450, clientY: 160 }));
			specCanvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 450, clientY: 160 }));
		});
		const at450 = getSpecFreq();
		expect(at450).not.toBeNull();
		expect(at450).not.toBe(at200);

		// Clicking on the active reticle and dragging moves it again instead of removing it
		act(() => {
			specCanvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 450, clientY: 160 }));
			specCanvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 620, clientY: 160 }));
			specCanvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 620, clientY: 160 }));
		});
		const at620 = getSpecFreq();
		expect(at620).not.toBeNull();
		expect(at620).not.toBe(at450);

		// 2. SpectrogramView desktop click-and-drag on active target moves it
		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrogramView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const spectroCanvas = container.querySelector("canvas.viz-canvas") as HTMLCanvasElement;
		vi.spyOn(spectroCanvas, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 800,
			bottom: 420,
			width: 800,
			height: 420,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		const getSpectroPill = () =>
			Array.from(container.querySelectorAll(".hud-pill")).find(
				p => !p.textContent?.includes("Window") && !p.textContent?.includes("Range") && p.textContent?.includes("(")
			)?.textContent ?? null;

		// Place target
		act(() => {
			spectroCanvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240, clientY: 180 }));
			spectroCanvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 240, clientY: 180 }));
		});
		const spectroFirst = getSpectroPill();
		expect(spectroFirst).not.toBeNull();

		// Grab target and drag to new point
		act(() => {
			spectroCanvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240, clientY: 180 }));
			spectroCanvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 520, clientY: 120 }));
			spectroCanvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 520, clientY: 120 }));
		});
		const spectroDragged = getSpectroPill();
		expect(spectroDragged).not.toBeNull();
		expect(spectroDragged).not.toBe(spectroFirst);

		vi.unstubAllGlobals();
	});

	it("renders FreqAxisZoomBar with tick marks on track, supports wheel zoom on log/linear scale, and provides an icon-only reset button on the right", () => {
		const onRangeChange = vi.fn();

		render(
			<FreqAxisZoomBar minFreq={1000} maxFreq={1500} nyquist={20000} freqScale="linear" onRangeChange={onRangeChange} />
		);

		const bar = container.querySelector(".freq-axis-zoom-bar") as HTMLElement;
		const track = container.querySelector(".freq-axis-zoom-track") as HTMLElement;
		const zoomWindow = container.querySelector(".freq-axis-zoom-window") as HTMLElement;
		const resetBtn = container.querySelector("button.freq-axis-reset-btn") as HTMLButtonElement;

		expect(bar).not.toBeNull();
		expect(track).not.toBeNull();
		expect(track.querySelectorAll(".freq-axis-tick").length).toBeGreaterThan(0);
		expect(zoomWindow.querySelectorAll(".freq-axis-tick")).toHaveLength(0);
		expect(resetBtn).not.toBeNull();
		expect(resetBtn.textContent).toBe("");
		expect(resetBtn.disabled).toBe(false);

		// Reset button sits to the right of the track
		const barChildren = Array.from(bar.children);
		expect(barChildren.indexOf(resetBtn)).toBeGreaterThan(barChildren.indexOf(track));

		// Wheel zoom shrinks range smoothly even in linear mode with narrow span
		vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 700,
			bottom: 14,
			width: 700,
			height: 14,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		act(() => {
			bar.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 400 }));
		});
		expect(onRangeChange).toHaveBeenCalledTimes(1);
		const [zoomInLo, zoomInHi] = onRangeChange.mock.calls[0];
		expect(zoomInHi - zoomInLo).toBeLessThan(500);

		// Clicking reset restores full [20, 20000]
		act(() => {
			resetBtn.click();
		});
		expect(onRangeChange).toHaveBeenLastCalledWith(20, 20000);

		// Pointer drag on min handle works for both mouse and touch
		const minHandle = container.querySelector('[aria-label="Minimum Frequency Grab Handle"]') as HTMLElement;
		expect(minHandle).not.toBeNull();
		act(() => {
			const down = new Event("pointerdown", { bubbles: true, cancelable: true });
			Object.defineProperty(down, "clientX", { value: 200 });
			minHandle.dispatchEvent(down);
		});
		act(() => {
			const move = new Event("pointermove", { bubbles: true, cancelable: true });
			Object.defineProperty(move, "clientX", { value: 100 });
			window.dispatchEvent(move);
			window.dispatchEvent(new Event("pointerup", { bubbles: true }));
		});
		expect(onRangeChange.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("renders log standard tick marks including 50 Hz and snaps handles to 50 Hz without enforcing a 100 Hz step", () => {
		const onRangeChange = vi.fn();

		render(
			<FreqAxisZoomBar minFreq={20} maxFreq={100} nyquist={20000} freqScale="log" onRangeChange={onRangeChange} />
		);

		const track = container.querySelector(".freq-axis-zoom-track") as HTMLElement;
		const tickLabels = Array.from(track.querySelectorAll(".freq-axis-tick-label")).map(el => el.textContent);
		expect(tickLabels).toEqual(["20", "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k"]);

		vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 700,
			bottom: 14,
			width: 700,
			height: 14,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});

		// 50 Hz in log [20, 20000] is at log10(50/20) / log10(1000) * 700 ≈ 92.85px
		const minHandle = container.querySelector('[aria-label="Minimum Frequency Grab Handle"]') as HTMLElement;
		act(() => {
			const down = new Event("pointerdown", { bubbles: true, cancelable: true });
			Object.defineProperty(down, "clientX", { value: 0 });
			minHandle.dispatchEvent(down);
		});
		act(() => {
			const move = new Event("pointermove", { bubbles: true, cancelable: true });
			Object.defineProperty(move, "clientX", { value: 93 });
			window.dispatchEvent(move);
			window.dispatchEvent(new Event("pointerup", { bubbles: true }));
		});

		expect(onRangeChange).toHaveBeenLastCalledWith(50, 100);
	});

	it("keeps .freq-axis-zoom-bar rendered below the chart even when controls panel starts collapsed", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		const origWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });

		render(
			<PreferencesProvider>
				<AudioProvider>
					<SpectrumAnalyzerView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const dock = container.querySelector(".controls-dock");
		expect(dock?.classList.contains("collapsed")).toBe(true);
		const bar = container.querySelector(".viz-stage-col .freq-axis-zoom-bar");
		expect(bar).not.toBeNull();
		expect(bar?.querySelector("button.freq-axis-reset-btn")).not.toBeNull();

		Object.defineProperty(window, "innerWidth", { configurable: true, value: origWidth });
		vi.unstubAllGlobals();
	});
});
