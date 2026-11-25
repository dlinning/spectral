/**
 * WebAssembly DSP Bridge with deterministic TypeScript fallback.
 * Binds `public/wasm/spectral_dsp.wasm` using imported WebAssembly.Memory
 * and provides zero-allocation typed array execution for 60fps DSP.
 */

export interface WasmDspExports {
  applyTimeSmoothing(
    currentPtr: number,
    smoothedPtr: number,
    length: number,
    alpha: number
  ): void;
  updatePeakHold(
    currentPtr: number,
    peakPtr: number,
    length: number,
    decayDbPerFrame: number
  ): void;
  applyOctaveSmoothing(
    inputDbPtr: number,
    prefixPowerPtr: number,
    outputDbPtr: number,
    length: number,
    octaveDenominator: number
  ): void;
  detectPitchMPM(
    timeDomainPtr: number,
    nsdfPtr: number,
    length: number,
    sampleRate: number,
    clarityThreshold: number,
    clarityOutPtr: number
  ): number;
}

export interface PitchResult {
  frequency: number; // -1 if no clear pitch
  clarity: number; // 0..1
}

// Memory layout offsets (bytes) starting at 1 MB to stay well above AssemblyScript static data/stack
const MEM_BASE = 1024 * 1024;
const MAX_BINS = 16384;
const MAX_TIME_SAMPLES = 32768;

const PTR_CURRENT = MEM_BASE; // f32[16384] = 64 KB
const PTR_SMOOTHED = PTR_CURRENT + MAX_BINS * 4;
const PTR_PEAK = PTR_SMOOTHED + MAX_BINS * 4;
const PTR_OCTAVE_OUT = PTR_PEAK + MAX_BINS * 4;
const PTR_PREFIX_POWER = PTR_OCTAVE_OUT + MAX_BINS * 4; // f64[16385] = 131 KB
const PTR_TIME_DOMAIN = PTR_PREFIX_POWER + (MAX_BINS + 2) * 8; // f32[32768] = 128 KB
const PTR_NSDF = PTR_TIME_DOMAIN + MAX_TIME_SAMPLES * 4; // f32[32768] = 128 KB
const PTR_CLARITY_OUT = PTR_NSDF + MAX_TIME_SAMPLES * 4; // f32[1]

class DspBridge {
  private exports: WasmDspExports | null = null;
  private memory: WebAssembly.Memory | null = null;
  private initPromise: Promise<boolean> | null = null;

  public isWasmReady(): boolean {
    return this.exports !== null && this.memory !== null;
  }

  public async init(wasmUrl = './wasm/spectral_dsp.wasm'): Promise<boolean> {
    if (this.exports) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') {
          return false;
        }
        const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
        const imports = { env: { memory } };

        const response = await fetch(wasmUrl);
        if (!response.ok) return false;

        let instance: WebAssembly.Instance;
        if (typeof WebAssembly.instantiateStreaming === 'function') {
          try {
            const res = await WebAssembly.instantiateStreaming(
              response.clone(),
              imports
            );
            instance = res.instance;
          } catch {
            const bytes = await response.arrayBuffer();
            const res = await WebAssembly.instantiate(bytes, imports);
            instance = res.instance;
          }
        } else {
          const bytes = await response.arrayBuffer();
          const res = await WebAssembly.instantiate(bytes, imports);
          instance = res.instance;
        }

        this.memory = memory;
        this.exports = instance.exports as unknown as WasmDspExports;
        return true;
      } catch {
        return false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Instantiates the WASM kernel directly from raw bytes (useful in Vitest/Node).
   */
  public async initFromBytes(bytes: ArrayBuffer | Uint8Array): Promise<boolean> {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
    const res = await WebAssembly.instantiate(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      { env: { memory } }
    );
    this.memory = memory;
    this.exports = res.instance.exports as unknown as WasmDspExports;
    return true;
  }

  public applyTimeSmoothing(
    current: Float32Array,
    smoothed: Float32Array,
    alpha: number
  ): void {
    const len = Math.min(current.length, smoothed.length);
    if (len <= 0) return;

    if (this.exports && this.memory && len <= MAX_BINS) {
      const f32 = new Float32Array(this.memory.buffer);
      f32.set(current.subarray(0, len), PTR_CURRENT >> 2);
      f32.set(smoothed.subarray(0, len), PTR_SMOOTHED >> 2);
      this.exports.applyTimeSmoothing(PTR_CURRENT, PTR_SMOOTHED, len, alpha);
      smoothed.set(f32.subarray(PTR_SMOOTHED >> 2, (PTR_SMOOTHED >> 2) + len));
      return;
    }

    const clamped = Math.max(0, Math.min(0.995, alpha));
    const oneMinus = 1 - clamped;
    for (let i = 0; i < len; i++) {
      const prev = smoothed[i];
      const curr = current[i];
      smoothed[i] = Number.isFinite(prev)
        ? clamped * prev + oneMinus * curr
        : curr;
    }
  }

  public updatePeakHold(
    current: Float32Array,
    peak: Float32Array,
    decayDbPerFrame: number
  ): void {
    const len = Math.min(current.length, peak.length);
    if (len <= 0) return;

    if (this.exports && this.memory && len <= MAX_BINS) {
      const f32 = new Float32Array(this.memory.buffer);
      f32.set(current.subarray(0, len), PTR_CURRENT >> 2);
      f32.set(peak.subarray(0, len), PTR_PEAK >> 2);
      this.exports.updatePeakHold(PTR_CURRENT, PTR_PEAK, len, decayDbPerFrame);
      peak.set(f32.subarray(PTR_PEAK >> 2, (PTR_PEAK >> 2) + len));
      return;
    }

    for (let i = 0; i < len; i++) {
      const decayed = peak[i] - decayDbPerFrame;
      peak[i] = current[i] > decayed ? current[i] : decayed;
    }
  }

  public applyOctaveSmoothing(
    inputDb: Float32Array,
    outputDb: Float32Array,
    octaveDenominator: number
  ): void {
    const len = Math.min(inputDb.length, outputDb.length);
    if (len <= 0) return;

    if (octaveDenominator <= 0 || len <= 1) {
      outputDb.set(inputDb.subarray(0, len));
      return;
    }

    if (this.exports && this.memory && len <= MAX_BINS) {
      const f32 = new Float32Array(this.memory.buffer);
      f32.set(inputDb.subarray(0, len), PTR_CURRENT >> 2);
      this.exports.applyOctaveSmoothing(
        PTR_CURRENT,
        PTR_PREFIX_POWER,
        PTR_OCTAVE_OUT,
        len,
        octaveDenominator
      );
      outputDb.set(
        f32.subarray(PTR_OCTAVE_OUT >> 2, (PTR_OCTAVE_OUT >> 2) + len)
      );
      return;
    }

    // TypeScript fallback: identical prefix-sum linear power averaging
    const prefix = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) {
      let db = inputDb[i];
      if (!Number.isFinite(db) || db < -160) db = -160;
      prefix[i + 1] = prefix[i] + Math.pow(10, db * 0.1);
    }

    const factor = Math.pow(2, 1 / (2 * octaveDenominator));
    const invFactor = 1 / factor;
    outputDb[0] = inputDb[0];

    for (let i = 1; i < len; i++) {
      const kLow = Math.max(1, Math.floor(i * invFactor));
      const kHigh = Math.max(kLow, Math.min(len - 1, Math.ceil(i * factor)));
      const count = kHigh - kLow + 1;
      const avgPower = Math.max(1e-16, (prefix[kHigh + 1] - prefix[kLow]) / count);
      outputDb[i] = 10 * Math.log10(avgPower);
    }
  }

  public detectPitchMPM(
    timeDomain: Float32Array,
    sampleRate: number,
    clarityThreshold = 0.78
  ): PitchResult {
    const len = timeDomain.length;
    if (len < 64) return { frequency: -1, clarity: 0 };

    if (this.exports && this.memory && len <= MAX_TIME_SAMPLES) {
      const f32 = new Float32Array(this.memory.buffer);
      f32.set(timeDomain, PTR_TIME_DOMAIN >> 2);
      const freq = this.exports.detectPitchMPM(
        PTR_TIME_DOMAIN,
        PTR_NSDF,
        len,
        sampleRate,
        clarityThreshold,
        PTR_CLARITY_OUT
      );
      const clarity = f32[PTR_CLARITY_OUT >> 2];
      return { frequency: freq, clarity };
    }

    return detectPitchMPMFallback(timeDomain, sampleRate, clarityThreshold);
  }
}

export function detectPitchMPMFallback(
  timeDomain: Float32Array,
  sampleRate: number,
  clarityThreshold = 0.78
): PitchResult {
  const length = timeDomain.length;
  if (length < 64) return { frequency: -1, clarity: 0 };

  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const s = timeDomain[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / length);
  if (rms < 0.004) return { frequency: -1, clarity: 0 };

  const minTau = Math.max(2, Math.floor(sampleRate / 4500));
  const maxTau = Math.min(length >> 1, Math.ceil(sampleRate / 25));
  const nsdf = new Float32Array(maxTau + 1);

  for (let tau = 0; tau <= maxTau; tau++) {
    let acf = 0;
    let div = 0;
    const limit = length - tau;
    for (let i = 0; i < limit; i++) {
      const s1 = timeDomain[i];
      const s2 = timeDomain[i + tau];
      acf += s1 * s2;
      div += s1 * s1 + s2 * s2;
    }
    nsdf[tau] = div > 1e-12 ? (2 * acf) / div : 0;
  }

  let tau = minTau;
  while (tau < maxTau && nsdf[tau] > 0) tau++;
  while (tau < maxTau && nsdf[tau] <= 0) tau++;
  if (tau >= maxTau) return { frequency: -1, clarity: 0 };

  let globalMaxVal = 0;
  let scanTau = tau;
  while (scanTau < maxTau) {
    while (scanTau < maxTau && nsdf[scanTau] <= 0) scanTau++;
    let lobeMax = 0;
    while (scanTau < maxTau && nsdf[scanTau] > 0) {
      if (nsdf[scanTau] > lobeMax) lobeMax = nsdf[scanTau];
      scanTau++;
    }
    if (lobeMax > globalMaxVal) globalMaxVal = lobeMax;
  }

  if (globalMaxVal < clarityThreshold) {
    return { frequency: -1, clarity: globalMaxVal };
  }

  const cutoff = globalMaxVal * 0.88;
  let bestPeakTau = -1;
  let bestPeakVal = 0;
  scanTau = tau;
  while (scanTau < maxTau) {
    while (scanTau < maxTau && nsdf[scanTau] <= 0) scanTau++;
    let lobeMaxVal = -1;
    let lobeMaxTau = -1;
    while (scanTau < maxTau && nsdf[scanTau] > 0) {
      if (nsdf[scanTau] > lobeMaxVal) {
        lobeMaxVal = nsdf[scanTau];
        lobeMaxTau = scanTau;
      }
      scanTau++;
    }
    if (lobeMaxVal >= cutoff && lobeMaxTau > 0) {
      bestPeakTau = lobeMaxTau;
      bestPeakVal = lobeMaxVal;
      break;
    }
  }

  if (bestPeakTau <= 0) return { frequency: -1, clarity: 0 };

  let refinedTau = bestPeakTau;
  if (bestPeakTau > 1 && bestPeakTau < maxTau - 1) {
    const y1 = nsdf[bestPeakTau - 1];
    const y2 = bestPeakVal;
    const y3 = nsdf[bestPeakTau + 1];
    const denom = 2 * y2 - y1 - y3;
    if (Math.abs(denom) > 1e-9) {
      const delta = (y3 - y1) / (2 * denom);
      if (delta > -1 && delta < 1) {
        refinedTau += delta;
      }
    }
  }

  return { frequency: sampleRate / refinedTau, clarity: bestPeakVal };
}

export const dspBridge = new DspBridge();
