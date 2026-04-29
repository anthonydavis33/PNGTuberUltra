// Webcam settings popover — anchored above the gear in the status bar's
// webcam row. Two controls in 4b:
//   - Calibrate: captures the user's current head pose as the new
//     zero-point so a neutral pose reads as 0/0/0 across yaw/pitch/roll.
//   - Smoothing: slider over the EMA factor used to filter MediaPipe's
//     noisy raw outputs. Lower = smoother (more lag), higher = more
//     responsive (more jitter).
//
// State lives on the WebcamSource singleton (calibration + smoothing are
// per-session, not stored in the avatar model — different users have
// different neutral poses). The popover holds local UI state for the
// slider and reads/writes the singleton on every change.

import { useEffect, useRef, useState } from "react";
import { Crosshair, RotateCcw, X } from "lucide-react";
import { getWebcamSource } from "../inputs/WebcamSource";

interface WebcamPopoverProps {
  onClose: () => void;
}

export function WebcamPopover({ onClose }: WebcamPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  const [smoothing, setSmoothingState] = useState(() =>
    getWebcamSource().getSmoothing(),
  );
  const [calibrated, setCalibrated] = useState(() =>
    getWebcamSource().isCalibrated(),
  );

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const onSmoothingChange = (v: number): void => {
    setSmoothingState(v);
    getWebcamSource().setSmoothing(v);
  };

  const handleCalibrate = (): void => {
    getWebcamSource().calibrate();
    setCalibrated(true);
  };

  const handleResetCalibration = (): void => {
    getWebcamSource().resetCalibration();
    setCalibrated(false);
  };

  return (
    <div ref={popoverRef} className="settings-popover webcam-popover">
      <div className="settings-popover-header">
        <h3>Webcam Settings</h3>
        <button
          onClick={onClose}
          className="popover-close"
          title="Close (Esc)"
          aria-label="Close webcam settings"
        >
          <X size={14} />
        </button>
      </div>

      <section className="webcam-popover-section">
        <header className="webcam-popover-section-header">
          <span>Calibration</span>
          <span className="webcam-popover-hint">
            Captures your current head pose as zero so a neutral look reads
            Yaw 0 / Pitch 0 / Roll 0.
          </span>
        </header>
        <div className="webcam-popover-actions">
          <button
            onClick={handleCalibrate}
            className="tool-btn"
            title="Look at the camera in your neutral pose, then click."
          >
            <Crosshair size={12} />
            Calibrate Neutral Pose
          </button>
          <button
            onClick={handleResetCalibration}
            className="tool-btn"
            disabled={!calibrated}
            title="Clear calibration offsets — head pose channels report raw values again."
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
        <div className="webcam-popover-status">
          {calibrated ? (
            <span className="webcam-popover-status-on">Calibrated</span>
          ) : (
            <span className="webcam-popover-status-off">Not calibrated</span>
          )}
        </div>
      </section>

      <section className="webcam-popover-section">
        <header className="webcam-popover-section-header">
          <span>Smoothing</span>
          <span className="webcam-popover-hint">
            Lower = smoother but laggier. Higher = more responsive but
            jittery. Default <code>0.40</code>.
          </span>
        </header>
        <div className="webcam-popover-slider-row">
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={smoothing}
            onChange={(e) => onSmoothingChange(parseFloat(e.target.value))}
            className="webcam-smoothing-slider"
          />
          <span className="webcam-smoothing-value">
            {smoothing.toFixed(2)}
          </span>
        </div>
      </section>
    </div>
  );
}
