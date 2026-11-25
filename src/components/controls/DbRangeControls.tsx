import { RotateCcw } from "lucide-react";
import React from "react";

interface DbRangeControlsProps {
	minDb: number;
	maxDb: number;
	onChange: (minDb: number, maxDb: number) => void;
	defaultMinDb?: number;
	defaultMaxDb?: number;
}

const ABS_MIN_DB = -120;
const ABS_MAX_DB = 0;
const MIN_SPAN_DB = 10;

export const DbRangeControls: React.FC<DbRangeControlsProps> = ({
	minDb,
	maxDb,
	onChange,
	defaultMinDb = -100,
	defaultMaxDb = 0,
}) => {
	const safeMin = Math.max(ABS_MIN_DB, Math.min(ABS_MAX_DB - MIN_SPAN_DB, minDb));
	const safeMax = Math.max(safeMin + MIN_SPAN_DB, Math.min(ABS_MAX_DB, maxDb));

	const span = ABS_MAX_DB - ABS_MIN_DB;
	const minPct = ((safeMin - ABS_MIN_DB) / span) * 100;
	const maxPct = ((safeMax - ABS_MIN_DB) / span) * 100;

	const isModified = safeMin !== defaultMinDb || safeMax !== defaultMaxDb;

	const handleMinSlide = (val: number) => {
		const nextMin = Math.min(val, safeMax - MIN_SPAN_DB);
		onChange(nextMin, safeMax);
	};

	const handleMaxSlide = (val: number) => {
		const nextMax = Math.max(val, safeMin + MIN_SPAN_DB);
		onChange(safeMin, nextMax);
	};

	return (
		<div className="control-group db-range-group">
			<span className="control-label">dB Range</span>
			<div className="dual-range-wrap" aria-label="Decibel Range Slider">
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
					aria-label="Minimum Decibels"
					className="dual-range-input"
					style={{ zIndex: safeMin > ABS_MAX_DB - 20 ? 4 : 2 }}
					min={ABS_MIN_DB}
					max={ABS_MAX_DB}
					step={5}
					value={safeMin}
					onChange={e => handleMinSlide(Number(e.target.value))}
				/>
				<input
					type="range"
					aria-label="Maximum Decibels"
					className="dual-range-input"
					style={{ zIndex: 3 }}
					min={ABS_MIN_DB}
					max={ABS_MAX_DB}
					step={5}
					value={safeMax}
					onChange={e => handleMaxSlide(Number(e.target.value))}
				/>
			</div>
			<span className="mono-val db-range-readout">
				{safeMin} – {safeMax} dB
			</span>
			<button
				type="button"
				className="btn btn-icon-only"
				disabled={!isModified}
				style={{ opacity: isModified ? 1 : 0.35, cursor: isModified ? "pointer" : "default" }}
				title="Reset dB Range"
				aria-label="Reset Decibel Range"
				onClick={() => onChange(defaultMinDb, defaultMaxDb)}>
				<RotateCcw size={13} />
			</button>
		</div>
	);
};
