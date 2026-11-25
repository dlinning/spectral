import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "~/App";
import { AudioEngine } from "~/audio/AudioEngine";
import { computeDbSpl, dbToAngleDeg, getRealWorldEquivalent } from "~/components/decibels/decibelsMetrics";
import { DecibelsView } from "~/components/decibels/DecibelsView";
import { AudioProvider, useAudio } from "~/contexts/AudioContext";
import { PreferencesProvider } from "~/contexts/PreferencesContext";
import { mergePreferences } from "~/hooks/usePreferences";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
	act(() => {
		root.render(ui);
	});
}

describe("Decibels Tab, Meter UI & Scrollable Header Tabs", () => {
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
		vi.unstubAllGlobals();
	});

	it("adds the Decibels tab after Tuner, switches to DecibelsView on click, and persists preference", () => {
		class MockResizeObserver {
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		expect(mergePreferences({ activeTab: "decibels" }).activeTab).toBe("decibels");

		render(<App />);

		const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tabs [role="tab"]'));
		expect(tabs.map(t => t.textContent?.trim())).toEqual(["Analyzer", "Spectrogram", "Tuner", "Decibels"]);

		const decibelsTab = tabs[3];
		act(() => {
			decibelsTab.click();
		});

		expect(decibelsTab.getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector('[aria-label="Decibels Needle Meter"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="decibels-current-readout"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="decibels-peak-card"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="decibels-min-card"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="decibels-loudest-freq"]')).toBeNull();
	});

	it("orders needle, current readout, and peak/min cards with label below value", () => {
		render(
			<PreferencesProvider>
				<AudioProvider>
					<DecibelsView />
				</AudioProvider>
			</PreferencesProvider>
		);

		const needle = container.querySelector('[aria-label="Decibels Needle Meter"]')!;
		const current = container.querySelector('[data-testid="decibels-current-readout"]')!;
		const peak = container.querySelector('[data-testid="decibels-peak-card"]')!;
		const min = container.querySelector('[data-testid="decibels-min-card"]')!;

		const isAfter = (a: Element, b: Element) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

		expect(isAfter(needle, current)).toBe(true);
		expect(isAfter(current, peak)).toBe(true);
		expect(isAfter(peak, min)).toBe(true);
		expect(peak).not.toBe(min);
		expect(isAfter(peak.querySelector(".decibels-stat-value")!, peak.querySelector(".decibels-stat-label")!)).toBe(
			true
		);
		expect(isAfter(min.querySelector(".decibels-stat-value")!, min.querySelector(".decibels-stat-label")!)).toBe(true);
		expect(container.querySelector('[data-testid="decibels-loudest-freq"]')).toBeNull();

		// Save button is hidden when Enable Mic is shown
		const enableMicBtn = Array.from(container.querySelectorAll("button")).find(b =>
			b.textContent?.includes("Enable Mic")
		);
		const saveBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Save"));
		expect(enableMicBtn).not.toBeUndefined();
		expect(saveBtn).toBeUndefined();
	});

	it("computes non-negative dB SPL relative to 0 dB SPL baseline and maps 160-degree needle angle", () => {
		const silence = new Float32Array(1024);
		expect(computeDbSpl(silence)).toBe(0);

		// Full-scale sine wave: RMS = 1/sqrt(2) ≈ -3.0103 dBFS -> 116.99 dB SPL
		const sine = new Float32Array(4096);
		for (let i = 0; i < sine.length; i++) {
			sine[i] = Math.sin((2 * Math.PI * 100 * i) / 4096);
		}
		expect(computeDbSpl(sine)).toBeCloseTo(116.99, 1);

		expect(dbToAngleDeg(0)).toBe(-80);
		expect(dbToAngleDeg(60)).toBe(0);
		expect(dbToAngleDeg(120)).toBe(80);

		expect(getRealWorldEquivalent(0)).toBe("0dB - Quietest sound heard");
		expect(getRealWorldEquivalent(32)).toBe("30dB - Whispering nearby");
		expect(getRealWorldEquivalent(63)).toBe("60dB - Normal Conversation");
		expect(getRealWorldEquivalent(90)).toBe("90dB - Subway Train");
		expect(getRealWorldEquivalent(92)).toBe("90dB - Subway Train");
		expect(getRealWorldEquivalent(111)).toBe("110dB - Baby Crying");
		expect(getRealWorldEquivalent(140)).toBe("140dB - Jet engine at 100'");
	});

	it("tracks current/peak/min dB SPL and resets peak/min cleanly", async () => {
		let sourceKind: "none" | "mic" = "none";
		let currentTimeMs = 1000;
		let rafCallback: FrameRequestCallback | null = null;
		let amp = 0.5;

		vi.spyOn(performance, "now").mockImplementation(() => currentTimeMs);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCallback = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});

		vi.spyOn(AudioEngine.prototype, "startMicrophone").mockImplementation(async () => {
			sourceKind = "mic";
		});
		vi.spyOn(AudioEngine.prototype, "getSourceKind").mockImplementation(() => sourceKind);
		vi.spyOn(AudioEngine.prototype, "getSampleRate").mockReturnValue(48000);
		vi.spyOn(AudioEngine.prototype, "listInputDevices").mockResolvedValue([]);
		vi.spyOn(AudioEngine.prototype, "getTimeDomainData").mockImplementation(target => {
			for (let i = 0; i < target.length; i++) {
				target[i] = amp * Math.sin((2 * Math.PI * 10 * i) / target.length);
			}
			return true;
		});
		vi.spyOn(AudioEngine.prototype, "getFrequencyData").mockReturnValue(true);

		let audioCtx: ReturnType<typeof useAudio> | null = null;
		const Harness = () => {
			audioCtx = useAudio();
			return <DecibelsView />;
		};

		render(
			<PreferencesProvider>
				<AudioProvider>
					<Harness />
				</AudioProvider>
			</PreferencesProvider>
		);

		await act(async () => {
			await audioCtx!.startMicrophone();
		});

		const stepFrame = (dtMs: number) => {
			currentTimeMs += dtMs;
			act(() => {
				rafCallback?.(currentTimeMs);
			});
		};

		// Frame 1: amp = 0.5 (RMS ≈ -9.03 dBFS -> 111.0 dB SPL)
		stepFrame(16);
		const currentEl = container.querySelector('[data-testid="decibels-current-readout"]')!;
		const peakEl = container.querySelector('[data-testid="decibels-peak-card"]')!;
		const minEl = container.querySelector('[data-testid="decibels-min-card"]')!;

		expect(currentEl.textContent).toContain("111dB");
		expect(peakEl.textContent).toContain("111dB");
		expect(minEl.textContent).toContain("111dB");
		const equivalentEl = container.querySelector('[data-testid="decibels-equivalent"]')!;
		expect(equivalentEl).not.toBeNull();
		expect(equivalentEl.textContent).toBe("110dB - Baby Crying");
		expect(Boolean(currentEl.compareDocumentPosition(equivalentEl) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
		expect(Boolean(equivalentEl.compareDocumentPosition(peakEl) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
		const currentNeedle = container.querySelector('[data-testid="decibels-needle-current"]')!;
		expect(currentNeedle).not.toBeNull();
		expect(Number(currentNeedle.getAttribute("data-angle"))).toBeCloseTo(dbToAngleDeg(110.97), 1);
		expect(container.querySelector('[data-testid="decibels-needle-peak"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="decibels-needle-min"]')).not.toBeNull();

		// Save first reading (111dB)
		const saveBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Save"))!;
		expect(saveBtn.disabled).toBe(false);
		act(() => {
			saveBtn.click();
		});

		// Drop level to amp = 0.05 (RMS ≈ -29.03 dBFS -> 91.0 dB SPL); peak stays 111, min drops to 91
		amp = 0.05;
		for (let i = 0; i < 90; i++) {
			stepFrame(16);
		}
		expect(peakEl.textContent).toContain("111dB");
		expect(minEl.textContent).toContain("91dB");
		expect(Number(currentNeedle.getAttribute("data-angle"))).toBeCloseTo(dbToAngleDeg(91), 0);

		// Save second reading (91dB); saved list below primary card shows newest-to-oldest
		act(() => {
			saveBtn.click();
		});
		const savedSection = container.querySelector('[data-testid="decibels-saved-list"]')!;
		expect(savedSection).not.toBeNull();
		const mainCard = container.querySelector(".decibels-card")!;
		expect(Boolean(mainCard.compareDocumentPosition(savedSection) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
		const savedValues = Array.from(savedSection.querySelectorAll(".decibels-saved-value")).map(el => el.textContent);
		expect(savedValues).toEqual(["91dB", "111dB"]);
		expect(savedSection.querySelectorAll(".decibels-saved-time")).toHaveLength(2);

		// Reset Peak/Min sets both peak and min to current smoothed level
		const resetBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Reset"))!;
		act(() => {
			resetBtn.click();
		});
		const currentText = currentEl.querySelector(".decibels-current-value")!.textContent;
		expect(peakEl.textContent).toContain(currentText!);
		expect(minEl.textContent).toContain(currentText!);
	});
});
