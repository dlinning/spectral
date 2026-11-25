import { RefObject, useEffect, useState } from "react";

export interface ElementSize {
	width: number;
	height: number;
}

/**
 * Tracks the floor-rounded content box dimensions of a DOM element via ResizeObserver.
 */
export function useElementSize<T extends HTMLElement>(
	ref: RefObject<T | null>,
	initialSize: ElementSize = { width: 800, height: 420 }
): ElementSize {
	const [size, setSize] = useState<ElementSize>(initialSize);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(entries => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width > 0 && height > 0) {
					setSize({ width: Math.floor(width), height: Math.floor(height) });
				}
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);

	return size;
}
