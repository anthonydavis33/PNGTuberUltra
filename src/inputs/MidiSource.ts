// MIDI input source — Web MIDI API.
//
// Pipeline (per MIDI message from any connected input device):
//   navigator.requestMIDIAccess() → MIDIAccess
//                                 → MIDIInput.onmidimessage
//                                 → parse status byte → publish to InputBus
//
// MIDI is fundamentally heterogeneous — a 25-key keyboard, an 8-knob
// pad controller, and a foot controller all speak the same protocol but
// expose wildly different surfaces. We avoid pre-declaring 128 CC × 16
// channel × N noteNumber channels (which would explode the binding
// picker into noise) by publishing channels DYNAMICALLY: a channel only
// appears in the bus once that exact CC / note has been touched.
//
// Channels published:
//
// Dynamic (materialize on first use):
//   MidiCC{N}     — N in 0..127, value 0..1 normalized from raw 0..127.
//                   E.g. CC74 (filter cutoff on most synths) becomes
//                   `MidiCC74` after the user wiggles the knob once.
//   MidiNote{N}   — boolean while note N is held. N is the MIDI note
//                   number (0..127, middle C = 60). Once a note has
//                   fired, its channel persists on the bus for binding.
//
// Always-available (published as null until first MIDI activity):
//   MidiCCAny     — last CC value received, 0..1. Single channel that
//                   updates on EVERY CC, regardless of controller —
//                   useful for "react to ANY knob movement" gates.
//   MidiCCNumber  — controller number (0..127) of the last CC. Pair
//                   with MidiCCAny in a stateMap for "if knob 7, do X".
//   MidiNoteAny   — last note number played, 0..127. Same any-note
//                   pattern as MidiCCAny.
//   MidiVelocity  — velocity of the last note, 0..1.
//   MidiNoteOn    — boolean, true while ANY note is held. Useful for
//                   visibility gates ("show this sprite while playing").
//   MidiPitchBend — -1..1, signed pitch wheel. Center = 0, fully bent
//                   ±1.
//   MidiAftertouch — 0..1, channel pressure (whole-keyboard aftertouch
//                   on synths that support it).
//
// Why two layers? The "Any" channels give zero-config rigs ("flash
// when I play any key"). The dynamic per-CC / per-note channels give
// precise control ("CC74 drives head rotation, CC1 drives mouth open").
// Most users will start with the Any channels and graduate to specific
// controllers as their rig grows.
//
// Permissions: `navigator.requestMIDIAccess()` triggers a browser
// permission prompt the first time. Tauri 2 webview honors the same
// prompt. Denied access → source stays in "no MIDI" state with no
// channels published; bindings against MIDI channels just stay null.
//
// Hot-plugging: MIDIAccess.onstatechange fires when devices connect /
// disconnect. We bind onmidimessage on every connected input on
// construction AND on each onstatechange so newly-plugged devices
// start delivering events without a restart.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

/** Always-published top-level channels (null until first MIDI activity). */
export const MIDI_BASE_CHANNELS = [
  "MidiCCAny",
  "MidiCCNumber",
  "MidiNoteAny",
  "MidiVelocity",
  "MidiNoteOn",
  "MidiPitchBend",
  "MidiAftertouch",
] as const;

/** MIDI message status byte high-nibble values. Lower nibble is channel
 *  (0-15) which we ignore — bindings care about the controller, not
 *  which channel of the device it's transmitting on. */
const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_AFTERTOUCH = 0xa0; // poly aftertouch — per-note pressure
const STATUS_CC = 0xb0;
// const STATUS_PROGRAM_CHANGE = 0xc0;  // unused in v1 — most controllers don't send these
const STATUS_CHANNEL_PRESSURE = 0xd0; // channel-wide aftertouch
const STATUS_PITCH_BEND = 0xe0;

/** Convert MIDI 0..127 to 0..1. */
function n7to01(v: number): number {
  return v / 127;
}

/** Convert MIDI pitch bend (14-bit, 0..16383, center=8192) to -1..1. */
function pitchBendTo01(lsb: number, msb: number): number {
  const raw = (msb << 7) | lsb; // 0..16383
  return (raw - 8192) / 8192;
}

class MidiSource {
  private access: MIDIAccess | null = null;
  /** Set of channel names we've published at least once. The binding
   *  picker uses this to enumerate dynamic channels (MidiCC74,
   *  MidiNote60, etc.) without us having to pre-declare all 256. */
  private seenChannels = new Set<string>();
  /** Currently-held notes — used to derive MidiNoteOn. A note can fire
   *  Note On then Note On again with velocity 0 (which is equivalent to
   *  Note Off in some controllers); we treat both paths the same. */
  private heldNotes = new Set<number>();
  /** Bound message handler per input — we keep the references so we can
   *  unbind on destroy. Map key is the input's id; value is the handler. */
  private inputHandlers = new Map<string, (e: MIDIMessageEvent) => void>();
  /** Connection-state listeners for the StatusBar. */
  private connectionListeners = new Set<(info: MidiConnectionInfo) => void>();

  constructor() {
    for (const c of MIDI_BASE_CHANNELS) {
      inputBus.publish(c, null);
      this.seenChannels.add(c);
    }
    this.requestAccess();
  }

  destroy(): void {
    if (this.access) {
      // Unbind from every input we attached to.
      for (const [id, handler] of this.inputHandlers) {
        const input = this.access.inputs.get(id);
        if (input) input.onmidimessage = null;
        void handler; // reference for clarity
      }
      this.access.onstatechange = null;
    }
    this.inputHandlers.clear();
    this.heldNotes.clear();
    this.connectionListeners.clear();
    for (const c of this.seenChannels) inputBus.publish(c, null);
    this.seenChannels.clear();
    this.access = null;
  }

  /** Subscribe to connection state changes (device list + permission). */
  subscribeConnection(
    listener: (info: MidiConnectionInfo) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.snapshotConnection());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /** List of channels the source has published at least once. The
   *  binding picker calls this to enumerate dynamic CC / Note channels
   *  alongside the always-on `MidiCCAny` etc. */
  getActiveChannels(): string[] {
    return Array.from(this.seenChannels).sort();
  }

  private snapshotConnection(): MidiConnectionInfo {
    if (!this.access) {
      return { permission: "unknown", devices: [] };
    }
    const devices: string[] = [];
    for (const input of this.access.inputs.values()) {
      if (input.state === "connected") {
        devices.push(input.name ?? input.id);
      }
    }
    return { permission: "granted", devices };
  }

  private notifyConnection(): void {
    const info = this.snapshotConnection();
    for (const l of this.connectionListeners) l(info);
  }

  private async requestAccess(): Promise<void> {
    // Some browsers / WebView2 builds don't expose Web MIDI at all —
    // guard with a feature check to avoid a hard crash on unsupported
    // platforms.
    if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) {
      for (const l of this.connectionListeners) {
        l({ permission: "unsupported", devices: [] });
      }
      return;
    }
    try {
      // sysex: false — we don't need raw SysEx messages, and the
      // permission prompt is more lenient without it.
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      for (const l of this.connectionListeners) {
        l({ permission: "denied", devices: [] });
      }
      return;
    }
    // Bind to each currently-connected input.
    for (const input of this.access.inputs.values()) {
      this.bindInput(input);
    }
    // Watch for hot-plug events. `e.port` can be null on some browser
    // implementations (event objects fired during teardown sometimes
    // lack the port reference); we just resync the device list in that
    // case rather than trying to bind/unbind a specific input.
    this.access.onstatechange = (e) => {
      const port = e.port;
      if (port && port.type === "input") {
        if (port.state === "connected") {
          this.bindInput(port as MIDIInput);
        } else {
          this.unbindInput(port as MIDIInput);
        }
      }
      this.notifyConnection();
    };
    this.notifyConnection();
  }

  private bindInput(input: MIDIInput): void {
    if (this.inputHandlers.has(input.id)) return;
    const handler = (e: MIDIMessageEvent): void => this.onMidiMessage(e);
    input.onmidimessage = handler;
    this.inputHandlers.set(input.id, handler);
  }

  private unbindInput(input: MIDIInput): void {
    input.onmidimessage = null;
    this.inputHandlers.delete(input.id);
  }

  private onMidiMessage(e: MIDIMessageEvent): void {
    if (useSettings.getState().inputPaused) return;
    const data = e.data;
    if (!data || data.length < 1) return;
    // Status byte: high nibble = command, low nibble = MIDI channel.
    // Mask off channel since we treat all channels as one stream.
    const status = data[0]! & 0xf0;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;

    switch (status) {
      case STATUS_NOTE_ON: {
        // Velocity 0 with NoteOn === NoteOff per MIDI spec convention.
        // Some controllers (older ones, especially) only send NoteOn
        // with vel=0 for releases; we normalize both paths here.
        if (d2 === 0) {
          this.handleNoteOff(d1);
        } else {
          this.handleNoteOn(d1, d2);
        }
        break;
      }
      case STATUS_NOTE_OFF: {
        this.handleNoteOff(d1);
        break;
      }
      case STATUS_CC: {
        const value = n7to01(d2);
        this.publishChannel(`MidiCC${d1}`, value);
        this.publishChannel("MidiCCAny", value);
        this.publishChannel("MidiCCNumber", d1);
        break;
      }
      case STATUS_PITCH_BEND: {
        this.publishChannel("MidiPitchBend", pitchBendTo01(d1, d2));
        break;
      }
      case STATUS_CHANNEL_PRESSURE: {
        // Channel pressure is a single data byte (d1), not d2 like CC.
        this.publishChannel("MidiAftertouch", n7to01(d1));
        break;
      }
      case STATUS_AFTERTOUCH: {
        // Poly aftertouch — per-note pressure. We don't publish
        // per-note channels for it (would double the channel count
        // for what's an extremely niche feature). Fall through to
        // MidiAftertouch for the pressure value as a useful proxy.
        this.publishChannel("MidiAftertouch", n7to01(d2));
        break;
      }
      default:
        // System / clock / sysex etc — ignore.
        break;
    }
  }

  private handleNoteOn(note: number, velocity: number): void {
    this.heldNotes.add(note);
    this.publishChannel(`MidiNote${note}`, true);
    this.publishChannel("MidiNoteOn", true);
    this.publishChannel("MidiNoteAny", note);
    this.publishChannel("MidiVelocity", n7to01(velocity));
  }

  private handleNoteOff(note: number): void {
    this.heldNotes.delete(note);
    this.publishChannel(`MidiNote${note}`, false);
    if (this.heldNotes.size === 0) {
      this.publishChannel("MidiNoteOn", false);
    }
  }

  private publishChannel(channel: string, value: number | boolean): void {
    if (!this.seenChannels.has(channel)) {
      this.seenChannels.add(channel);
      // First publish of a brand-new dynamic channel — notify connection
      // subscribers so the binding picker knows to refresh its dropdown.
      // (Cheap to over-notify; the StatusBar's subscriber is idempotent.)
      this.notifyConnection();
    }
    inputBus.publish(channel, value);
  }
}

export interface MidiConnectionInfo {
  permission: "granted" | "denied" | "unsupported" | "unknown";
  /** Names of currently-connected MIDI input devices. */
  devices: string[];
}

let midiSingleton: MidiSource | null = null;
export function getMidiSource(): MidiSource {
  if (!midiSingleton) midiSingleton = new MidiSource();
  return midiSingleton;
}

export function resetMidiSource(): void {
  midiSingleton?.destroy();
  midiSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetMidiSource());
}
