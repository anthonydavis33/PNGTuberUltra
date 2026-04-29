// Webcam face-tracking input source.
//
// Pipeline (per requestAnimationFrame tick while running):
//   getUserMedia stream → offscreen <video> element
//                       → MediaPipe FaceLandmarker .detectForVideo()
//                       → blendshapes + transformation matrix
//                       → derived per-channel values published to InputBus
//
// Channels published (all continuous):
//   HeadYaw / HeadPitch / HeadRoll  — degrees, derived from the face's
//     transformation matrix (Euler XYZ)
//   MouthOpen                       — 0..1, ARKit `jawOpen` blendshape
//   BrowRaise                       — 0..1, average of innerUp + outerUp L/R
//   EyesClosed                      — 0..1, average of eyeBlinkLeft/Right
//   GazeX / GazeY                   — -1..1, derived from eyeLookOut/In/Up/Down
//
// Smoothing: simple per-channel EMA (`α = 0.4`) — MediaPipe outputs are
// noisy at face level. Tighter smoothing makes the avatar feel laggy;
// looser makes it shake. Will become per-channel-tunable in 4b.
//
// Permissions: getUserMedia({video:true}) triggers the OS / browser camera
// prompt on first call. Tauri 2 webview honors the same prompt.

import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { inputBus } from "./InputBus";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Default EMA smoothing factor — higher = more responsive, less smooth.
 *  Tunable at runtime via WebcamSource.setSmoothing(). */
const DEFAULT_SMOOTHING = 0.4;
const MIN_SMOOTHING = 0.05;
const MAX_SMOOTHING = 1.0;

export const WEBCAM_CHANNELS = [
  "HeadYaw",
  "HeadPitch",
  "HeadRoll",
  "MouthOpen",
  "BrowRaise",
  "EyesClosed",
  "GazeX",
  "GazeY",
] as const;

type WebcamChannel = (typeof WEBCAM_CHANNELS)[number];

class WebcamSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private landmarker: FaceLandmarker | null = null;
  private rafId: number | null = null;
  private ready = false;

  private smoothed: Record<WebcamChannel, number> = {
    HeadYaw: 0,
    HeadPitch: 0,
    HeadRoll: 0,
    MouthOpen: 0,
    BrowRaise: 0,
    EyesClosed: 0,
    GazeX: 0,
    GazeY: 0,
  };

  /** Current EMA smoothing factor. Changeable at runtime. */
  private smoothingFactor: number = DEFAULT_SMOOTHING;

  /** Calibration offset subtracted from head-pose channels so the user's
   *  neutral pose reads as 0/0/0. Set by calibrate(). */
  private calibrationOffset = { yaw: 0, pitch: 0, roll: 0 };

  constructor() {
    // Initialize bus channels at null so transform bindings DON'T fire
    // when webcam is off — `null` coerces to non-numeric in valueAsNumber,
    // so the binding evaluator skips the override and leaves the sprite's
    // base transform alone. UIs read these with `?? 0` fallbacks for
    // display. Publishing 0 here would silently override manual transform
    // edits on any sprite bound to a webcam channel.
    for (const c of WEBCAM_CHANNELS) inputBus.publish(c, null);
  }

  isRunning(): boolean {
    return this.stream !== null;
  }

  /** True between getUserMedia success and FaceLandmarker.create() resolving. */
  isInitializing(): boolean {
    return this.stream !== null && !this.ready;
  }

  getSmoothing(): number {
    return this.smoothingFactor;
  }

  setSmoothing(value: number): void {
    this.smoothingFactor = Math.max(
      MIN_SMOOTHING,
      Math.min(MAX_SMOOTHING, value),
    );
  }

  /** Capture the current smoothed head pose as the new neutral / zero
   *  point. After this, looking straight ahead reads as Yaw=0/Pitch=0/Roll=0. */
  calibrate(): void {
    this.calibrationOffset = {
      yaw: this.smoothed.HeadYaw,
      pitch: this.smoothed.HeadPitch,
      roll: this.smoothed.HeadRoll,
    };
  }

  resetCalibration(): void {
    this.calibrationOffset = { yaw: 0, pitch: 0, roll: 0 };
  }

  isCalibrated(): boolean {
    const c = this.calibrationOffset;
    return c.yaw !== 0 || c.pitch !== 0 || c.roll !== 0;
  }

  async start(): Promise<void> {
    if (this.stream) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });

    this.video = document.createElement("video");
    this.video.srcObject = this.stream;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.style.display = "none";
    document.body.appendChild(this.video);
    await this.video.play();

    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU",
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
    }

    this.ready = true;
    this.tick();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    this.ready = false;

    for (const c of WEBCAM_CHANNELS) {
      this.smoothed[c] = 0;
      // Publish null on stop so bindings stop firing — see constructor
      // comment for why this matters.
      inputBus.publish(c, null);
    }
  }

  /** Free the FaceLandmarker model entirely. Use during HMR cleanup. */
  destroy(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
  }

  private tick = (): void => {
    if (!this.landmarker || !this.video || !this.ready) return;

    try {
      const result = this.landmarker.detectForVideo(
        this.video,
        performance.now(),
      );
      this.applyResult(result);
    } catch (err) {
      console.error("[Webcam] detection failed:", err);
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private applyResult(result: FaceLandmarkerResult): void {
    // Head pose from the face's transformation matrix (column-major 4x4).
    const matrices = result.facialTransformationMatrixes;
    if (matrices && matrices.length > 0) {
      const m = matrices[0].data;
      const { yaw, pitch, roll } = matrixToEuler(m);
      this.publishSmoothed("HeadYaw", yaw);
      this.publishSmoothed("HeadPitch", pitch);
      this.publishSmoothed("HeadRoll", roll);
    }

    // ARKit blendshapes — 52 named coefficients in 0..1.
    const blendshapes = result.faceBlendshapes?.[0]?.categories;
    if (blendshapes) {
      const bs = (name: string): number =>
        blendshapes.find((c) => c.categoryName === name)?.score ?? 0;

      this.publishSmoothed("MouthOpen", bs("jawOpen"));

      this.publishSmoothed(
        "BrowRaise",
        (bs("browInnerUp") +
          bs("browOuterUpLeft") +
          bs("browOuterUpRight")) /
          3,
      );

      this.publishSmoothed(
        "EyesClosed",
        (bs("eyeBlinkLeft") + bs("eyeBlinkRight")) / 2,
      );

      // Gaze X: positive = looking right (user's right), negative = left.
      // ARKit naming: "Out" and "In" are relative to each eye.
      const gazeX = (bs("eyeLookOutRight") - bs("eyeLookOutLeft")) / 2;
      // Gaze Y: positive = looking down. (Down is positive on screen Y.)
      const gazeY =
        (bs("eyeLookDownLeft") +
          bs("eyeLookDownRight") -
          bs("eyeLookUpLeft") -
          bs("eyeLookUpRight")) /
        2;
      this.publishSmoothed("GazeX", gazeX);
      this.publishSmoothed("GazeY", gazeY);
    }
  }

  private publishSmoothed(key: WebcamChannel, raw: number): void {
    const a = this.smoothingFactor;
    this.smoothed[key] = a * raw + (1 - a) * this.smoothed[key];

    // Apply calibration offset for head-pose channels only — mouth, brow,
    // eyes, and gaze are already normalized blendshapes whose neutral
    // value is 0.
    let published = this.smoothed[key];
    if (key === "HeadYaw") published -= this.calibrationOffset.yaw;
    else if (key === "HeadPitch") published -= this.calibrationOffset.pitch;
    else if (key === "HeadRoll") published -= this.calibrationOffset.roll;

    inputBus.publish(key, published);
  }
}

/**
 * Decompose a column-major 4x4 transformation matrix into XYZ Euler angles
 * (degrees). Conventions chosen to feel natural for a head-tracking avatar:
 *   - yaw   positive = head turning to user's right
 *   - pitch positive = head pitching up
 *   - roll  positive = head tilting (right ear toward right shoulder)
 *
 * If signs feel inverted in practice, flip them in the publishSmoothed call
 * sites — the matrix decomposition itself is correct.
 */
function matrixToEuler(m: Float32Array | number[]): {
  yaw: number;
  pitch: number;
  roll: number;
} {
  // Column-major: m[col * 4 + row]
  // Rotation submatrix (top-left 3x3):
  //   r00 r01 r02       m[0]  m[4]  m[8]
  //   r10 r11 r12   =   m[1]  m[5]  m[9]
  //   r20 r21 r22       m[2]  m[6]  m[10]
  const r02 = m[8];
  const r12 = m[9];
  const r22 = m[10];
  const r10 = m[1];
  const r11 = m[5];

  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const yaw = Math.atan2(r02, r22);
  const roll = Math.atan2(r10, r11);

  const RAD_TO_DEG = 180 / Math.PI;
  return {
    yaw: yaw * RAD_TO_DEG,
    pitch: pitch * RAD_TO_DEG,
    roll: roll * RAD_TO_DEG,
  };
}

let webcamSingleton: WebcamSource | null = null;
export function getWebcamSource(): WebcamSource {
  if (!webcamSingleton) webcamSingleton = new WebcamSource();
  return webcamSingleton;
}

export function resetWebcamSource(): void {
  webcamSingleton?.destroy();
  webcamSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetWebcamSource());
}
