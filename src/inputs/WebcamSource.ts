// Webcam face-tracking input source.
//
// Pipeline (per requestAnimationFrame tick while running):
//   getUserMedia stream → offscreen <video> element
//                       → MediaPipe FaceLandmarker .detectForVideo()
//                       → blendshapes + transformation matrix
//                       → derived per-channel values published to InputBus
//
// Channels published:
//   Continuous (numeric, EMA-smoothed):
//     HeadYaw / HeadPitch / HeadRoll  — degrees, derived from the face's
//       transformation matrix (Euler XYZ)
//     MouthOpen                       — 0..1, ARKit `jawOpen` blendshape
//     MouthClose                      — 0..1, lip closure (weak signal,
//       rarely exceeds 0.3 even at firm closure — kept for completeness)
//     MouthPress                      — 0..1, avg of pressLeft/Right
//       (the actual MBP signal — fires when lips are firmly pressed)
//     MouthFunnel                     — 0..1, rounded medium (O signal)
//     MouthPucker                     — 0..1, forward pucker (U/W signal)
//     MouthRollLower                  — 0..1, lower lip on teeth (FV signal)
//     MouthSmile                      — 0..1, avg of smileLeft/Right (EE)
//     BrowRaise                       — 0..1, average of innerUp + outerUp L/R
//     EyesClosed                      — 0..1, average of eyeBlinkLeft/Right
//     GazeX / GazeY                   — -1..1, derived from eyeLookOut/In/Up/Down
//   Discrete (string, hysteresis):
//     Viseme       — one of "AI"/"EE"/"O"/"U"/"MBP"/"FV"/"Rest" while the
//       webcam is running, null when stopped. Picked per frame by a
//       priority ladder over mouth blendshapes. Sticky for
//       VISEME_MIN_HOLD_MS to avoid flicker. "Rest" = camera running but
//       no active shape (the engaged-but-neutral pose); null = camera
//       not running. This split lets sheet rigs include a designated
//       rest frame, while visibility bindings can still detect "off".
//     MouthActive  — "active" when Viseme is one of the active shapes
//       (non-Rest non-null), otherwise null. Discrete gate channel for
//       Show On / visibility bindings — the webcam-side analogue of
//       MicState=talking.
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
import { type Viseme } from "../types/avatar";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Default EMA smoothing factor — higher = more responsive, less smooth.
 *  Tunable at runtime via WebcamSource.setSmoothing(). */
const DEFAULT_SMOOTHING = 0.4;
const MIN_SMOOTHING = 0.05;
const MAX_SMOOTHING = 1.0;

/** Continuous numeric channels (EMA-smoothed before publish). */
export const WEBCAM_CHANNELS = [
  "HeadYaw",
  "HeadPitch",
  "HeadRoll",
  "MouthOpen",
  "MouthClose",
  "MouthPress",
  "MouthFunnel",
  "MouthPucker",
  "MouthRollLower",
  "MouthSmile",
  "BrowRaise",
  "EyesClosed",
  "GazeX",
  "GazeY",
] as const;

/** Discrete string channels (published with hysteresis, NOT EMA-smoothed). */
export const WEBCAM_DISCRETE_CHANNELS = ["Viseme", "MouthActive"] as const;

/** All channels published by the webcam source. UIs use this for things like
 *  "blank out everything when the source stops." */
export const ALL_WEBCAM_CHANNELS = [
  ...WEBCAM_CHANNELS,
  ...WEBCAM_DISCRETE_CHANNELS,
] as const;

type WebcamChannel = (typeof WEBCAM_CHANNELS)[number];

// Viseme hysteresis — mirrors MicSource's PHONEME_MIN_HOLD_MS so audio
// phoneme and webcam viseme have the same feel.
const VISEME_MIN_HOLD_MS = 80;

/**
 * Per-viseme thresholds, evaluated top-to-bottom — first match wins. If NO
 * rule matches, the classifier emits "Rest" (engaged-but-neutral pose).
 *
 * Tuning notes — empirical from MediaPipe FaceLandmarker output:
 *   - Blendshapes are heavily compressed in practice. mouthFunnel/Pucker/
 *     RollLower/Press rarely exceed ~0.4 even at exaggerated shapes.
 *     Thresholds need to live in the 0.15-0.3 range, not the 0.5-0.6
 *     range you'd guess from the documented 0..1 scale.
 *   - U vs O: both fire mouthFunnel AND mouthPucker — they're not
 *     orthogonal signals. The cleanest separator is mouthOpen: O is
 *     "rounded with mouth open", U is "rounded with mouth small."
 *   - MBP: mouthClose is too weak to be useful. mouthPress (lips
 *     pressing together) is what actually fires for the M/B/P shape.
 *   - EE: mouthSmile + low mouthOpen. Smile alone isn't enough — a
 *     happy "ahhh" is still AI, not EE.
 *
 * Order matters when rules can both fire: FV / MBP first (most specific
 * non-vowel shapes), EE before AI (smile is a more specific open shape),
 * U before O so the small-mouth case has priority.
 */
const VISEME_RULES: Array<{
  viseme: Viseme;
  test: (b: Readonly<Record<WebcamChannel, number>>) => boolean;
}> = [
  { viseme: "FV", test: (b) => b.MouthRollLower > 0.18 },
  { viseme: "MBP", test: (b) => b.MouthPress > 0.22 },
  { viseme: "EE", test: (b) => b.MouthSmile > 0.25 && b.MouthOpen < 0.25 },
  // U: rounded + mouth small/forward.
  {
    viseme: "U",
    test: (b) => b.MouthPucker > 0.3 && b.MouthOpen < 0.2,
  },
  // O: rounded + mouth open (so "OOO" doesn't get stolen by U).
  {
    viseme: "O",
    test: (b) =>
      (b.MouthFunnel > 0.18 || b.MouthPucker > 0.25) && b.MouthOpen > 0.15,
  },
  { viseme: "AI", test: (b) => b.MouthOpen > 0.25 },
];

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
    MouthClose: 0,
    MouthPress: 0,
    MouthFunnel: 0,
    MouthPucker: 0,
    MouthRollLower: 0,
    MouthSmile: 0,
    BrowRaise: 0,
    EyesClosed: 0,
    GazeX: 0,
    GazeY: 0,
  };

  // Viseme classifier state — sticky with min hold to avoid flicker.
  // While the camera is running, value is one of the VISEMES enum
  // including "Rest" for neutral pose. null only while the camera is
  // stopped (set by the stop() handler, not the classifier itself).
  private currentViseme: Viseme | null = null;
  private visemeSwitchedAt = 0;

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
    for (const c of ALL_WEBCAM_CHANNELS) inputBus.publish(c, null);
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
    // Reset viseme state and clear the discrete channels.
    this.currentViseme = null;
    this.visemeSwitchedAt = 0;
    inputBus.publish("Viseme", null);
    inputBus.publish("MouthActive", null);
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

      // Mouth shape blendshapes — these double as raw channels (so users
      // can build custom logic via threshold/linear bindings) AND inputs
      // to the Viseme classifier below.
      this.publishSmoothed("MouthOpen", bs("jawOpen"));
      this.publishSmoothed("MouthClose", bs("mouthClose"));
      this.publishSmoothed(
        "MouthPress",
        (bs("mouthPressLeft") + bs("mouthPressRight")) / 2,
      );
      this.publishSmoothed("MouthFunnel", bs("mouthFunnel"));
      this.publishSmoothed("MouthPucker", bs("mouthPucker"));
      this.publishSmoothed("MouthRollLower", bs("mouthRollLower"));
      this.publishSmoothed(
        "MouthSmile",
        (bs("mouthSmileLeft") + bs("mouthSmileRight")) / 2,
      );

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

      // Derive the discrete Viseme channel from the smoothed mouth
      // blendshapes we just published. Reading from `this.smoothed` (not
      // raw bs() values) means the viseme thresholds see the same numbers
      // the user sees on the bus and in the status bar — predictable.
      this.classifyViseme();
    }
  }

  /**
   * Pick the dominant viseme from the current smoothed mouth blendshapes
   * via VISEME_RULES (priority ladder, top-to-bottom = most specific
   * shapes first). If no rule matches, candidate is "Rest".
   *
   * Hysteresis: once a value is published, hold it for VISEME_MIN_HOLD_MS
   * before letting a different value win, so frames don't flicker on
   * values hovering near a threshold. Applies to Rest transitions too.
   *
   * Also publishes MouthActive: "active" when Viseme is an active shape
   * (non-Rest), otherwise null. This gives Show On / visibility bindings
   * a clean discrete gate analogous to MicState=talking — the multi-
   * sprite "show neutral, hide talking" pattern still works because
   * MouthActive=null at Rest.
   */
  private classifyViseme(): void {
    let candidate: Viseme = "Rest";
    for (const rule of VISEME_RULES) {
      if (rule.test(this.smoothed)) {
        candidate = rule.viseme;
        break;
      }
    }

    const now = performance.now();

    // Reject the switch if we changed values too recently — keeps the rig
    // calm at threshold edges.
    let published: Viseme = candidate;
    if (
      this.currentViseme !== null &&
      this.currentViseme !== candidate &&
      now - this.visemeSwitchedAt < VISEME_MIN_HOLD_MS
    ) {
      published = this.currentViseme;
    } else if (this.currentViseme !== candidate) {
      this.currentViseme = candidate;
      this.visemeSwitchedAt = now;
    }

    inputBus.publish("Viseme", published);
    inputBus.publish(
      "MouthActive",
      published !== "Rest" ? "active" : null,
    );
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
