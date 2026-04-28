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
