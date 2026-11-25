import { RotateCcw } from "lucide-react";
import React from "react";
import { SegmentedControl, SegmentedOption } from "~/components/controls/SegmentedControl";
import { FreqScale } from "~/types/preferences";
import { MAX_DISPLAY_FREQ_HZ, clampFreqRange, formatFrequency, freqToNorm, normToFreq } from "~/utils/music";

interface FrequencyScaleControlProps {
	freqScale: FreqScale;
	onScaleChange: (scale: FreqScale) => void;
}

interface FrequencyRangeSliderProps {
	minFreq: number;
	maxFreq: number;
	nyquist: number;
	onRangeChange: (minFreq: number, maxFreq: number) => void;
}

interface FrequencyZoomControlsProps extends FrequencyScaleControlProps, FrequencyRangeSliderProps {}

const SCALE_OPTIONS: readonly SegmentedOption<FreqScale>[] = [
	{ value: "log", label: "Log" },
	{ value: "linear", label: "Linear" },
];

const SLIDER_STEPS = 150;
const ABS_MIN_HZ = 20;

export const FrequencyScaleControl: React.FC<FrequencyScaleControlProps> = ({ freqScale, onScaleChange }) => (
	<div className="control-group">
		<span className="control-label">Scale</span>
		<SegmentedControl ariaLabel="Frequency Scale" options={SCALE_OPTIONS} value={freqScale} onChange={onScaleChange} />
	</div>
);

export const FrequencyRangeSlider: React.FC<FrequencyRangeSliderProps> = ({
	minFreq,
	maxFreq,
	nyquist,
	onRangeChange,
}) => {
	const maxSliderHz = Math.min(MAX_DISPLAY_FREQ_HZ, Math.max(1000, Math.floor(nyquist / 100) * 100));
	const defaultMaxHz = Math.min(20000, maxSliderHz);

	// Use logarithmic mapping so lower frequencies (20 Hz - 1 kHz) have usable slider travel
	const sliderToHz = (val: number) => {
		if (val <= 0) return ABS_MIN_HZ;
		if (val >= SLIDER_STEPS) return maxSliderHz;
		const raw = normToFreq(val / SLIDER_STEPS, ABS_MIN_HZ, maxSliderHz, "log");
		return Math.round(raw);
	};

	const hzToSlider = (hz: number) => {
		const norm = freqToNorm(hz, ABS_MIN_HZ, maxSliderHz, "log");
		return Math.round(Math.max(0, Math.min(1, norm)) * SLIDER_STEPS);
	};

	const minSliderVal = Math.min(SLIDER_STEPS - 1, hzToSlider(minFreq));
	const maxSliderVal = Math.max(minSliderVal + 1, hzToSlider(maxFreq));

	const minPct = (minSliderVal / SLIDER_STEPS) * 100;
	const maxPct = (maxSliderVal / SLIDER_STEPS) * 100;

	const isZoomed = minFreq > 25 || Math.abs(maxFreq - defaultMaxHz) > 150;

	const handleMinSlide = (rawVal: number) => {
		const snapped = Math.min(rawVal, maxSliderVal - 1);
		const [lo, hi] = clampFreqRange(sliderToHz(snapped), maxFreq, maxSliderHz, 20);
		onRangeChange(lo, hi);
	};

	const handleMaxSlide = (rawVal: number) => {
		const snapped = Math.max(rawVal, minSliderVal + 1);
		const [lo, hi] = clampFreqRange(minFreq, sliderToHz(snapped), maxSliderHz, 20);
		onRangeChange(lo, hi);
	};

	const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
		e.preventDefault();
		const rect = e.currentTarget.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(20, rect.width)));
		const span = maxSliderVal - minSliderVal;
		const stepDelta = Math.max(2, Math.round(span * 0.14));
		const dir = e.deltaY > 0 ? 1 : -1; // >0 zooms out, <0 zooms in
		const nextMin = Math.max(0, minSliderVal - dir * Math.round(stepDelta * ratio));
		const nextMax = Math.min(SLIDER_STEPS, maxSliderVal + dir * Math.round(stepDelta * (1 - ratio)));
		if (nextMax - nextMin >= 1) {
			const [lo, hi] = clampFreqRange(sliderToHz(nextMin), sliderToHz(nextMax), maxSliderHz, 20);
			onRangeChange(lo, hi);
		}
	};

	return (
		<div className="control-group freq-zoom-group">
			<span className="control-label">Freq Range</span>
			<div className="dual-range-wrap" aria-label="Frequency Zoom Range Slider" onWheel={handleWheel}>
				<div className="dual-range-track" />
				<div
					className="dual-range-fill"
					style={{
						left: `${minPct}%`,
						width: `${Math.max(0, maxPct - minPct)}%`,
					}}
				/>
				<input
					type="range"
					aria-label="Minimum Frequency Hz"
					aria-valuetext={formatFrequency(minFreq)}
					className="dual-range-input"
					style={{ zIndex: minSliderVal > SLIDER_STEPS * 0.9 ? 4 : 2 }}
					min={0}
					max={SLIDER_STEPS}
					step={1}
					value={minSliderVal}
					onChange={e => handleMinSlide(Number(e.target.value))}
				/>
				<input
					type="range"
					aria-label="Maximum Frequency Hz"
					aria-valuetext={formatFrequency(maxFreq)}
					className="dual-range-input"
					style={{ zIndex: 3 }}
					min={0}
					max={SLIDER_STEPS}
					step={1}
					value={maxSliderVal}
					onChange={e => handleMaxSlide(Number(e.target.value))}
				/>
			</div>
			<span className="mono-val freq-range-readout">
				{formatFrequency(minFreq)} – {formatFrequency(maxFreq)}
			</span>
			<button
				type="button"
				className="btn btn-icon-only"
				disabled={!isZoomed}
				style={{ opacity: isZoomed ? 1 : 0.35, cursor: isZoomed ? "pointer" : "default" }}
				title="Reset Zoom"
				aria-label="Reset Frequency Zoom"
				onClick={() => onRangeChange(20, defaultMaxHz)}>
				<RotateCcw size={13} />
			</button>
		</div>
	);
};

export const FrequencyZoomControls: React.FC<FrequencyZoomControlsProps> = ({
	minFreq,
	maxFreq,
	nyquist,
	freqScale,
	onRangeChange,
	onScaleChange,
}) => (
	<>
		<FrequencyScaleControl freqScale={freqScale} onScaleChange={onScaleChange} />
		<FrequencyRangeSlider minFreq={minFreq} maxFreq={maxFreq} nyquist={nyquist} onRangeChange={onRangeChange} />
	</>
);
