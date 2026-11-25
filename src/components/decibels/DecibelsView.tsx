import { Mic, RotateCcw, Save } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { DecibelsNeedle } from "~/components/decibels/DecibelsNeedle";
import {
	DB_SMOOTHING_MS,
	computeDbSpl,
	getRealWorldEquivalent,
	hasNonZeroSamples,
} from "~/components/decibels/decibelsMetrics";
import { useAudio, useAudioFrame } from "~/contexts/AudioContext";
import { timeConstantMsToAlpha } from "~/utils/music";

function formatDbSplValue(dbSpl: number | null): string {
	return dbSpl !== null ? `${dbSpl.toFixed(0)}dB` : "-- dB";
}

function formatSavedTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export const DecibelsView: React.FC = () => {
	const { isAudioActive, latestTimeDomainRef, savedDecibelReadings, saveDecibelReading, startMicrophone } = useAudio();
	const frameTick = useAudioFrame();

	const [currentDb, setCurrentDb] = useState<number | null>(null);
	const [peakDb, setPeakDb] = useState<number | null>(null);
	const [minDb, setMinDb] = useState<number | null>(null);

	const lastFrameMsRef = useRef<number>(performance.now());
	const smoothedDbRef = useRef<number | null>(null);
	const hasSignalRef = useRef<boolean>(false);

	useEffect(() => {
		if (!isAudioActive) {
			smoothedDbRef.current = null;
			hasSignalRef.current = false;
			setCurrentDb(null);
			setPeakDb(null);
			setMinDb(null);
			return;
		}

		const nowMs = performance.now();
		const dtMs = Math.max(1, nowMs - lastFrameMsRef.current);
		lastFrameMsRef.current = nowMs;
		const alpha = timeConstantMsToAlpha(DB_SMOOTHING_MS, dtMs);

		const td = latestTimeDomainRef.current;
		if (td.length > 0 && (hasSignalRef.current || hasNonZeroSamples(td))) {
			hasSignalRef.current = true;
			const instantDb = computeDbSpl(td);
			const nextCurrent =
				smoothedDbRef.current === null ? instantDb : alpha * smoothedDbRef.current + (1 - alpha) * instantDb;
			smoothedDbRef.current = nextCurrent;
			setCurrentDb(nextCurrent);
			setPeakDb(prev => (prev === null ? instantDb : Math.max(prev, instantDb)));
			setMinDb(prev => (prev === null ? instantDb : Math.min(prev, instantDb)));
		}
	}, [frameTick, isAudioActive, latestTimeDomainRef]);

	const handleResetPeakMin = () => {
		setPeakDb(currentDb);
		setMinDb(currentDb);
	};

	const realWorldEquivalent = currentDb !== null ? getRealWorldEquivalent(currentDb) : null;

	return (
		<div className="decibels-view">
			<div className="tuner-card decibels-card">
				<div className="decibels-card-header">
					<span className="control-label">Decibel Meter</span>
					<button
						type="button"
						className="btn"
						disabled={peakDb === null && minDb === null}
						style={{ opacity: peakDb === null && minDb === null ? 0.45 : 1 }}
						onClick={handleResetPeakMin}>
						<RotateCcw size={13} /> Reset
					</button>
				</div>

				<DecibelsNeedle currentDb={currentDb} peakDb={peakDb} minDb={minDb} />

				<div className="decibels-current-readout" data-testid="decibels-current-readout">
					<span className="control-label">Current</span>
					<strong className="decibels-current-value">{formatDbSplValue(currentDb)}</strong>
				</div>

				{realWorldEquivalent && (
					<div className="decibels-equivalent" data-testid="decibels-equivalent">
						{realWorldEquivalent}
					</div>
				)}

				<div className="decibels-stats-grid">
					<div className="decibels-stat-card" data-testid="decibels-peak-card">
						<strong className="decibels-stat-value decibels-stat-peak">{formatDbSplValue(peakDb)}</strong>
						<span className="decibels-stat-label">Peak</span>
					</div>
					<div className="decibels-stat-card" data-testid="decibels-min-card">
						<strong className="decibels-stat-value decibels-stat-min">{formatDbSplValue(minDb)}</strong>
						<span className="decibels-stat-label">Min</span>
					</div>
				</div>

				<div className="decibels-card-actions">
					{!isAudioActive ? (
						<button type="button" className="btn btn-primary" onClick={() => void startMicrophone()}>
							<Mic size={14} /> Enable Mic
						</button>
					) : (
						<button
							type="button"
							className="btn btn-large decibels-save-btn"
							disabled={currentDb === null}
							style={{ opacity: currentDb === null ? 0.45 : 1 }}
							onClick={() => {
								if (currentDb !== null) {
									saveDecibelReading(currentDb);
								}
							}}>
							<Save size={16} /> Save
						</button>
					)}
				</div>
			</div>

			{savedDecibelReadings.length > 0 && (
				<section
					className="tuner-card decibels-saved-section"
					aria-label="Saved Decibel Readings"
					data-testid="decibels-saved-list">
					<div className="decibels-card-header">
						<span className="control-label">Saved Readings</span>
						<span className="decibels-saved-count">{savedDecibelReadings.length}</span>
					</div>
					<ul className="decibels-saved-list">
						{savedDecibelReadings.map(entry => (
							<li key={entry.id} className="decibels-saved-item">
								<span className="decibels-saved-time">{formatSavedTimestamp(entry.timestamp)}</span>
								<strong className="decibels-saved-value">{formatDbSplValue(entry.db)}</strong>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
};
