// Lipsync source — derived `Lipsync` channel that combines MicPhoneme
// (audio formants) and Viseme (webcam blendshapes) into a single best-
// effort lipsync signal.
//
// Why combine: each source has gaps the other fills.
//   - Audio formants give fast, accurate transitions during voiced speech
//     ("a-ni-MA-tion") because vowel resonance changes in milliseconds.
//     But formants physically cannot detect lip-closure (MBP) or
//     lip-on-teeth (FV) — those require visual data.
//   - Webcam visemes catch the visual-only shapes cleanly and work even
//     when the mic is muted, but lag behind fast articulation because
//     lips don't visibly land on each shape during quick speech.
//
// Priority ladder per tick:
//   1. Viseme = FV or MBP             → use Viseme (visual-only signals win)
//   2. MicPhoneme non-null            → map A/I/U/E/O into viseme vocabulary
//                                       (audio is faster on vowel changes)
//   3. Viseme is an active shape      → use Viseme (vowel from visual,
//                                       mic silent or off)
//   4. Either source running          → "Rest" (engaged but neutral —
//                                       lets sheet rigs designate a rest
//                                       frame in the stateMap)
//   5. else                            → null (no source running at all)
//
// Publishes ONE channel: `Lipsync`. Discrete, values from the VISEMES
// vocabulary so users can stateMap it to sprite-sheet frames the same
// way they would Viseme — but with the strengths of both sources behind
// each value.

import { inputBus } from "./InputBus";
import { type Phoneme, type Viseme } from "../types/avatar";

/** Audio phoneme → viseme vocabulary mapping.
 *
 *  - A (ah, "father") → AI: open vowel
 *  - I (ee, "see")    → EE: closed front
 *  - U (oo, "boot")   → U: rounded forward
 *  - E (eh, "bed")    → AI: open-ish vowel, more like AI than EE
 *  - O (oh, "boat")   → O: rounded medium open
 */
function phonemeToViseme(p: Phoneme): Viseme {
  switch (p) {
    case "A":
      return "AI";
    case "I":
      return "EE";
    case "U":
      return "U";
    case "E":
      return "AI";
    case "O":
      return "O";
  }
}

/** Visual-only visemes — audio formants can never detect these because
 *  they have no characteristic resonance. When the camera says one of
 *  these, override anything the mic might be saying. */
function isVisualOnly(v: Viseme): boolean {
  return v === "FV" || v === "MBP";
}

function computeLipsync(
  phoneme: Phoneme | null | undefined,
  viseme: Viseme | null | undefined,
  micRunning: boolean,
  webcamRunning: boolean,
): Viseme | null {
  // Visual-only shapes always win — audio formants can never produce
  // these. (Webcam's "Rest" doesn't trigger this branch.)
  if (viseme && isVisualOnly(viseme)) return viseme;

  // Audio is faster on vowel transitions during voiced speech.
  if (phoneme) return phonemeToViseme(phoneme);

  // Active visual shape (anything except Rest / null).
  if (viseme && viseme !== "Rest") return viseme;

  // Both sources idle. If at least one source is running, we're in the
  // engaged-but-neutral pose — emit "Rest" so sheet rigs can designate a
  // dedicated neutral frame. If nothing's running, emit null so visibility
  // bindings can hide things cleanly.
  if (webcamRunning || micRunning) return "Rest";
  return null;
}

class LipsyncSource {
  private unsubs: Array<() => void> = [];
  private lastPublished: Viseme | null = null;

  constructor() {
    // Initialize at null so transform-binding evaluation matches the
    // null-when-source-off pattern used by MicPhoneme / Viseme.
    inputBus.publish("Lipsync", null);

    // Recompute on any upstream change. Subscribing to MicVolume +
    // MouthOpen too means we react when a source starts running silently
    // (e.g., user enables mic but isn't talking yet) — those publish at
    // 60Hz while running, but our recompute exits early when the result
    // hasn't changed, so the cost is negligible.
    const recompute = () => this.recompute();
    this.unsubs = [
      inputBus.subscribe<Phoneme | null>("MicPhoneme", recompute),
      inputBus.subscribe<Viseme | null>("Viseme", recompute),
      inputBus.subscribe<number | null>("MicVolume", recompute),
      inputBus.subscribe<number | null>("MouthOpen", recompute),
    ];
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.lastPublished = null;
    inputBus.publish("Lipsync", null);
  }

  private recompute(): void {
    const phoneme = inputBus.get<Phoneme | null>("MicPhoneme") ?? null;
    const viseme = inputBus.get<Viseme | null>("Viseme") ?? null;
    // MicVolume / MouthOpen go null when their source stops, numeric
    // when running. The numeric value can be exactly 0 during silence so
    // we test for null specifically, not falsiness.
    const micRunning = inputBus.get<number | null>("MicVolume") !== null;
    const webcamRunning = inputBus.get<number | null>("MouthOpen") !== null;
    const next = computeLipsync(phoneme, viseme, micRunning, webcamRunning);
    if (next !== this.lastPublished) {
      this.lastPublished = next;
      inputBus.publish("Lipsync", next);
    }
  }
}

let lipsyncSingleton: LipsyncSource | null = null;
export function getLipsyncSource(): LipsyncSource {
  if (!lipsyncSingleton) lipsyncSingleton = new LipsyncSource();
  return lipsyncSingleton;
}

export function resetLipsyncSource(): void {
  lipsyncSingleton?.destroy();
  lipsyncSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetLipsyncSource());
}
