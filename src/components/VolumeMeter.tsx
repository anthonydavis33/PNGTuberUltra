// Interactive volume meter for the StatusBar's mic section.
//
// More than a passive readout — this is the canonical place to see
// AND tune mic thresholds. Each threshold renders a colored band
// across the bar (dulled until volume crosses it, saturated above)
// plus a draggable marker pinned at the threshold's minVolume. A
// thin "hold tail" trails right of each marker, width proportional
// to holdMs, draggable on its right edge to retune hold time without
// opening the popover.
//
// When the mic isn't running, the bar accepts pointer input as a
// simulated volume — push your cursor across the bar and you'll see
// thresholds activate exactly the way they would with real audio.
// MicSource.publishSimulated handles the bus + state-machine side;
// this component is the input surface.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveThresholdColor,
  type MicThreshold,
} from "../types/avatar";
import { getMicSource } from "../inputs/MicSource";

/** Hold-time scale for the marker tail. holdMs of HOLD_FULL_SCALE_MS
 *  takes the full meter width as the tail length; values above are
 *  clamped to 100% width for display, but the underlying number can
 *  still grow via the popover. 500ms covers the common 50–300ms band
 *  with room to spare without making short holds invisible. */
const HOLD_FULL_SCALE_MS = 500;

/** Maximum holdMs the on-bar drag will set. Beyond this, users have
 *  to type a value into the popover. Matches the popover's <input
 *  max>. */
const HOLD_MAX_MS = 2000;

interface VolumeMeterProps {
  /** Current MicVolume value (0..1). Driven by MicSource — either real
   *  audio when mic is running, or simulated when we're driving it. */
  volume: number;
  /** Sorted ascending by minVolume. Caller is responsible for sorting
   *  so band drawing assumes the order is already correct. */
  thresholds: MicThreshold[];
  /** Name of the currently-active MicState (or null when no threshold
   *  is satisfied). Drives the active fill's color. */
  activeStateName: string | null;
  /** Patch dispatcher for any threshold field. */
  onUpdateThreshold: (id: string, patch: Partial<MicThreshold>) => void;
  /** True while a real mic stream is publishing. When false, the meter
   *  becomes interactive — pointerdown + drag publishes simulated
   *  volume so users can test thresholds without speaking. */
  isMicRunning: boolean;
}

/** Convert hex color "#RRGGBB" → rgba string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

type DragKind =
  | { kind: "volume"; thresholdId: string }
  | { kind: "hold"; thresholdId: string }
  | { kind: "simulate" };

export function VolumeMeter({
  volume,
  thresholds,
  activeStateName,
  onUpdateThreshold,
  isMicRunning,
}: VolumeMeterProps) {
  const meterRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragKind | null>(null);

  // Compute the meter rect lazily inside event handlers so a window
  // resize between drag-start and drag-move doesn't see stale values.
  const fractionFromClientX = useCallback((clientX: number): number => {
    const el = meterRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  // Window-level pointermove + pointerup so a drag that exits the
  // meter doesn't get stuck. Same pattern PixiApp uses for sprite
  // drags. Only attached while a drag is in flight.
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent): void => {
      const f = fractionFromClientX(e.clientX);
      if (drag.kind === "volume") {
        onUpdateThreshold(drag.thresholdId, { minVolume: f });
      } else if (drag.kind === "hold") {
        const t = thresholds.find((t) => t.id === drag.thresholdId);
        if (!t) return;
        // Hold tail extends right of the marker. Drag distance from
        // marker = fraction of meter width; at 100% that maps to
        // HOLD_FULL_SCALE_MS. Clamp upward at HOLD_MAX_MS for
        // sanity (popover input has the same cap).
        const tailFraction = Math.max(0, f - t.minVolume);
        const ms = Math.round(
          Math.min(HOLD_MAX_MS, tailFraction * HOLD_FULL_SCALE_MS),
        );
        onUpdateThreshold(drag.thresholdId, { holdMs: ms });
      } else if (drag.kind === "simulate") {
        getMicSource().publishSimulated(f);
      }
    };

    const onUp = (): void => {
      if (drag.kind === "simulate") {
        // Hand off to the decay loop in MicSource — keeps ticking
        // volume=0 through the state machine until state falls to
        // null naturally, so the hold-meter animates the way it
        // does with a real mic.
        getMicSource().startSimDecay();
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, fractionFromClientX, onUpdateThreshold, thresholds]);

  const onMeterPointerDown = (e: React.PointerEvent): void => {
    // Only kick off simulation when the click landed on the meter
    // background — markers + handles stopPropagation in their own
    // handlers so they take priority. Mic must be off; with a real
    // stream running we'd be stomping on live audio.
    if (isMicRunning) return;
    const f = fractionFromClientX(e.clientX);
    getMicSource().publishSimulated(f);
    setDrag({ kind: "simulate" });
  };

  // Active threshold color — drives the fill. Falls back to a neutral
  // accent when no state is active so the fill stays visible at sub-
  // threshold volumes.
  const activeIdx = thresholds.findIndex(
    (t) => t.name === activeStateName,
  );
  const activeColor =
    activeIdx >= 0
      ? resolveThresholdColor(thresholds[activeIdx], activeIdx)
      : "#5a8";

  const tooltip = isMicRunning
    ? `Volume ${volume.toFixed(2)} — drag a marker dot to retune its threshold; drag the small handle on the tail to retune its hold time.`
    : `Mic off — click + drag the meter to simulate volume. Drag a marker dot to retune; drag a tail handle to retune hold.`;

  return (
    <div
      ref={meterRef}
      className={`volume-meter ${!isMicRunning ? "sim-mode" : ""}`}
      title={tooltip}
      aria-label="Microphone volume meter"
      onPointerDown={onMeterPointerDown}
    >
      {/* Background bands — one per threshold, spanning from this
          threshold's minVolume to the next threshold's minVolume (or
          the right edge). Dulled by default; saturated when the
          current volume has crossed this threshold's left edge. */}
      {thresholds.map((t, i) => {
        const left = t.minVolume;
        const right = thresholds[i + 1]?.minVolume ?? 1;
        const baseColor = resolveThresholdColor(t, i);
        const lit = volume >= t.minVolume;
        return (
          <div
            key={`band-${t.id}`}
            className="volume-meter-band"
            style={{
              left: `${left * 100}%`,
              width: `${Math.max(0, (right - left) * 100)}%`,
              background: hexToRgba(baseColor, lit ? 0.55 : 0.18),
            }}
          />
        );
      })}

      {/* Volume fill — semi-transparent foreground that grows with
          MicVolume, colored by the active threshold (or neutral when
          below all thresholds). Floats on top of bands so the
          currently-inhabited band reads at a glance. */}
      <div
        className="volume-meter-fill"
        style={{
          width: `${Math.round(volume * 100)}%`,
          background: hexToRgba(activeColor, 0.85),
        }}
      />

      {/* Hold tails — thin horizontal stripes below each marker.
          Width = holdMs / HOLD_FULL_SCALE_MS as a fraction of meter
          width. Right edge carries a draggable handle. Rendered as
          siblings of the meter rather than children of a marker-
          group because the marker-group's left+width-0 frame would
          force the tail width math through pixel calculations.
          Sibling-positioned tails inherit the meter's width directly. */}
      {thresholds.map((t, i) => {
        const tailFraction = Math.min(1, t.holdMs / HOLD_FULL_SCALE_MS);
        const left = t.minVolume;
        const width = Math.max(0, Math.min(1 - left, tailFraction));
        const color = resolveThresholdColor(t, i);
        return (
          <div
            key={`tail-${t.id}`}
            className="volume-meter-hold-tail"
            style={{
              left: `${left * 100}%`,
              width: `${width * 100}%`,
              background: hexToRgba(color, 0.45),
            }}
            title={`${t.name}: hold ${t.holdMs}ms — drag the handle to retune`}
          >
            {/* Drag handle on the right edge of the tail. */}
            <div
              className="volume-meter-hold-handle"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({ kind: "hold", thresholdId: t.id });
              }}
              style={{ background: color }}
            />
          </div>
        );
      })}

      {/* Threshold markers — vertical line spanning the bar's height
          + grab dot at the top. Drag dot horizontally → minVolume. */}
      {thresholds.map((t, i) => {
        const color = resolveThresholdColor(t, i);
        return (
          <div
            key={`marker-${t.id}`}
            className="volume-meter-marker"
            style={{
              left: `${t.minVolume * 100}%`,
              background: color,
            }}
          >
            <div
              className="volume-meter-marker-handle"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDrag({ kind: "volume", thresholdId: t.id });
              }}
              style={{ background: color }}
              title={`${t.name}: ${t.minVolume.toFixed(2)} — drag horizontally to retune`}
            />
          </div>
        );
      })}
    </div>
  );
}
