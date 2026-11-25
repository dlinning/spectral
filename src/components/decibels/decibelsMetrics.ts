export const DB_SPL_MIN = 0;
export const DB_SPL_MAX = 120;
export const DB_SPL_OFFSET = 120;
export const DB_SMOOTHING_MS = 200;

/**
 * Converts time-domain PCM samples to approximate dB SPL using 0 dB SPL
 * (threshold of human hearing) as the baseline, clamped to [minSpl, maxSpl].
 */
export function computeDbSpl(
  timeDomain: Float32Array,
  minSpl = DB_SPL_MIN,
  maxSpl = DB_SPL_MAX
): number {
  if (timeDomain.length === 0) return minSpl;
  let sumSq = 0;
  for (let i = 0; i < timeDomain.length; i++) {
    const s = timeDomain[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / timeDomain.length);
  if (!Number.isFinite(rms) || rms <= 1e-10) return minSpl;
  const dbFs = 20 * Math.log10(rms);
  const dbSpl = dbFs + DB_SPL_OFFSET;
  return Math.max(minSpl, Math.min(maxSpl, dbSpl));
}

/**
 * Checks whether a time-domain buffer contains any non-zero audio samples.
 */
export function hasNonZeroSamples(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] !== 0) return true;
  }
  return false;
}

export interface RealWorldDbEntry {
  db: number;
  label: string;
}

export const REAL_WORLD_DB_TABLE: readonly RealWorldDbEntry[] = [
  { db: 0, label: "Quietest sound heard" },
  { db: 10, label: "Breathing" },
  { db: 30, label: "Whispering nearby" },
  { db: 40, label: "Birds Chirping" },
  { db: 60, label: "Normal Conversation" },
  { db: 70, label: "Washing Machine" },
  { db: 80, label: "Blender" },
  { db: 90, label: "Subway Train" },
  { db: 100, label: "Motorcycle" },
  { db: 110, label: "Baby Crying" },
  { db: 120, label: "Loud Rock Concert" },
  { db: 125, label: "Immediate Pain" },
  { db: 140, label: "Jet engine at 100'" },
  { db: 180, label: "Death of hearing tissue" },
  { db: 194, label: "Loudest sound possible???" },
];

/**
 * Returns the closest real-world sound equivalent formatted as "<dB> - <description>".
 */
export function getRealWorldEquivalent(dbSpl: number): string {
  let best = REAL_WORLD_DB_TABLE[0];
  let bestDist = Infinity;

  for (const entry of REAL_WORLD_DB_TABLE) {
    const distToVal = Math.abs(entry.db - dbSpl);
    if (distToVal < bestDist) {
      bestDist = distToVal;
      best = entry;
    }
  }

  return `${best.db}dB - ${best.label}`;
}

/**
 * Maps a dB SPL value in [minSpl, maxSpl] to a gauge needle angle in [-maxAngleDeg, +maxAngleDeg].
 */
export function dbToAngleDeg(
  dbSpl: number,
  minSpl = DB_SPL_MIN,
  maxSpl = DB_SPL_MAX,
  maxAngleDeg = 80
): number {
  const clamped = Math.max(minSpl, Math.min(maxSpl, dbSpl));
  const norm = (clamped - minSpl) / Math.max(1, maxSpl - minSpl);
  return (norm * 2 - 1) * maxAngleDeg;
}
