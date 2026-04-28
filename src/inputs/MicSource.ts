// Microphone input source.
//
// Pipeline (per requestAnimationFrame tick while running):
//   AnalyserNode → time-domain RMS → MicVolume (0..1)
//                → frequency-domain → F1/F2 formants → MicPhoneme
//                → MicVolume + thresholds → state machine → MicState
//
// State machine (the "switch" model):
//   - Going UP across a threshold is instant.
//   - Going DOWN out of a threshold starts that threshold's hold timer.
//   - When the hold expires, MicState drops directly to null. State never
//     transitions sideways or to a lower non-null state.
//
// Permissions: getUserMedia({audio:true}) triggers the OS/browser mic
// prompt on first call. Subsequent calls reuse granted permission.

import { inputBus } from "./InputBus";
import {
  type MicConfig,
  type MicThreshold,
  type Phoneme,
  PHONEMES,
} from "../types/avatar";

// Reference vowel formants (Hz). Approximate adult English/Japanese values;
// the classifier picks the nearest in the F1/F2 plane.
const VOWEL_CENTROIDS: Array<{ name: Phoneme; f1: number; f2: number }> = [
  { name: "A", f1: 800, f2: 1300 },
  { name: "I", f1: 320, f2: 2400 },
  { name: "U", f1: 350, f2: 800 },
  { name: "E", f1: 500, f2: 2100 },
  { name: "O", f1: 500, f2: 950 },
];

const F1_RANGE: [number, number] = [250, 1100];
const F2_RANGE: [number, number] = [700, 3000];

/** Below this magnitude (dB) the formant signal is treated as silence. */
const FORMANT_NOISE_FLOOR_DB = -65;

/**
 * Hysteresis stickiness. To switch from the current phoneme to a different one,
 * the new candidate's distance must be < currentDistance × STICKINESS. Lower
 * value = stickier. 0.7 means new candidate has to be 30% closer than current.
 */
const PHONEME_STICKINESS = 0.7;

/**
 * Minimum time (ms) to stay on a phoneme after switching. Prevents rapid
 * flip-flop on phonemes near a boundary in formant space (O/U is the classic
 * problem case).
 */
const PHONEME_MIN_HOLD_MS = 80;

class MicSource {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private config: MicConfig;

  // Threshold state machine
  private currentState: string | null = null;
  private holdEndTime: number | null = null;

  // Phoneme detection state — sticky with min hold time
  private currentPhoneme: Phoneme | null = null;
  private phonemeSwitchedAt = 0;

  // Hold timer progress (0..1) — exposed via bus for UI rendering
  // 0 = just started hold, 1 = hold complete. null = not currently holding.
  private holdStartTime: number | null = null;

  constructor(config: MicConfig) {
    this.config = config;
    // Publish initial values so subscribers see something immediately.
    inputBus.publish("MicVolume", 0);
    inputBus.publish("MicState", null);
    inputBus.publish("MicPhoneme", null);
    inputBus.publish("MicHoldProgress", null);
  }

  isRunning(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    source.connect(this.analyser);
    this.tick();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.currentState = null;
    this.holdEndTime = null;
    this.holdStartTime = null;
    this.currentPhoneme = null;
    this.phonemeSwitchedAt = 0;
    inputBus.publish("MicVolume", 0);
    inputBus.publish("MicState", null);
    inputBus.publish("MicPhoneme", null);
    inputBus.publish("MicHoldProgress", null);
  }

  updateConfig(config: MicConfig): void {
    this.config = config;
    // If the current state's threshold was renamed/removed, clear it so we
    // don't publish a stale name.
    if (
      this.currentState !== null &&
      !config.thresholds.find((t) => t.name === this.currentState)
    ) {
      this.currentState = null;
      this.holdEndTime = null;
      this.holdStartTime = null;
    }
  }

  private tick = (): void => {
    if (!this.analyser) return;

    const volume = this.computeVolume();
    inputBus.publish("MicVolume", volume);

    const newState = this.computeState(volume);
    inputBus.publish("MicState", newState);

    // Hold timer progress for the UI
    if (this.holdStartTime !== null && this.holdEndTime !== null) {
      const total = this.holdEndTime - this.holdStartTime;
      const elapsed = performance.now() - this.holdStartTime;
      inputBus.publish("MicHoldProgress", Math.min(1, elapsed / total));
    } else {
      inputBus.publish("MicHoldProgress", null);
    }

    if (this.config.phonemesEnabled && newState !== null && volume > 0.02) {
      // Each threshold can opt out of phonemes (undefined === true for
      // backward compat).
      const currentThreshold = this.config.thresholds.find(
        (t) => t.name === newState,
      );
      const wantsPhonemes = currentThreshold?.phonemes !== false;
      if (wantsPhonemes) {
        const phoneme = this.detectPhoneme();
        inputBus.publish("MicPhoneme", phoneme);
      } else {
        // Reset detection state so resuming a phoneme-enabled state doesn't
        // start with stale memory.
        this.currentPhoneme = null;
        this.phonemeSwitchedAt = 0;
        inputBus.publish("MicPhoneme", null);
      }
    } else {
      this.currentPhoneme = null;
      this.phonemeSwitchedAt = 0;
      inputBus.publish("MicPhoneme", null);
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private computeVolume(): number {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);

    // RMS of zero-centered signal (samples are 0..255, center 128).
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    // Speaking RMS is typically 0.05–0.3; scale up so 0.5 RMS reads as 1.0.
    return Math.min(1, rms * 2);
  }

  private computeState(volume: number): string | null {
    const sorted = [...this.config.thresholds].sort(
      (a, b) => a.minVolume - b.minVolume,
    );

    // Highest threshold currently satisfied by the volume.
    let satisfied: MicThreshold | null = null;
    for (const t of sorted) {
      if (volume >= t.minVolume) satisfied = t;
    }

    const currentThreshold =
      this.currentState !== null
        ? sorted.find((t) => t.name === this.currentState)
        : null;
    const currentIdx = currentThreshold ? sorted.indexOf(currentThreshold) : -1;
    const satisfiedIdx = satisfied ? sorted.indexOf(satisfied) : -1;

    // Going up: snap to the new state if it's at least as high as current.
    if (satisfied && satisfiedIdx >= currentIdx) {
      this.currentState = satisfied.name;
      this.holdEndTime = null;
      this.holdStartTime = null;
      return this.currentState;
    }

    // We're either at no threshold, or volume is below the active threshold.
    // If the active threshold is still satisfied (e.g. equal), no decay.
    if (currentThreshold && volume >= currentThreshold.minVolume) {
      this.holdEndTime = null;
      this.holdStartTime = null;
      return this.currentState;
    }

    // Decay path. Start hold timer if not already running.
    if (this.currentState !== null && currentThreshold) {
      const now = performance.now();
      if (this.holdEndTime === null) {
        this.holdStartTime = now;
        this.holdEndTime = now + currentThreshold.holdMs;
      }
      if (now >= this.holdEndTime) {
        this.currentState = null;
        this.holdEndTime = null;
        this.holdStartTime = null;
      }
    }

    return this.currentState;
  }

  private detectPhoneme(): Phoneme | null {
    if (!this.analyser || !this.audioContext) return null;

    const freqData = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(freqData);

    const sampleRate = this.audioContext.sampleRate;
    const binSize = sampleRate / this.analyser.fftSize;

    let f1 = 0;
    let f1Mag = -Infinity;
    let f2 = 0;
    let f2Mag = -Infinity;

    for (let i = 0; i < freqData.length; i++) {
      const hz = i * binSize;
      const mag = freqData[i];
      if (hz >= F1_RANGE[0] && hz <= F1_RANGE[1] && mag > f1Mag) {
        f1Mag = mag;
        f1 = hz;
      }
      if (hz >= F2_RANGE[0] && hz <= F2_RANGE[1] && mag > f2Mag) {
        f2Mag = mag;
        f2 = hz;
      }
    }

    // Below the noise floor: silence. Reset detection state.
    if (f1Mag < FORMANT_NOISE_FLOOR_DB || f2Mag < FORMANT_NOISE_FLOOR_DB) {
      this.currentPhoneme = null;
      return null;
    }

    // Compute distance from current formants to every vowel centroid in
    // normalized F1/F2 space. Sort ascending — distances[0] is the raw nearest.
    const distances = VOWEL_CENTROIDS.map((v) => {
      const dx = (f1 - v.f1) / 500;
      const dy = (f2 - v.f2) / 1000;
      return { name: v.name, dist: dx * dx + dy * dy };
    }).sort((a, b) => a.dist - b.dist);

    const nearest = distances[0];
    const now = performance.now();

    // First detection (or just resumed after silence): take nearest.
    if (this.currentPhoneme === null) {
      this.currentPhoneme = nearest.name;
      this.phonemeSwitchedAt = now;
      return this.currentPhoneme;
    }

    // Just switched? Hold for the minimum window before considering a change.
    if (now - this.phonemeSwitchedAt < PHONEME_MIN_HOLD_MS) {
      return this.currentPhoneme;
    }

    // Hysteresis: only switch if the new candidate is meaningfully closer than
    // where we already are. "Meaningfully" = (nearest.dist) < (current.dist × STICKINESS).
    if (nearest.name !== this.currentPhoneme) {
      const currentDist =
        distances.find((d) => d.name === this.currentPhoneme)?.dist ?? Infinity;
      if (nearest.dist < currentDist * PHONEME_STICKINESS) {
        this.currentPhoneme = nearest.name;
        this.phonemeSwitchedAt = now;
      }
    }

    return this.currentPhoneme;
  }
}

// We export the class for tests, but normal usage goes through the singleton
// which is initialized by the React layer with current config.
export { MicSource };

let micSingleton: MicSource | null = null;
export function getMicSource(initialConfig: MicConfig): MicSource {
  if (!micSingleton) micSingleton = new MicSource(initialConfig);
  return micSingleton;
}

/** Used during dev/HMR to fully reset the singleton. */
export function resetMicSource(): void {
  micSingleton?.stop();
  micSingleton = null;
}

// Re-export the supported phoneme list for UI affordances.
export { PHONEMES };
