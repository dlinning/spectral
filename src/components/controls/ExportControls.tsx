import { Download } from "lucide-react";
import React from "react";

interface ExportControlsProps {
	onExportPNG: () => void;
	onExportCSV: () => void;
	onExportJSON: () => void;
}

export const ExportControls: React.FC<ExportControlsProps> = ({ onExportPNG, onExportCSV, onExportJSON }) => (
	<div className="export-group">
		<span className="control-label">Export</span>
		<button type="button" className="btn" onClick={onExportPNG}>
			<Download size={13} /> PNG
		</button>
		<button type="button" className="btn" onClick={onExportCSV}>
			<Download size={13} /> CSV
		</button>
		<button type="button" className="btn" onClick={onExportJSON}>
			<Download size={13} /> JSON
		</button>
	</div>
);
