// AssemblyScript WebAssembly DSP Kernel for Spectral PWA
// Handles fractional-octave smoothing, time-domain EMA smoothing, peak hold,
// and McLeod Pitch Method (MPM) normalized square difference function (NSDF).

/**
 * Exponential moving average (EMA) time smoothing on dB bins.
 * smoothed[i] = alpha * smoothed[i] + (1 - alpha) * current[i]
 */
export function applyTimeSmoothing(currentPtr: usize, smoothedPtr: usize, length: i32, alpha: f32): void {
	const clampedAlpha: f32 = alpha < 0.0 ? 0.0 : alpha > 0.995 ? 0.995 : alpha;
	const oneMinusAlpha: f32 = <f32>1.0 - clampedAlpha;

	for (let i: i32 = 0; i < length; i++) {
		const offset: usize = (<usize>i) << 2;
		const curr: f32 = load<f32>(currentPtr + offset);
		const prev: f32 = load<f32>(smoothedPtr + offset);
		const val: f32 = isNaN(prev) || !isFinite(prev) ? curr : clampedAlpha * prev + oneMinusAlpha * curr;
		store<f32>(smoothedPtr + offset, val);
	}
}

/**
 * Updates peak hold envelope with optional decay in dB per frame.
 */
export function updatePeakHold(currentPtr: usize, peakPtr: usize, length: i32, decayDbPerFrame: f32): void {
	for (let i: i32 = 0; i < length; i++) {
		const offset: usize = (<usize>i) << 2;
		const curr: f32 = load<f32>(currentPtr + offset);
		const prevPeak: f32 = load<f32>(peakPtr + offset) - decayDbPerFrame;
		const nextPeak: f32 = curr > prevPeak ? curr : prevPeak;
		store<f32>(peakPtr + offset, nextPeak);
	}
}

/**
 * O(N) Fractional-Octave Smoothing using prefix sums of linear acoustic power.
 * octaveDenominator: 0 = Off, 24 = 1/24 oct, 12 = 1/12 oct, 6 = 1/6 oct, 3 = 1/3 oct, 2 = 1/2 oct.
 */
export function applyOctaveSmoothing(
	inputDbPtr: usize,
	prefixPowerPtr: usize, // f64 array of length (length + 1)
	outputDbPtr: usize,
	length: i32,
	octaveDenominator: i32
): void {
	if (octaveDenominator <= 0 || length <= 1) {
		for (let i: i32 = 0; i < length; i++) {
			const offset: usize = (<usize>i) << 2;
			store<f32>(outputDbPtr + offset, load<f32>(inputDbPtr + offset));
		}
		return;
	}

	// Build prefix sum of linear power: P[k] = 10^(dB[k] / 10)
	store<f64>(prefixPowerPtr, 0.0);
	for (let i: i32 = 0; i < length; i++) {
		const dbOffset: usize = (<usize>i) << 2;
		let db: f64 = <f64>load<f32>(inputDbPtr + dbOffset);
		if (db < -160.0 || isNaN(db) || !isFinite(db)) db = -160.0;
		const power: f64 = Math.pow(10.0, db * 0.1);
		const prevSum: f64 = load<f64>(prefixPowerPtr + ((<usize>i) << 3));
		store<f64>(prefixPowerPtr + ((<usize>(i + 1)) << 3), prevSum + power);
	}

	// Bandwidth factor: 2^(1 / (2 * N))
	const exponent: f64 = 1.0 / (2.0 * <f64>octaveDenominator);
	const factor: f64 = Math.pow(2.0, exponent);
	const invFactor: f64 = 1.0 / factor;

	// DC bin (i = 0) stays unchanged
	store<f32>(outputDbPtr, load<f32>(inputDbPtr));

	for (let i: i32 = 1; i < length; i++) {
		const centerIdx: f64 = <f64>i;
		let kLow: i32 = <i32>Math.floor(centerIdx * invFactor);
		let kHigh: i32 = <i32>Math.ceil(centerIdx * factor);
		if (kLow < 1) kLow = 1;
		if (kHigh >= length) kHigh = length - 1;
		if (kHigh < kLow) kHigh = kLow;

		const count: f64 = <f64>(kHigh - kLow + 1);
		const sumHigh: f64 = load<f64>(prefixPowerPtr + ((<usize>(kHigh + 1)) << 3));
		const sumLow: f64 = load<f64>(prefixPowerPtr + ((<usize>kLow) << 3));
		let avgPower: f64 = (sumHigh - sumLow) / count;
		if (avgPower <= 1e-16) avgPower = 1e-16;

		const smoothedDb: f32 = <f32>(10.0 * Math.log10(avgPower));
		store<f32>(outputDbPtr + ((<usize>i) << 2), smoothedDb);
	}
}

/**
 * McLeod Pitch Method (MPM) Normalized Square Difference Function (NSDF).
 * Returns detected pitch in Hz (or -1.0 if signal is below gate or clarity threshold).
 * Clarity (0..1) is written as f32 to clarityOutPtr.
 */
export function detectPitchMPM(
	timeDomainPtr: usize,
	nsdfPtr: usize,
	length: i32,
	sampleRate: f32,
	clarityThreshold: f32,
	clarityOutPtr: usize
): f32 {
	if (length < 64) {
		store<f32>(clarityOutPtr, 0.0);
		return -1.0;
	}

	// Compute RMS level gate
	let sumSq: f64 = 0.0;
	for (let i: i32 = 0; i < length; i++) {
		const s: f64 = <f64>load<f32>(timeDomainPtr + ((<usize>i) << 2));
		sumSq += s * s;
	}
	const rms: f64 = Math.sqrt(sumSq / <f64>length);
	if (rms < 0.004) {
		store<f32>(clarityOutPtr, 0.0);
		return -1.0;
	}

	// Limit lag search to musical range [25 Hz .. 4500 Hz]
	let minTau: i32 = <i32>Math.floor(<f64>sampleRate / 4500.0);
	if (minTau < 2) minTau = 2;
	let maxTau: i32 = <i32>Math.ceil(<f64>sampleRate / 25.0);
	const halfLen: i32 = length >> 1;
	if (maxTau > halfLen) maxTau = halfLen;

	for (let tau: i32 = 0; tau <= maxTau; tau++) {
		let acf: f64 = 0.0;
		let div: f64 = 0.0;
		const limit: i32 = length - tau;
		for (let i: i32 = 0; i < limit; i++) {
			const s1: f64 = <f64>load<f32>(timeDomainPtr + ((<usize>i) << 2));
			const s2: f64 = <f64>load<f32>(timeDomainPtr + ((<usize>(i + tau)) << 2));
			acf += s1 * s2;
			div += s1 * s1 + s2 * s2;
		}
		const nsdfVal: f32 = div > 1e-12 ? <f32>((2.0 * acf) / div) : 0.0;
		store<f32>(nsdfPtr + ((<usize>tau) << 2), nsdfVal);
	}

	// Find first zero crossing from positive to negative
	let tau: i32 = minTau;
	while (tau < maxTau && load<f32>(nsdfPtr + ((<usize>tau) << 2)) > 0.0) {
		tau++;
	}
	while (tau < maxTau && load<f32>(nsdfPtr + ((<usize>tau) << 2)) <= 0.0) {
		tau++;
	}

	if (tau >= maxTau) {
		store<f32>(clarityOutPtr, 0.0);
		return -1.0;
	}

	// Collect positive lobe maxima
	let globalMaxVal: f32 = 0.0;
	// Store up to 32 peak candidates at the tail of nsdfPtr (safe above maxTau)
	let bestPeakTau: i32 = -1;
	let bestPeakVal: f32 = 0.0;

	// First pass: find highest peak across all positive lobes
	let scanTau: i32 = tau;
	while (scanTau < maxTau) {
		while (scanTau < maxTau && load<f32>(nsdfPtr + ((<usize>scanTau) << 2)) <= 0.0) {
			scanTau++;
		}
		let lobeMaxVal: f32 = 0.0;
		while (scanTau < maxTau && load<f32>(nsdfPtr + ((<usize>scanTau) << 2)) > 0.0) {
			const v: f32 = load<f32>(nsdfPtr + ((<usize>scanTau) << 2));
			if (v > lobeMaxVal) {
				lobeMaxVal = v;
			}
			scanTau++;
		}
		if (lobeMaxVal > globalMaxVal) {
			globalMaxVal = lobeMaxVal;
		}
	}

	if (globalMaxVal < clarityThreshold) {
		store<f32>(clarityOutPtr, globalMaxVal);
		return -1.0;
	}

	// Second pass: pick the FIRST lobe maximum that exceeds 0.88 * globalMaxVal (avoids subharmonic octave error)
	const cutoff: f32 = globalMaxVal * 0.88;
	scanTau = tau;
	while (scanTau < maxTau) {
		while (scanTau < maxTau && load<f32>(nsdfPtr + ((<usize>scanTau) << 2)) <= 0.0) {
			scanTau++;
		}
		let lobeMaxVal: f32 = -1.0;
		let lobeMaxTau: i32 = -1;
		while (scanTau < maxTau && load<f32>(nsdfPtr + ((<usize>scanTau) << 2)) > 0.0) {
			const v: f32 = load<f32>(nsdfPtr + ((<usize>scanTau) << 2));
			if (v > lobeMaxVal) {
				lobeMaxVal = v;
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

	if (bestPeakTau <= 0) {
		store<f32>(clarityOutPtr, 0.0);
		return -1.0;
	}

	// Parabolic interpolation around bestPeakTau
	let refinedTau: f64 = <f64>bestPeakTau;
	if (bestPeakTau > 1 && bestPeakTau < maxTau - 1) {
		const y1: f64 = <f64>load<f32>(nsdfPtr + ((<usize>(bestPeakTau - 1)) << 2));
		const y2: f64 = <f64>bestPeakVal;
		const y3: f64 = <f64>load<f32>(nsdfPtr + ((<usize>(bestPeakTau + 1)) << 2));
		const denom: f64 = 2.0 * y2 - y1 - y3;
		if (Math.abs(denom) > 1e-9) {
			const delta: f64 = (y3 - y1) / (2.0 * denom);
			if (delta > -1.0 && delta < 1.0) {
				refinedTau += delta;
			}
		}
	}

	store<f32>(clarityOutPtr, bestPeakVal);
	return <f32>(<f64>sampleRate / refinedTau);
}
