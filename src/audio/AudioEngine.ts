import { DemoSignalMode, FftSizeOption } from '../types/preferences';

export type AudioSourceKind = 'none' | 'mic' | 'demo';

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private silentSink: GainNode | null = null;

  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  private demoNodes: AudioNode[] = [];
  private demoSweepTimer: number | null = null;

  private toneOsc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;

  private sourceKind: AudioSourceKind = 'none';
  private fftSize: FftSizeOption = 4096;

  public getSourceKind(): AudioSourceKind {
    return this.sourceKind;
  }

  public getSampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  public getFftSize(): FftSizeOption {
    return this.fftSize;
  }

  public getBinCount(): number {
    return this.analyser ? this.analyser.frequencyBinCount : this.fftSize / 2;
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      // Disable Web Audio's built-in smoothing so our WASM DSP engine owns time smoothing cleanly
      this.analyser.smoothingTimeConstant = 0;
      this.analyser.minDecibels = -120;
      this.analyser.maxDecibels = 0;

      // Connect analyser to a silent sink at destination so browsers actively pull graph frames
      this.silentSink = this.ctx.createGain();
      this.silentSink.gain.value = 0;
      this.analyser.connect(this.silentSink);
      this.silentSink.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  public setFftSize(fftSize: FftSizeOption): void {
    this.fftSize = fftSize;
    if (this.analyser) {
      this.analyser.fftSize = fftSize;
    }
  }

  public async listInputDevices(): Promise<AudioDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${idx + 1}`,
        }));
    } catch {
      return [];
    }
  }

  public async startMicrophone(deviceId?: string): Promise<void> {
    this.stopSource();
    const ctx = await this.ensureContext();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser.');
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId && deviceId !== 'default'
        ? { deviceId: { exact: deviceId } }
        : {}),
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    if (this.analyser) {
      this.micSource.connect(this.analyser);
    }
    this.sourceKind = 'mic';
  }

  public async startDemoSignal(mode: DemoSignalMode): Promise<void> {
    this.stopSource();
    const ctx = await this.ensureContext();
    if (!this.analyser) return;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.45;
    masterGain.connect(this.analyser);
    this.demoNodes.push(masterGain);

    if (mode === 'a4') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      const g = ctx.createGain();
      g.gain.value = 0.7;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      this.demoNodes.push(osc, g);
    } else if (mode === 'chord') {
      // A major 7 / harmonic chord + subtle pink noise bed
      const freqs = [220, 277.18, 329.63, 440, 880, 1760];
      const amps = [0.35, 0.25, 0.25, 0.3, 0.14, 0.07];
      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        osc.type = idx < 2 ? 'triangle' : 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = amps[idx];
        osc.connect(g);
        g.connect(masterGain);
        osc.start();
        this.demoNodes.push(osc, g);
      });
      this.attachPinkNoise(ctx, masterGain, 0.08);
    } else if (mode === 'harmonics') {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 110;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 4200;
      const g = ctx.createGain();
      g.gain.value = 0.45;
      osc.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      osc.start();
      this.demoNodes.push(osc, filter, g);
      this.attachPinkNoise(ctx, masterGain, 0.04);
    } else if (mode === 'sweep') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      g.gain.value = 0.65;
      osc.connect(g);
      g.connect(masterGain);

      const scheduleSweep = () => {
        const now = ctx.currentTime;
        osc.frequency.cancelScheduledValues(now);
        osc.frequency.setValueAtTime(60, now);
        osc.frequency.exponentialRampToValueAtTime(9000, now + 6.5);
        osc.frequency.exponentialRampToValueAtTime(60, now + 7.8);
      };

      scheduleSweep();
      osc.start();
      this.demoSweepTimer = window.setInterval(scheduleSweep, 8000);
      this.demoNodes.push(osc, g);
      this.attachPinkNoise(ctx, masterGain, 0.05);
    } else if (mode === 'pinknoise') {
      this.attachPinkNoise(ctx, masterGain, 0.65);
    }

    this.sourceKind = 'demo';
  }

  private attachPinkNoise(
    ctx: AudioContext,
    destination: AudioNode,
    gainAmount: number
  ): void {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const out = buffer.getChannelData(0);

    // Paul Kellet's refined pink noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.06;
      b6 = white * 0.115926;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = gainAmount;
    src.connect(g);
    g.connect(destination);
    src.start();
    this.demoNodes.push(src, g);
  }

  public stopSource(): void {
    if (this.demoSweepTimer !== null) {
      window.clearInterval(this.demoSweepTimer);
      this.demoSweepTimer = null;
    }

    for (const node of this.demoNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        // Already stopped
      }
    }
    this.demoNodes = [];

    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // Ignore
      }
      this.micSource = null;
    }

    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }

    this.sourceKind = 'none';
    if (!this.toneOsc && this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend();
    }
  }

  public async startReferenceTone(
    freqHz: number,
    waveform: 'sine' | 'triangle',
    volume: number
  ): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopReferenceTone();

    const osc = ctx.createOscillator();
    osc.type = waveform;
    osc.frequency.setValueAtTime(freqHz, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.01, Math.min(0.5, volume)),
      ctx.currentTime + 0.03
    );

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    this.toneOsc = osc;
    this.toneGain = gain;
  }

  public updateReferenceTone(
    freqHz: number,
    waveform: 'sine' | 'triangle',
    volume: number
  ): void {
    if (!this.ctx || !this.toneOsc || !this.toneGain) return;
    const now = this.ctx.currentTime;
    this.toneOsc.type = waveform;
    this.toneOsc.frequency.setTargetAtTime(freqHz, now, 0.015);
    this.toneGain.gain.setTargetAtTime(
      Math.max(0.01, Math.min(0.5, volume)),
      now,
      0.02
    );
  }

  public stopReferenceTone(): void {
    if (this.toneOsc) {
      try {
        this.toneOsc.stop();
        this.toneOsc.disconnect();
      } catch {
        // Ignore
      }
      this.toneOsc = null;
    }
    if (this.toneGain) {
      try {
        this.toneGain.disconnect();
      } catch {
        // Ignore
      }
      this.toneGain = null;
    }
    if (this.sourceKind === 'none' && this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend();
    }
  }

  public getFrequencyData(target: Float32Array): boolean {
    if (!this.analyser || this.sourceKind === 'none') return false;
    this.analyser.getFloatFrequencyData(target as Float32Array<ArrayBuffer>);
    return true;
  }

  public getTimeDomainData(target: Float32Array): boolean {
    if (!this.analyser || this.sourceKind === 'none') return false;
    this.analyser.getFloatTimeDomainData(target as Float32Array<ArrayBuffer>);
    return true;
  }

  public dispose(): void {
    this.stopSource();
    this.stopReferenceTone();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
