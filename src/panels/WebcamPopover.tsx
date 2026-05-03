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
import { Crosshair, Eye, RotateCcw, X } from "lucide-react";
import { getWebcamSource } from "../inputs/WebcamSource";
import { useAvatar } from "../store/useAvatar";
import { DEFAULT_AUTO_BLINK_CONFIG } from "../types/avatar";

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

  const autoBlink =
    useAvatar((s) => s.model.inputs?.autoBlink) ?? DEFAULT_AUTO_BLINK_CONFIG;
  const updateAutoBlinkConfig = useAvatar((s) => s.updateAutoBlinkConfig);

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

      {/* Blinking — owns the BlinkState bus channel. Default mode is
       *  a semi-random timer (works without any external input);
       *  flipping "Use webcam tracking" routes through the webcam's
       *  EyesClosed channel instead, with auto-fallback to the timer
       *  when the camera is off. Sprites hook in via Show On → Blink
       *  State. */}
      <section className="webcam-popover-section">
        <header className="webcam-popover-section-header">
          <span>Blinking</span>
          <span className="webcam-popover-hint">
            Drives the <code>BlinkState</code> channel. On by default
            with a semi-random timer; opt into webcam-driven blinks
            below if you want your real blinks to track. Sprites pick
            it up via <strong>Show On → Blink State</strong>.
          </span>
        </header>

        <label
          className={`settings-radio ${autoBlink.enabled ? "active" : ""}`}
          title="Master toggle for blinking. With it off, BlinkState stays null and the channel disappears from binding pickers."
        >
          <input
            type="checkbox"
            checked={autoBlink.enabled}
            onChange={(e) =>
              updateAutoBlinkConfig({ enabled: e.target.checked })
            }
          />
          <div className="settings-radio-body">
            <div className="settings-radio-label">
              <Eye size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
              Enabled
            </div>
            <div className="settings-radio-hint">
              On by default — blinks fire automatically without any
              setup. Disable to hand-roll your own eye logic.
            </div>
          </div>
        </label>

        {autoBlink.enabled && (
          <>
            <label
              className={`settings-radio ${autoBlink.useWebcam ? "active" : ""}`}
              title="Use the webcam's eye-tracking signal as the trigger instead of the timer. Falls back to the timer automatically when the webcam is off, so blinks never fully stop."
            >
              <input
                type="checkbox"
                checked={autoBlink.useWebcam}
                onChange={(e) =>
                  updateAutoBlinkConfig({ useWebcam: e.target.checked })
                }
              />
              <div className="settings-radio-body">
                <div className="settings-radio-label">
                  Use webcam tracking
                </div>
                <div className="settings-radio-hint">
                  When the webcam is running, your real blinks drive
                  BlinkState. Webcam off → falls back to the timer
                  below so the avatar keeps blinking either way.
                </div>
              </div>
            </label>

            <div className="webcam-popover-slider-row">
              <span className="autoblink-field-label">Min</span>
              <input
                type="range"
                min={500}
                max={10000}
                step={100}
                value={autoBlink.intervalMinMs}
                onChange={(e) =>
                  updateAutoBlinkConfig({
                    intervalMinMs: Math.min(
                      autoBlink.intervalMaxMs,
                      parseInt(e.target.value, 10),
                    ),
                  })
                }
                className="webcam-smoothing-slider"
              />
              <span className="webcam-smoothing-value">
                {(autoBlink.intervalMinMs / 1000).toFixed(1)}s
              </span>
            </div>

            <div className="webcam-popover-slider-row">
              <span className="autoblink-field-label">Max</span>
              <input
                type="range"
                min={500}
                max={10000}
                step={100}
                value={autoBlink.intervalMaxMs}
                onChange={(e) =>
                  updateAutoBlinkConfig({
                    intervalMaxMs: Math.max(
                      autoBlink.intervalMinMs,
                      parseInt(e.target.value, 10),
                    ),
                  })
                }
                className="webcam-smoothing-slider"
              />
              <span className="webcam-smoothing-value">
                {(autoBlink.intervalMaxMs / 1000).toFixed(1)}s
              </span>
            </div>

            <div className="webcam-popover-slider-row">
              <span className="autoblink-field-label">Hold</span>
              <input
                type="range"
                min={50}
                max={500}
                step={10}
                value={autoBlink.durationMs}
                onChange={(e) =>
                  updateAutoBlinkConfig({
                    durationMs: parseInt(e.target.value, 10),
                  })
                }
                className="webcam-smoothing-slider"
              />
              <span className="webcam-smoothing-value">
                {autoBlink.durationMs}ms
              </span>
            </div>

            <div className="webcam-popover-slider-row">
              <span className="autoblink-field-label">Double</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={autoBlink.doubleBlinkProbability ?? 0}
                onChange={(e) =>
                  updateAutoBlinkConfig({
                    doubleBlinkProbability: parseFloat(e.target.value),
                  })
                }
                className="webcam-smoothing-slider"
                title="Probability that a single timer blink is followed by a quick second one. 0 = never, ~0.15 = lifelike. Webcam mode tracks your real blinks instead."
              />
              <span className="webcam-smoothing-value">
                {Math.round((autoBlink.doubleBlinkProbability ?? 0) * 100)}%
              </span>
            </div>

            <label
              className="autoblink-state-row"
              title="Value published to BlinkState while a blink is firing. Default 'closed'; rename if you're co-using the channel for other states."
            >
              <span className="autoblink-field-label">State name</span>
              <input
                type="text"
                value={autoBlink.stateName}
                onChange={(e) =>
                  updateAutoBlinkConfig({ stateName: e.target.value })
                }
                placeholder="closed"
                className="autoblink-state-input"
              />
            </label>
          </>
        )}
      </section>
    </div>
  );
}
