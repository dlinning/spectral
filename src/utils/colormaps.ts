import { ColormapId } from '../types/preferences';

type RGBStop = [number, number, number];

const COLORMAP_STOPS: Record<ColormapId, RGBStop[]> = {
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 73, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [181, 222, 43],
    [253, 231, 37],
  ],
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33],
  ],
  grayscale: [
    [6, 9, 15],
    [64, 72, 86],
    [140, 152, 168],
    [210, 218, 230],
    [255, 255, 255],
  ],
};

const lutCache = new Map<ColormapId, Uint8ClampedArray>();

/**
 * Returns a 256 * 4 RGBA Uint8ClampedArray lookup table for a colormap.
 */
export function getColormapLUT(id: ColormapId): Uint8ClampedArray {
  const cached = lutCache.get(id);
  if (cached) return cached;

  const stops = COLORMAP_STOPS[id] ?? COLORMAP_STOPS.magma;
  const lut = new Uint8ClampedArray(256 * 4);
  const segments = stops.length - 1;

  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segments;
    const idx = Math.min(segments - 1, Math.floor(t));
    const frac = t - idx;
    const c0 = stops[idx];
    const c1 = stops[idx + 1];

    const base = i * 4;
    lut[base] = Math.round(c0[0] + (c1[0] - c0[0]) * frac);
    lut[base + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * frac);
    lut[base + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * frac);
    lut[base + 3] = 255;
  }

  lutCache.set(id, lut);
  return lut;
}

export const COLORMAP_OPTIONS: { id: ColormapId; label: string }[] = [
  { id: 'magma', label: 'Magma' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'plasma', label: 'Plasma' },
  { id: 'grayscale', label: 'Grayscale' },
];
