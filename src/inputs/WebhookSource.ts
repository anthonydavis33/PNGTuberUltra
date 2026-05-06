// External-event webhook input source.
//
// Listens for `webhook-event` Tauri events emitted by the Rust HTTP
// server (POST /webhook/event on http://127.0.0.1:47882). Any external
// tool that can POST JSON works as an event source — TikTok bridges,
// Streamer.bot, custom Python/Node scripts, hardware controllers,
// home-assistant integrations, OBS scene-change webhooks, etc.
//
// Endpoint contract:
//   POST http://127.0.0.1:47882/webhook/event
//   Headers (optional but preferred):
//     X-Source: <provider>          e.g. "tiktok", "streamerbot"
//     X-Event:  <event-type>        e.g. "chat", "gift", "follow"
//   Body: any JSON. Common fields the source recognizes:
//     user / username / from        → published as WebhookUser /
//                                     TiktokUser etc.
//     value / amount / count        → published as numeric channel
//     message / text                → published as message channel
//
// Channels published:
//
// Generic — fire on every webhook regardless of source:
//   WebhookEvent      — string, the event type (X-Event header / body
//                       `event` field). Impulse, auto-clears.
//   WebhookSource     — string, the source identifier.
//   WebhookUser       — string, user/username/from field if present.
//   WebhookValue      — number, value/amount/count field if numeric.
//   WebhookMessage    — string, message/text field if present.
//   WebhookActive     — boolean, true while the HTTP server is bound
//                       (always true once the app boots successfully;
//                       exposed so rigs can gate "external events
//                       enabled" overlays).
//
// Source-specific shortcuts — fire on top of the generic channels
// when the X-Source header matches. Saves users from doing
// "WebhookSource equals tiktok AND WebhookEvent equals gift" gating
// in their bindings.
//
//   TikTok (X-Source: tiktok):
//     TiktokChat         — chat message text (impulse)
//     TiktokUser         — chat user (impulse)
//     TiktokGift         — gift name (impulse)
//     TiktokGiftCount    — gift count (continuous impulse)
//     TiktokGiftValue    — diamond value if known (continuous impulse)
//     TiktokFollow       — new follower (impulse)
//     TiktokLike         — last liker (impulse)
//     TiktokLikeCount    — likes-this-event count (continuous impulse)
//     TiktokShare        — last sharer (impulse)
//     TiktokViewerCount  — current viewer count (continuous, no
//                          auto-clear since it's a persistent meter)
//     TiktokActive       — boolean: at least one TikTok event has
//                          arrived this session.
//
// Why the source-specific shortcuts? TikTok is the most likely
// webhook user (since native TikTok integration would otherwise
// require maintaining a fragile reverse-engineered protocol). Making
// TikTok bindings as ergonomic as native sources for the common case
// is worth the few extra channels. Other providers (Streamer.bot,
// custom scripts) work via the generic Webhook* channels.
//
// External tooling notes:
//   - For TikTok: run `tiktok-live-connector` (Node) or `TikTokLive`
//     (Python) as a separate process and POST events to
//     http://localhost:47882/webhook/event with X-Source: tiktok.
//   - For Streamer.bot: HTTP Request action → POST to the same URL.
//   - The endpoint is bound to 127.0.0.1 only — never accessible
//     over the network. Local-machine bridges only.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

interface WebhookEvent {
  source: string;
  event: string;
  body: string;
}

const STRING_CLEAR_MS = 800;
const NUMERIC_CLEAR_MS = 500;

export const WEBHOOK_BASE_CHANNELS = [
  "WebhookEvent",
  "WebhookSource",
  "WebhookUser",
  "WebhookValue",
  "WebhookMessage",
  "WebhookActive",
] as const;

export const TIKTOK_CHANNELS = [
  "TiktokChat",
  "TiktokUser",
  "TiktokGift",
  "TiktokGiftCount",
  "TiktokGiftValue",
  "TiktokFollow",
  "TiktokLike",
  "TiktokLikeCount",
  "TiktokShare",
  "TiktokViewerCount",
  "TiktokActive",
] as const;

class WebhookSource {
  private impulseTimers: Map<string, number> = new Map();
  private unlisten: UnlistenFn | null = null;
  private connectionListeners = new Set<(active: boolean) => void>();

  constructor() {
    for (const c of WEBHOOK_BASE_CHANNELS) inputBus.publish(c, null);
    for (const c of TIKTOK_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("WebhookActive", false);
    inputBus.publish("TiktokActive", false);
    inputBus.publish("WebhookValue", 0);
    inputBus.publish("TiktokGiftCount", 0);
    inputBus.publish("TiktokGiftValue", 0);
    inputBus.publish("TiktokLikeCount", 0);
    inputBus.publish("TiktokViewerCount", 0);

    // Wire up Tauri event listener. The Rust server is always running
    // (spawned at app boot), so once we attach we can mark the
    // generic webhook gate as live.
    void listen<WebhookEvent>("webhook-event", (e) => this.handle(e.payload))
      .then((fn) => {
        this.unlisten = fn;
        inputBus.publish("WebhookActive", true);
        for (const l of this.connectionListeners) l(true);
      })
      .catch((err) => {
        console.warn("[webhook] failed to attach listener:", err);
      });
  }

  destroy(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    for (const t of this.impulseTimers.values()) window.clearTimeout(t);
    this.impulseTimers.clear();
    this.connectionListeners.clear();
    for (const c of WEBHOOK_BASE_CHANNELS) inputBus.publish(c, null);
    for (const c of TIKTOK_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("WebhookActive", false);
    inputBus.publish("TiktokActive", false);
  }

  /** Subscribe to "is the server listening" state. Listener fires
   *  immediately with the current value, then on changes. */
  subscribeActive(listener: (active: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.unlisten !== null);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private handle(event: WebhookEvent): void {
    if (useSettings.getState().inputPaused) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(event.body) as Record<string, unknown>;
    } catch {
      // Body wasn't JSON — still fire the source/event channels so
      // bindings can react to the bare event type even without
      // payload parsing.
    }

    // Generic channels — always fire.
    this.publishImpulseString("WebhookEvent", event.event, STRING_CLEAR_MS);
    this.publishImpulseString("WebhookSource", event.source, STRING_CLEAR_MS);
    const user = pickString(parsed, "user", "username", "from", "userName");
    if (user !== null) {
      this.publishImpulseString("WebhookUser", user, STRING_CLEAR_MS);
    }
    const value = pickNumber(parsed, "value", "amount", "count");
    if (value !== null) {
      this.publishImpulseNumber("WebhookValue", value, NUMERIC_CLEAR_MS);
    }
    const message = pickString(parsed, "message", "text", "comment");
    if (message !== null) {
      this.publishImpulseString("WebhookMessage", message, STRING_CLEAR_MS);
    }

    // Source-specific shortcuts.
    if (event.source.toLowerCase() === "tiktok") {
      this.handleTiktok(event.event, parsed, user);
    }
  }

  private handleTiktok(
    eventType: string,
    body: Record<string, unknown>,
    user: string | null,
  ): void {
    // TiktokActive is sticky — once we've seen a TikTok event, the
    // gate stays open for the session. Lets visibility bindings
    // hide a "TikTok offline" overlay after first packet.
    inputBus.publish("TiktokActive", true);

    // Viewer count is often updated as its own event type but also
    // tends to ride along with most events as a snapshot. Try to
    // pull it from the body regardless of event type.
    const viewerCount = pickNumber(body, "viewerCount", "viewers", "watching");
    if (viewerCount !== null) {
      inputBus.publish("TiktokViewerCount", viewerCount);
    }

    const lc = eventType.toLowerCase();
    switch (lc) {
      case "chat":
      case "comment": {
        const text = pickString(body, "comment", "message", "text") ?? "";
        if (text) {
          this.publishImpulseString("TiktokChat", text, STRING_CLEAR_MS);
        }
        if (user) {
          this.publishImpulseString("TiktokUser", user, STRING_CLEAR_MS);
        }
        break;
      }
      case "gift": {
        const giftName = pickString(body, "giftName", "name") ?? "";
        const repeatCount = pickNumber(body, "repeatCount", "count") ?? 1;
        const diamondCount =
          pickNumber(body, "diamondCount", "diamonds", "value") ?? 0;
        if (giftName) {
          this.publishImpulseString("TiktokGift", giftName, STRING_CLEAR_MS);
        }
        if (user) {
          this.publishImpulseString("TiktokUser", user, STRING_CLEAR_MS);
        }
        this.publishImpulseNumber(
          "TiktokGiftCount",
          repeatCount,
          NUMERIC_CLEAR_MS,
        );
        this.publishImpulseNumber(
          "TiktokGiftValue",
          diamondCount * repeatCount,
          NUMERIC_CLEAR_MS,
        );
        break;
      }
      case "follow": {
        if (user) {
          this.publishImpulseString("TiktokFollow", user, STRING_CLEAR_MS);
        }
        break;
      }
      case "like": {
        const likeCount = pickNumber(body, "likeCount", "count") ?? 1;
        if (user) {
          this.publishImpulseString("TiktokLike", user, STRING_CLEAR_MS);
        }
        this.publishImpulseNumber(
          "TiktokLikeCount",
          likeCount,
          NUMERIC_CLEAR_MS,
        );
        break;
      }
      case "share":
      case "social": {
        if (user) {
          this.publishImpulseString("TiktokShare", user, STRING_CLEAR_MS);
        }
        break;
      }
      case "roomuser":
      case "viewer":
      case "viewers": {
        // Pure viewer-count update. handled above already; nothing
        // else to do here, but recognize the event type so it
        // doesn't fall through to "unknown" debug logs.
        break;
      }
      default:
        // Unknown TikTok event type — generic channels already fired,
        // don't spam console.
        break;
    }
  }

  private publishImpulseString(
    channel: string,
    value: string,
    clearMs: number,
  ): void {
    inputBus.publish(channel, value);
    const existing = this.impulseTimers.get(channel);
    if (existing !== undefined) window.clearTimeout(existing);
    this.impulseTimers.set(
      channel,
      window.setTimeout(() => {
        inputBus.publish(channel, null);
        this.impulseTimers.delete(channel);
      }, clearMs),
    );
  }

  private publishImpulseNumber(
    channel: string,
    value: number,
    clearMs: number,
  ): void {
    inputBus.publish(channel, value);
    const existing = this.impulseTimers.get(channel);
    if (existing !== undefined) window.clearTimeout(existing);
    this.impulseTimers.set(
      channel,
      window.setTimeout(() => {
        inputBus.publish(channel, 0);
        this.impulseTimers.delete(channel);
      }, clearMs),
    );
  }
}

/** Pull the first present string field from a JSON object, trying
 *  multiple possible keys (different bridges use different
 *  conventions — TikTok-Live-Connector uses `comment`, Streamer.bot
 *  uses `message`, etc.). */
function pickString(
  body: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(
  body: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.length > 0) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

let webhookSingleton: WebhookSource | null = null;
export function getWebhookSource(): WebhookSource {
  if (!webhookSingleton) webhookSingleton = new WebhookSource();
  return webhookSingleton;
}

export function resetWebhookSource(): void {
  webhookSingleton?.destroy();
  webhookSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetWebhookSource());
}
