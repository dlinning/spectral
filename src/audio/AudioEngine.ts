import { FftSizeOption } from '../types/preferences';

export type AudioSourceKind = 'none' | 'mic';

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
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
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

  public stopSource(): void {
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

  public updateReferenceTone(freqHz: number, waveform: 'sine' | 'triangle', volume: number): void {
    if (!this.ctx || !this.toneOsc || !this.toneGain) return;
    const now = this.ctx.currentTime;
    this.toneOsc.type = waveform;
    this.toneOsc.frequency.setTargetAtTime(freqHz, now, 0.015);
    this.toneGain.gain.setTargetAtTime(Math.max(0.01, Math.min(0.5, volume)), now, 0.02);
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
