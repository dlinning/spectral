/**
 * Circular ring buffer storing up to 60 seconds of raw FFT magnitude (dB) frames
 * and frame timestamps, allowing retroactive zoom, scale switching, colormap changes,
 * dynamic range adjustments, and full-resolution CSV/JSON exports.
 */
export interface SpectrogramSlice {
	frames: Float32Array[];
	timestampsMs: number[];
	numBins: number;
	sampleRate: number;
}

export class SpectrogramBuffer {
	public readonly maxFrames: number;
	private numBins: number;
	private sampleRate: number;
	private data: Float32Array;
	private timestamps: Float64Array;
	private head = 0; // index of next write
	private count = 0; // number of valid frames stored (<= maxFrames)
	private lastPushMs = -Infinity;
	private readonly minFrameIntervalMs: number;

	/**
	 * @param maxFrames Maximum frames to retain (3600 = 60s at 60fps)
	 * @param numBins Number of FFT frequency bins per frame (fftSize / 2)
	 * @param sampleRate Audio sample rate in Hz
	 * @param targetFps Target capture rate for throttling high-refresh displays (default 60fps)
	 */
	constructor(maxFrames = 3600, numBins = 2048, sampleRate = 48000, targetFps = 60) {
		this.maxFrames = Math.max(1, maxFrames);
		this.numBins = Math.max(1, numBins);
		this.sampleRate = sampleRate;
		this.minFrameIntervalMs = targetFps > 0 ? 1000 / targetFps : 0;
		this.data = new Float32Array(this.maxFrames * this.numBins);
		this.data.fill(-120);
		this.timestamps = new Float64Array(this.maxFrames);
	}

	public getNumBins(): number {
		return this.numBins;
	}

	public getSampleRate(): number {
		return this.sampleRate;
	}

	public getFrameCount(): number {
		return this.count;
	}

	public configure(numBins: number, sampleRate: number): void {
		if (numBins === this.numBins && sampleRate === this.sampleRate) return;
		this.sampleRate = sampleRate;
		if (numBins !== this.numBins) {
			this.numBins = Math.max(1, numBins);
			this.data = new Float32Array(this.maxFrames * this.numBins);
			this.data.fill(-120);
			this.timestamps = new Float64Array(this.maxFrames);
			this.head = 0;
			this.count = 0;
			this.lastPushMs = -Infinity;
		}
	}

	public clear(): void {
		this.head = 0;
		this.count = 0;
		this.lastPushMs = -Infinity;
		this.data.fill(-120);
		this.timestamps.fill(0);
	}

	/**
	 * Pushes a frame into the ring buffer. Returns true if accepted (not throttled).
	 */
	public pushFrame(bins: Float32Array, timestampMs: number = performance.now(), bypassThrottle = false): boolean {
		if (
			!bypassThrottle &&
			this.minFrameIntervalMs > 0 &&
			this.lastPushMs !== -Infinity &&
			timestampMs - this.lastPushMs < this.minFrameIntervalMs - 0.5
		) {
			return false;
		}

		const len = Math.min(bins.length, this.numBins);
		const offset = this.head * this.numBins;
		this.data.set(bins.subarray(0, len), offset);
		if (len < this.numBins) {
			this.data.fill(-120, offset + len, offset + this.numBins);
		}
		this.timestamps[this.head] = timestampMs;

		this.head = (this.head + 1) % this.maxFrames;
		if (this.count < this.maxFrames) {
			this.count++;
		}
		this.lastPushMs = timestampMs;
		return true;
	}

	/**
	 * Reads the i-th oldest frame (0 = oldest stored frame, count - 1 = newest).
	 */
	public getFrameView(logicalIndex: number): Float32Array | null {
		if (logicalIndex < 0 || logicalIndex >= this.count) return null;
		const startIdx = this.count < this.maxFrames ? 0 : this.head;
		const physicalIdx = (startIdx + logicalIndex) % this.maxFrames;
		const offset = physicalIdx * this.numBins;
		return this.data.subarray(offset, offset + this.numBins);
	}

	public getTimestampAt(logicalIndex: number): number {
		if (logicalIndex < 0 || logicalIndex >= this.count) return 0;
		const startIdx = this.count < this.maxFrames ? 0 : this.head;
		const physicalIdx = (startIdx + logicalIndex) % this.maxFrames;
		return this.timestamps[physicalIdx];
	}

	public getLatestTimestamp(): number {
		if (this.count === 0) return 0;
		return this.getTimestampAt(this.count - 1);
	}

	/**
	 * Returns logical indices of frames falling within the last `durationSec` seconds
	 * relative to the newest stored frame (or `referenceNowMs` if provided).
	 */
	public getIndicesForDuration(durationSec: number, referenceNowMs?: number): number[] {
		if (this.count === 0) return [];
		const endMs = referenceNowMs ?? this.getLatestTimestamp();
		const cutoffMs = endMs - durationSec * 1000;
		const indices: number[] = [];

		for (let i = 0; i < this.count; i++) {
			const ts = this.getTimestampAt(i);
			if (ts >= cutoffMs && ts <= endMs) {
				indices.push(i);
			}
		}
		return indices;
	}

	/**
	 * Extracts copied frames and timestamps for a requested history window (5s, 15s, 30s, 60s).
	 */
	public getHistorySlice(durationSec: number, referenceNowMs?: number): SpectrogramSlice {
		const indices = this.getIndicesForDuration(durationSec, referenceNowMs);
		const frames: Float32Array[] = [];
		const timestampsMs: number[] = [];

		for (const idx of indices) {
			const view = this.getFrameView(idx);
			if (view) {
				frames.push(new Float32Array(view));
				timestampsMs.push(this.getTimestampAt(idx));
			}
		}

		return {
			frames,
			timestampsMs,
			numBins: this.numBins,
			sampleRate: this.sampleRate,
		};
	}
}
