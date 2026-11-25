import { Pause, Play, SlidersHorizontal, Trash2 } from "lucide-react";
import React from "react";

interface MobileControlsBarProps {
	summaryText: string;
	isPaused: boolean;
	canPause: boolean;
	controlsOpen: boolean;
	pauseLabel: string;
	resumeLabel: string;
	toggleControlsLabel: string;
	clearLabel?: string;
	onTogglePause: () => void;
	onToggleControls: () => void;
	onClear?: () => void;
}

export const MobileControlsBar: React.FC<MobileControlsBarProps> = ({
	summaryText,
	isPaused,
	canPause,
	controlsOpen,
	pauseLabel,
	resumeLabel,
	toggleControlsLabel,
	clearLabel,
	onTogglePause,
	onToggleControls,
	onClear,
}) => (
	<div className="controls-mobile-bar">
		<span className="mobile-summary-text" style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
			{summaryText}
		</span>
		<div className="mobile-bar-actions">
			{onClear && (
				<button
					type="button"
					className="btn btn-icon-only-landscape"
					aria-label={clearLabel ?? "Clear"}
					title={clearLabel ?? "Clear"}
					onClick={onClear}>
					<Trash2 size={14} />
					<span className="mobile-portrait-label">Clear</span>
				</button>
			)}
			<button
				type="button"
				className={`btn btn-icon-only-landscape ${isPaused ? "btn-active-mic" : ""}`}
				disabled={!canPause}
				aria-label={isPaused ? resumeLabel : pauseLabel}
				title={isPaused ? "Resume" : "Pause"}
				onClick={onTogglePause}>
				{isPaused ? <Play size={14} /> : <Pause size={14} />}
				<span className="mobile-portrait-label">{isPaused ? "Resume" : "Pause"}</span>
			</button>
			<button
				type="button"
				className="btn btn-icon-only"
				aria-expanded={controlsOpen}
				aria-label={toggleControlsLabel}
				title={toggleControlsLabel}
				onClick={onToggleControls}>
				<SlidersHorizontal size={14} />
			</button>
		</div>
	</div>
);
