// Heart-rate input source — Web Bluetooth + BLE Heart Rate Service.
//
// Pipeline (after the user clicks "Connect"):
//   navigator.bluetooth.requestDevice({heart_rate})
//     → device.gatt.connect()
//     → service(0x180D).characteristic(0x2A37).startNotifications()
//     → 'characteristicvaluechanged' DataView → parse → publish
//
// Channels published:
//   HeartRate        — number, current BPM (typically 40..200). Null
//                      when not connected. Updated at the rate the
//                      sensor decides (most BLE HR straps: 1 Hz).
//   HeartRateActive  — boolean, true while connected AND receiving
//                      packets. Useful for "show this sprite while my
//                      heart-rate strap is live" gates.
//
// Why expose raw BPM and not 0..1? Different rigs care about different
// ranges — a chill ASMR streamer's "elevated" might be 90 bpm, a Just
// Chatting streamer's "elevated" might be 130. Linear bindings handle
// the mapping cleanly (`HeartRate inMin=60 inMax=180 outMin=0 outMax=1`),
// and stateMap bindings can do "below 80 → calm, above 140 → panic"
// thresholds. No reason to flatten the signal.
//
// Permissions: `navigator.bluetooth.requestDevice()` REQUIRES a user
// gesture — cannot be auto-called on app boot. The connect flow is
// gated behind a button click in the StatusBar. Subsequent connections
// (after a disconnect) also need a user gesture per spec, though
// browsers are lenient when reconnecting to a recently-paired device.
//
// Disconnection: we listen for `gattserverdisconnected` on the device.
// HR straps drop frequently (out of range, low battery, sweat shorting
// the contacts) — we publish HeartRateActive=false and HeartRate=null
// on disconnect, leaving the binding chain in a clean "no signal"
// state. The user can click Connect again to re-pair.
//
// BLE flag byte layout (per Heart Rate Measurement spec, 0x2A37):
//   bit 0: HR value format — 0 = uint8 (1 byte), 1 = uint16 (2 bytes)
//   bit 1-2: sensor contact status (skin contact)
//   bit 3: energy expended field present
//   bit 4: RR-interval field(s) present
// We only consume bit 0 — the rest are useful for fitness apps but
// don't add expressive value to a PNGTuber rig.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

/** GATT service / characteristic UUIDs from the Bluetooth SIG spec. */
const HEART_RATE_SERVICE = 0x180d;
const HEART_RATE_MEASUREMENT_CHAR = 0x2a37;

export const HEART_RATE_CHANNELS = ["HeartRate", "HeartRateActive"] as const;

export type HeartRateConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface HeartRateConnectionInfo {
  state: HeartRateConnectionState;
  /** Device name from the BLE advertisement, e.g. "Polar H10 ABCD". */
  deviceName: string | null;
  /** Most recent error message, set when state === "error". */
  error: string | null;
}

class HeartRateSource {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private state: HeartRateConnectionState = "disconnected";
  private deviceName: string | null = null;
  private lastError: string | null = null;
  private connectionListeners = new Set<
    (info: HeartRateConnectionInfo) => void
  >();
  /** Bound handler refs so we can remove them on disconnect. */
  private onValueChanged = (e: Event): void => this.handleMeasurement(e);
  private onGattDisconnected = (): void => this.handleGattDisconnected();

  constructor() {
    for (const c of HEART_RATE_CHANNELS) inputBus.publish(c, null);
  }

  destroy(): void {
    this.disconnect().catch(() => {
      // swallow — destroy is best-effort
    });
    this.connectionListeners.clear();
    for (const c of HEART_RATE_CHANNELS) inputBus.publish(c, null);
  }

  subscribeConnection(
    listener: (info: HeartRateConnectionInfo) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.bluetooth !== "undefined" &&
      typeof navigator.bluetooth.requestDevice === "function"
    );
  }

  /** User-initiated connect. Opens the OS Bluetooth device picker, then
   *  wires up notifications. Throws nothing — errors flow through the
   *  connection-state listener. Must be called from a user gesture
   *  (click handler) per Web Bluetooth spec. */
  async connect(): Promise<void> {
    if (!this.isSupported()) {
      this.setState("error", null, "Web Bluetooth not available in this build");
      return;
    }
    if (this.state === "connecting" || this.state === "connected") return;

    this.setState("connecting", null, null);
    try {
      // `filters` restricts the picker to advertisers offering the HR
      // service — keeps the dialog from listing every BLE thing in
      // range. `optionalServices` would be needed to access additional
      // services beyond HR, but we don't need any.
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }],
      });
      this.device = device;
      this.deviceName = device.name ?? "Heart Rate Monitor";
      device.addEventListener(
        "gattserverdisconnected",
        this.onGattDisconnected,
      );

      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(HEART_RATE_SERVICE);
      const char = await service.getCharacteristic(
        HEART_RATE_MEASUREMENT_CHAR,
      );
      this.characteristic = char;
      char.addEventListener("characteristicvaluechanged", this.onValueChanged);
      await char.startNotifications();

      this.setState("connected", this.deviceName, null);
      inputBus.publish("HeartRateActive", true);
    } catch (e) {
      // User-cancel from the picker shows up as an error too — present
      // it the same way (state = error with the message), then settle
      // back to disconnected so the next click re-opens the picker.
      const msg = e instanceof Error ? e.message : "Unknown error";
      this.cleanupDevice();
      this.setState("error", null, msg);
      // Settle to disconnected after a tick so the UI can show the
      // error briefly without sticking.
      window.setTimeout(() => {
        if (this.state === "error") this.setState("disconnected", null, null);
      }, 4000);
    }
  }

  async disconnect(): Promise<void> {
    if (this.characteristic) {
      try {
        await this.characteristic.stopNotifications();
      } catch {
        // ignore — already disconnected
      }
      this.characteristic.removeEventListener(
        "characteristicvaluechanged",
        this.onValueChanged,
      );
    }
    this.cleanupDevice();
    inputBus.publish("HeartRate", null);
    inputBus.publish("HeartRateActive", false);
    this.setState("disconnected", null, null);
  }

  private cleanupDevice(): void {
    if (this.device) {
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.onGattDisconnected,
      );
      // Best-effort hard disconnect — the spec keeps the GATT
      // connection alive across page sessions otherwise, which is
      // surprising behavior.
      try {
        this.device.gatt?.disconnect();
      } catch {
        // ignore
      }
    }
    this.device = null;
    this.characteristic = null;
  }

  private handleGattDisconnected(): void {
    this.cleanupDevice();
    inputBus.publish("HeartRate", null);
    inputBus.publish("HeartRateActive", false);
    this.setState("disconnected", null, null);
  }

  private handleMeasurement(e: Event): void {
    if (useSettings.getState().inputPaused) return;
    const target = e.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    // Heart Rate Measurement: byte 0 = flags, then HR value (uint8 or
    // uint16 depending on flag bit 0). Subsequent fields are optional
    // and we don't consume them.
    const flags = value.getUint8(0);
    const is16Bit = (flags & 0x01) !== 0;
    let bpm: number;
    if (is16Bit) {
      // little-endian per BLE convention.
      bpm = value.getUint16(1, true);
    } else {
      bpm = value.getUint8(1);
    }
    inputBus.publish("HeartRate", bpm);
    inputBus.publish("HeartRateActive", true);
  }

  private setState(
    state: HeartRateConnectionState,
    deviceName: string | null,
    error: string | null,
  ): void {
    this.state = state;
    this.deviceName = deviceName;
    this.lastError = error;
    const snap = this.snapshot();
    for (const l of this.connectionListeners) l(snap);
  }

  private snapshot(): HeartRateConnectionInfo {
    return {
      state: this.state,
      deviceName: this.deviceName,
      error: this.lastError,
    };
  }
}

let heartRateSingleton: HeartRateSource | null = null;
export function getHeartRateSource(): HeartRateSource {
  if (!heartRateSingleton) heartRateSingleton = new HeartRateSource();
  return heartRateSingleton;
}

export function resetHeartRateSource(): void {
  heartRateSingleton?.destroy();
  heartRateSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetHeartRateSource());
}
