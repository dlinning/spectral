/**
 * Resizes a canvas backing store to match its CSS dimensions scaled by DPR (capped at 2x)
 * and returns the 2D rendering context and effective DPR.
 */
export function prepareCanvas2d(
	canvas: HTMLCanvasElement,
	cssWidth: number,
	cssHeight: number
): { ctx: CanvasRenderingContext2D; dpr: number } | null {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const targetW = Math.max(1, Math.floor(cssWidth * dpr));
	const targetH = Math.max(1, Math.floor(cssHeight * dpr));
	if (canvas.width !== targetW || canvas.height !== targetH) {
		canvas.width = targetW;
		canvas.height = targetH;
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	return { ctx, dpr };
}
