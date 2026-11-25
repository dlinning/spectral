import { Mic } from "lucide-react";
import React from "react";

interface EmptyAudioOverlayProps {
	title: string;
	description: string;
	onStartMic: () => void;
}

export const EmptyAudioOverlay: React.FC<EmptyAudioOverlayProps> = ({ title, description, onStartMic }) => (
	<div className="empty-audio-overlay">
		<h3>{title}</h3>
		<p>{description}</p>
		<div className="empty-overlay-actions">
			<button type="button" className="btn btn-primary" onClick={onStartMic}>
				<Mic size={20} /> Enable Microphone
			</button>
		</div>
	</div>
);
