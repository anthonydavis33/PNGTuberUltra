// Unreal/Blender-style number input. Three ways to change the value:
//   1. Drag the label horizontally to scrub (Shift = 10x, Ctrl/Alt = 0.1x)
//   2. Click into the input and type, including partial states like "-" or ""
//   3. Native browser up/down arrow keys (or spinner)
//
// Local string state is the source of truth for what's *displayed* in the
// input. The store is updated only when the typed string parses to a finite
// number — so partial states never reach the model. On blur, an unparseable
// string snaps back to the formatted store value.

import { useEffect, useRef, useState } from "react";

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Decimal places to display. Default 1. */
  precision?: number;
  /** Base value-per-pixel when drag-scrubbing the label. Default 1. */
  step?: number;
}

const formatNumber = (v: number, precision: number): string =>
  v.toFixed(precision);

export function NumberField({
  label,
  value,
  onChange,
  precision = 1,
  step = 1,
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState(() => formatNumber(value, precision));
  const [isDragging, setIsDragging] = useState(false);

  // Sync local string from prop when the store updates externally
  // (e.g. user drags the sprite on the canvas) — but only when the user
  // isn't currently editing this field.
  useEffect(() => {
    if (isDragging) return;
    if (document.activeElement === inputRef.current) return;
    setLocal(formatNumber(value, precision));
  }, [value, precision, isDragging]);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = e.target.value;
    setLocal(s);
    const v = parseFloat(s);
    if (!Number.isNaN(v) && Number.isFinite(v)) {
      onChange(v);
    }
    // Otherwise: keep showing what user typed, don't touch the store.
  };

  const onInputBlur = () => {
    const v = parseFloat(local);
    if (Number.isNaN(v) || !Number.isFinite(v)) {
      // Invalid — snap back to the actual store value.
      setLocal(formatNumber(value, precision));
    } else {
      // Valid — re-format to canonical precision.
      setLocal(formatNumber(v, precision));
    }
  };

  const onLabelPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startVal = value;

    const onMove = (ev: PointerEvent) => {
      const mod = ev.shiftKey ? 10 : ev.altKey || ev.ctrlKey ? 0.1 : 1;
      const dx = ev.clientX - startX;
      const newVal = startVal + dx * step * mod;
      onChange(newVal);
      setLocal(formatNumber(newVal, precision));
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="number-field">
      <span
        className="number-field-label"
        onPointerDown={onLabelPointerDown}
        title="Drag to scrub · Shift = 10× · Ctrl/Alt = 0.1×"
      >
        {label}
      </span>
      <input
        ref={inputRef}
        type="number"
        value={local}
        onChange={onInputChange}
        onBlur={onInputBlur}
        step={step}
      />
    </div>
  );
}

/**
 * Display-curved variant for damping-style fields where the
 * underlying physics quantity decays exponentially. The
 * "fraction of velocity retained per second" used by the chain
 * simulator + Pendulum modifier maps non-intuitively to a linear
 * slider — most of the useful range (settle in ~1-3s) lives in
 * the slider's first 30%, and everything above 0.3 feels like
 * "still bouncy" because the settle time grows multiplicatively.
 *
 * This wrapper applies a cubic curve in the UI:
 *   stored = displayed^3
 *   displayed = stored^(1/3)
 *
 * Net effect: the slider 0..1 distributes the practical range
 * roughly evenly:
 *   slider 0.3 → stored 0.027 → settles ~0.6s (heavy)
 *   slider 0.5 → stored 0.125 → settles ~1.5s (lively)
 *   slider 0.7 → stored 0.343 → settles ~3s (moderate)
 *   slider 0.85 → stored 0.614 → settles ~7s (floaty)
 *   slider 1.0 → stored 1 → perpetual
 *
 * Storage stays in the existing "fraction-retained-per-second"
 * convention — the runtime simulator is unchanged. Existing
 * rigs keep their stored damping unchanged; the UI just displays
 * the cube root of the value, which lands close to where users
 * dialed it in (their preferred 0.1-0.3 range now displays as
 * 0.46-0.67, comfortable mid-slider territory).
 */
export function NumberFieldDamping(props: NumberFieldProps) {
  const stored = Math.max(0, Math.min(1, props.value));
  const displayed = Math.pow(stored, 1 / 3);
  return (
    <NumberField
      {...props}
      value={displayed}
      onChange={(v) => {
        const clamped = Math.max(0, Math.min(1, v));
        props.onChange(Math.pow(clamped, 3));
      }}
    />
  );
}

/**
 * Display-flipped variant for Y-as-pixel-offset fields. Internals use
 * Pixi's canonical (+Y down) convention for sprite positions, pose
 * offsets, anchor offsets, corner offsets, and binding outputs that
 * target Y. The user's intuitive mental model is +Y up. Rather than
 * flipping storage everywhere (which would require touching every
 * Pixi-frame math site + migrating saved .pnxr files), we flip ONLY
 * the UI display:
 *
 *   Display value = -storage
 *   onChange writes -newDisplayValue back to storage
 *
 * Net behavior: existing rigs keep their stored values unchanged
 * (visual output identical), but the Properties panel now reads
 * "+30 Y" for "30 pixels up" instead of "-30 Y." Users editing
 * fields type intuitively (positive = up).
 *
 * Apply to: transform.y, pose.y, anchorOffset.y, pivot.y, corner
 * offsets' .y, animation tween peak Y, transform-binding outMin/
 * outMax when target === "y."
 *
 * Do NOT apply to: anchor.y (texture fraction 0..1, not a world
 * direction), inMin/inMax (input ranges from channels that already
 * have their own Y-up convention), rotation (positive = CW per
 * Pixi; not a Y axis).
 */
export function NumberFieldYUp(props: NumberFieldProps) {
  return (
    <NumberField
      {...props}
      value={-props.value}
      onChange={(v) => props.onChange(-v)}
    />
  );
}
