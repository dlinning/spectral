import React from "react";

export interface SegmentedOption<T extends string | number> {
	value: T;
	label: string;
}

interface SegmentedControlProps<T extends string | number> {
	ariaLabel: string;
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
}

export function SegmentedControl<T extends string | number>({
	ariaLabel,
	options,
	value,
	onChange,
}: SegmentedControlProps<T>): React.ReactElement {
	return (
		<div className="segmented" role="group" aria-label={ariaLabel}>
			{options.map(opt => (
				<button
					key={String(opt.value)}
					type="button"
					className={`seg-btn ${value === opt.value ? "active" : ""}`}
					onClick={() => onChange(opt.value)}>
					{opt.label}
				</button>
			))}
		</div>
	);
}
