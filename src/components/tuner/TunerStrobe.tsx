import React, { useEffect, useRef } from "react";
import { prepareCanvas2d } from "~/utils/canvas";

interface TunerStrobeProps {
	active: boolean;
	cents: number;
}

export const TunerStrobe: React.FC<TunerStrobeProps> = ({ active, cents }) => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const strobePhaseRef = useRef<number>(0);
	const lastFrameTimeRef = useRef<number>(performance.now());

	useEffect(() => {
		let rafId = 0;

		const renderStrobe = (now: number) => {
			const dt = Math.min(0.05, (now - lastFrameTimeRef.current) / 1000);
			lastFrameTimeRef.current = now;

			const canvas = canvasRef.current;
			if (canvas) {
				const rect = canvas.getBoundingClientRect();
				const prepared = prepareCanvas2d(canvas, Math.max(100, rect.width), Math.max(24, rect.height));
				if (prepared) {
					const { ctx, dpr } = prepared;
					const w = canvas.width;
					const h = canvas.height;
					const speed = active ? cents * 7.5 : 0;
					strobePhaseRef.current = (strobePhaseRef.current + speed * dt) % 48;

					ctx.fillStyle = "#070b14";
					ctx.fillRect(0, 0, w, h);

					const period = 48 * dpr;
					const half = period / 2;
					const phase = (((strobePhaseRef.current * dpr) % period) + period) % period;
					const inTune = active && Math.abs(cents) <= 3;

					ctx.fillStyle = !active
						? "rgba(100, 116, 139, 0.25)"
						: inTune
							? "#10b981"
							: cents > 0
								? "#f59e0b"
								: "#22d3ee";

					for (let x = -period + phase; x < w + period; x += period) {
						ctx.fillRect(x, 0, half, h);
					}

					// Center reference tick
					ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
					ctx.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
				}
			}

			rafId = requestAnimationFrame(renderStrobe);
		};

		rafId = requestAnimationFrame(renderStrobe);
		return () => cancelAnimationFrame(rafId);
	}, [active, cents]);

	return (
		<div className="strobe-strip" title="Strobe phase indicator (locks still when in tune)">
			<canvas ref={canvasRef} className="strobe-canvas" />
		</div>
	);
};
