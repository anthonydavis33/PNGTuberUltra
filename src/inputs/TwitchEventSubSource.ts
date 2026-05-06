// Twitch EventSub source — OAuth + WebSocket events.
//
// Complements TwitchChatSource (anonymous IRC, no auth) with the
// richer event stream that requires the user to authorize the app:
// channel point redemptions, follows, subscriptions, raids, cheers.
// EventSub is push-based (no polling), so once the WebSocket is up
// the only ongoing cost is keepalive pings every 10s.
//
// Pipeline:
//   1. User clicks "Connect with Twitch" in StatusBar.
//   2. oauthFlow() drives the auth-code-with-PKCE dance (browser →
//      grant → loopback redirect → code).
//   3. POST id.twitch.tv/oauth2/token → access_token + refresh_token.
//   4. GET id.twitch.tv/oauth2/validate → user_id.
//   5. Connect wss://eventsub.wss.twitch.tv/ws → wait for
//      session_welcome message → grab session.id.
//   6. POST api.twitch.tv/helix/eventsub/subscriptions for each
//      event type we care about, with transport.session_id = the
//      welcome's session ID.
//   7. WebSocket `notification` messages → parse → publish to bus.
//
// Channels published (all impulses unless noted — auto-clear so
// bindings see clean edges):
//   TwitchFollow            — username of new follower
//   TwitchSubEvent          — username of new subscriber (sub / resub
//                             / gift recipient — unified for v1; can
//                             split later if a rig needs to distinguish)
//   TwitchSubTier           — "1000" / "2000" / "3000" (Twitch's
//                             plan-tier strings, kept verbatim)
//   TwitchCheer             — username of the cheerer
//   TwitchCheerBits         — bit amount (continuous impulse, auto-
//                             clears to 0 like MouseWheel for clean
//                             integration with Spring modifiers)
//   TwitchChannelPoint      — reward title (e.g. "Hydrate", "Wave")
//   TwitchChannelPointUser  — redeeming user's name
//   TwitchChannelPointInput — user-supplied input (rewards that ask
//                             for input expose the user's text here)
//   TwitchRaid              — raider's username
//   TwitchRaidViewers       — raid viewer count (continuous impulse)
//   TwitchEventSubActive    — boolean, true while connected with a
//                             live session
//
// Why a separate source from TwitchChatSource?
//   The chat source connects anonymously and works without any user
//   gesture. The EventSub source requires OAuth — it's an explicit
//   opt-in. Keeping them separate means users who don't care about
//   channel points etc. don't see "Connect with Twitch" pressure.
//   They share the same status-bar section visually but operate
//   independently at runtime.
//
// Auth flow: implicit grant. Twitch's auth-code-grant flow requires
// a client_secret, which we can't safely embed in a desktop binary
// (anyone could extract it from the bundle). Twitch doesn't support
// PKCE for public clients either — so the implicit grant flow is the
// only safe option for desktop apps. Tokens come back directly in
// the URL fragment, no exchange step. Tokens last ~60 days; when
// expired, the user re-clicks Connect with Twitch.
//
// Token storage: access token in localStorage. No refresh token —
// implicit flow doesn't issue one. We handle 401s by clearing the
// stored token and surfacing a "please reconnect" state.
//
// Maintainer note on TWITCH_CLIENT_ID:
//   1. Visit https://dev.twitch.tv/console/apps and click
//      "Register Your Application".
//   2. Name: "PNGTuberUltra" (or anything you like).
//   3. OAuth Redirect URLs: http://localhost:47883/oauth/callback
//      (must match OAUTH_REDIRECT_URI exactly).
//   4. Category: "Application Integration".
//   5. Client Type: "Public" if available, else "Confidential" — we
//      use the implicit flow either way and never send a secret.
//   6. Save → copy the Client ID → paste below.
//   No Client Secret is needed. End users never see anything about
//   Client IDs once it's set.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";
import { oauthImplicitFlow, OAUTH_REDIRECT_URI } from "./oauth";

/** Twitch developer app Client ID. Maintainer fills this in after
 *  registering at dev.twitch.tv/console/apps. Empty string disables
 *  the "Connect with Twitch" button — TwitchChatSource (anonymous
 *  IRC) still works regardless. */
const TWITCH_CLIENT_ID = "";

/** OAuth scopes we request. Keep the list minimal — every extra scope
 *  is one more permission the user has to accept, and Twitch shows
 *  scope names verbatim in the consent screen. */
const TWITCH_SCOPES = [
  // Follows: requires moderator:read:followers AND that the auth'd
  // user is a moderator of the channel. For "watch my own follows"
  // (the common case) the user is moderator of themselves so this
  // works out.
  "moderator:read:followers",
  // Subscriptions: covers sub / resub / sub gift events.
  "channel:read:subscriptions",
  // Cheers: bits events.
  "bits:read",
  // Channel point redemptions: the flagship feature.
  "channel:read:redemptions",
].join(" ");

const AUTH_URL = "https://id.twitch.tv/oauth2/authorize";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const HELIX_SUBSCRIPTIONS_URL =
  "https://api.twitch.tv/helix/eventsub/subscriptions";
const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";

/** How long the impulse channels (TwitchCheerBits, TwitchRaidViewers)
 *  hold their value before auto-clearing to 0. Same idea as
 *  MouseWheel: bindings see a clean spike, then return to baseline. */
const IMPULSE_CLEAR_MS = 500;
/** Auto-clear delay for string impulse channels (follows, subs, etc.).
 *  Slightly longer than numeric impulses because string-equality
 *  visibility bindings tend to want a bigger window to read. */
const STRING_CLEAR_MS = 800;

export const TWITCH_EVENTSUB_CHANNELS = [
  "TwitchFollow",
  "TwitchSubEvent",
  "TwitchSubTier",
  "TwitchCheer",
  "TwitchCheerBits",
  "TwitchChannelPoint",
  "TwitchChannelPointUser",
  "TwitchChannelPointInput",
  "TwitchRaid",
  "TwitchRaidViewers",
  "TwitchEventSubActive",
] as const;

export type TwitchEventSubState =
  | "disconnected"
  | "authorizing"
  | "connecting"
  | "connected"
  | "error";

export interface TwitchEventSubInfo {
  state: TwitchEventSubState;
  /** Authenticated user's login name (lowercase), null when not
   *  connected. Useful for the StatusBar tooltip ("Connected as X"). */
  login: string | null;
  /** Most recent error message; populated when state === "error". */
  error: string | null;
}

interface TwitchTokenSnapshot {
  accessToken: string;
  userId: string;
  login: string;
  /** Unix epoch ms — surfaced in the UI so users see when they'll
   *  need to reconnect. Implicit flow doesn't give us refresh
   *  tokens; this is a one-shot expiration. */
  expiresAt: number;
}

interface EventSubMessage {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: Record<string, unknown>;
}

class TwitchEventSubSource {
  private ws: WebSocket | null = null;
  private state: TwitchEventSubState = "disconnected";
  private lastError: string | null = null;
  private tokens: TwitchTokenSnapshot | null = null;
  private sessionId: string | null = null;
  private impulseTimers: Map<string, number> = new Map();
  private connectionListeners = new Set<(info: TwitchEventSubInfo) => void>();
  /** Number of consecutive reconnect attempts since last successful
   *  connection — drives the backoff delay. Reset on `connected`. */
  private reconnectIndex = 0;
  private reconnectTimer: number | null = null;
  /** True if the user has explicitly disconnected — suppresses
   *  reconnect and clears stored tokens. */
  private intentionalDisconnect = false;

  constructor() {
    for (const c of TWITCH_EVENTSUB_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("TwitchEventSubActive", false);
    inputBus.publish("TwitchCheerBits", 0);
    inputBus.publish("TwitchRaidViewers", 0);

    // Restore stored tokens and auto-reconnect if present. Auto-
    // reconnect on boot is fine here (unlike the IRC chat source,
    // which gates auto-connect behind a setting): EventSub events
    // are inherently rare (a follow / sub every few minutes at
    // most), so the avatar isn't going to suddenly start firing on
    // boot. Stale tokens get a 401 → cleared automatically.
    const saved = loadStoredTokens();
    if (saved) {
      this.tokens = saved;
      void this.connectWithTokens();
    }
  }

  destroy(): void {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.clearAllImpulseTimers();
    this.connectionListeners.clear();
    this.disconnectSocket();
    for (const c of TWITCH_EVENTSUB_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("TwitchEventSubActive", false);
  }

  subscribeConnection(
    listener: (info: TwitchEventSubInfo) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  isConfigured(): boolean {
    return TWITCH_CLIENT_ID.length > 0;
  }

  /** User-initiated connect via the Connect with Twitch button. Drives
   *  OAuth flow → token exchange → WebSocket connect. Idempotent in
   *  that calling while already connecting returns early. */
  async connect(): Promise<void> {
    if (this.state === "authorizing" || this.state === "connecting") return;
    if (!this.isConfigured()) {
      this.setState("error", "Twitch Client ID not configured (maintainer task)");
      return;
    }
    this.intentionalDisconnect = false;
    this.setState("authorizing", null);
    try {
      // Implicit grant: token comes back in the URL fragment; no
      // exchange step. force_verify prompts the user even if they've
      // already authorized — keeps "switch account" flows working
      // for streamers with a personal + main account.
      const result = await oauthImplicitFlow({
        flowId: "twitch",
        authUrl: AUTH_URL,
        clientId: TWITCH_CLIENT_ID,
        scope: TWITCH_SCOPES,
        extraParams: { force_verify: "true" },
      });

      // Validate to get user_id + login + expires_in. Twitch's
      // validate endpoint is the canonical way to derive these from
      // an access token (the implicit grant fragment doesn't include
      // them); EventSub subscription conditions use broadcaster_user_id.
      const validateResp = await fetch(VALIDATE_URL, {
        headers: { Authorization: `OAuth ${result.accessToken}` },
      });
      if (!validateResp.ok) {
        throw new Error(`Token validate failed: ${validateResp.status}`);
      }
      const validateJson = (await validateResp.json()) as {
        user_id: string;
        login: string;
        expires_in: number;
      };
      this.tokens = {
        accessToken: result.accessToken,
        userId: validateJson.user_id,
        login: validateJson.login,
        expiresAt: Date.now() + validateJson.expires_in * 1000,
      };
      saveStoredTokens(this.tokens);
      await this.connectWithTokens();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState("error", msg);
    }
  }

  /** User-initiated disconnect. Clears stored tokens so we don't
   *  silently reconnect next launch. */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.disconnectSocket();
    this.tokens = null;
    clearStoredTokens();
    this.setState("disconnected", null);
  }

  private async connectWithTokens(): Promise<void> {
    if (!this.tokens) return;
    this.setState("connecting", null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(EVENTSUB_WS_URL);
    } catch (e) {
      this.setState("error", e instanceof Error ? e.message : "WS error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => this.handleMessage(e);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => {
      // Errors are followed by a close — handle there.
    };
  }

  private async handleMessage(e: MessageEvent): Promise<void> {
    if (useSettings.getState().inputPaused) return;
    if (typeof e.data !== "string") return;
    let msg: EventSubMessage;
    try {
      msg = JSON.parse(e.data) as EventSubMessage;
    } catch {
      return;
    }
    const type = msg.metadata.message_type;
    if (type === "session_welcome") {
      const session = (msg.payload as { session?: { id?: string } }).session;
      if (session?.id) {
        this.sessionId = session.id;
        await this.subscribeAllEvents();
        this.setState("connected", null);
        this.reconnectIndex = 0;
      }
    } else if (type === "session_keepalive") {
      // No-op — the timestamp on the message is enough; the server
      // will close the socket if it doesn't get message ACKs in time,
      // and our reconnect logic handles the close.
    } else if (type === "session_reconnect") {
      // Twitch is asking us to reconnect to a different URL (host
      // migration). Close current socket; the close handler will
      // schedule reconnect with the same tokens. We don't honor the
      // provided reconnect_url URL — the simpler reconnect-via-default
      // works fine and avoids edge cases.
      this.disconnectSocket();
    } else if (type === "notification") {
      this.handleNotification(msg);
    } else if (type === "revocation") {
      // A subscription was revoked (token expired, user revoked auth,
      // etc.). For v1, we just log and let the next 401 on subscribe
      // / next reconnect surface a clean error.
      console.warn("[twitch] subscription revoked", msg);
    }
  }

  private handleNotification(msg: EventSubMessage): void {
    const subType = msg.metadata.subscription_type;
    if (!subType) return;
    const event = (msg.payload as { event?: Record<string, unknown> }).event ?? {};
    switch (subType) {
      case "channel.follow":
        this.publishImpulseString(
          "TwitchFollow",
          (event.user_name as string) ?? "",
          STRING_CLEAR_MS,
        );
        break;
      case "channel.subscribe":
      case "channel.subscription.message":
      case "channel.subscription.gift": {
        const userName = (event.user_name as string) ?? "";
        const tier = (event.tier as string) ?? "";
        this.publishImpulseString("TwitchSubEvent", userName, STRING_CLEAR_MS);
        this.publishImpulseString("TwitchSubTier", tier, STRING_CLEAR_MS);
        break;
      }
      case "channel.cheer": {
        const userName = (event.user_name as string) ?? "";
        const bits = (event.bits as number) ?? 0;
        this.publishImpulseString("TwitchCheer", userName, STRING_CLEAR_MS);
        this.publishImpulseNumber("TwitchCheerBits", bits, IMPULSE_CLEAR_MS);
        break;
      }
      case "channel.channel_points_custom_reward_redemption.add": {
        const reward = event.reward as { title?: string } | undefined;
        const userName = (event.user_name as string) ?? "";
        const userInput = (event.user_input as string) ?? "";
        this.publishImpulseString(
          "TwitchChannelPoint",
          reward?.title ?? "",
          STRING_CLEAR_MS,
        );
        this.publishImpulseString(
          "TwitchChannelPointUser",
          userName,
          STRING_CLEAR_MS,
        );
        this.publishImpulseString(
          "TwitchChannelPointInput",
          userInput,
          STRING_CLEAR_MS,
        );
        break;
      }
      case "channel.raid": {
        const fromUser = (event.from_broadcaster_user_name as string) ?? "";
        const viewers = (event.viewers as number) ?? 0;
        this.publishImpulseString("TwitchRaid", fromUser, STRING_CLEAR_MS);
        this.publishImpulseNumber(
          "TwitchRaidViewers",
          viewers,
          IMPULSE_CLEAR_MS,
        );
        break;
      }
      default:
        // Unknown subscription type — ignore but log so future events
        // we add are visible during development.
        console.debug("[twitch] unhandled event", subType, event);
    }
  }

  private async subscribeAllEvents(): Promise<void> {
    if (!this.tokens || !this.sessionId) return;
    const userId = this.tokens.userId;
    const subscriptions: Array<{
      type: string;
      version: string;
      condition: Record<string, string>;
    }> = [
      {
        type: "channel.follow",
        version: "2",
        condition: {
          broadcaster_user_id: userId,
          moderator_user_id: userId,
        },
      },
      {
        type: "channel.subscribe",
        version: "1",
        condition: { broadcaster_user_id: userId },
      },
      {
        type: "channel.subscription.message",
        version: "1",
        condition: { broadcaster_user_id: userId },
      },
      {
        type: "channel.subscription.gift",
        version: "1",
        condition: { broadcaster_user_id: userId },
      },
      {
        type: "channel.cheer",
        version: "1",
        condition: { broadcaster_user_id: userId },
      },
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: { broadcaster_user_id: userId },
      },
      {
        type: "channel.raid",
        version: "1",
        condition: { to_broadcaster_user_id: userId },
      },
    ];
    // Subscribe in parallel — Helix happily accepts concurrent POSTs
    // and we'd rather race them than serialize ~7 round trips.
    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        fetch(HELIX_SUBSCRIPTIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.tokens!.accessToken}`,
            "Client-Id": TWITCH_CLIENT_ID,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...sub,
            transport: {
              method: "websocket",
              session_id: this.sessionId,
            },
          }),
        }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled" && !r.value.ok) {
        const status = r.value.status;
        if (status === 401) {
          // Token expired / revoked. Implicit-grant tokens aren't
          // refreshable — drop everything and surface a clean
          // "please reconnect" state. The user re-clicks Connect.
          this.tokens = null;
          clearStoredTokens();
          this.setState("error", "Token expired — please reconnect");
          this.disconnectSocket();
          return;
        }
        const text = await r.value.text();
        console.warn(
          `[twitch] subscription ${subscriptions[i]!.type} failed: ${status} ${text}`,
        );
      } else if (r.status === "rejected") {
        console.warn(
          `[twitch] subscription ${subscriptions[i]!.type} rejected:`,
          r.reason,
        );
      }
    }
  }

  private handleClose(): void {
    inputBus.publish("TwitchEventSubActive", false);
    if (this.intentionalDisconnect) {
      this.setState("disconnected", null);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || !this.tokens) return;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const delay = delays[Math.min(this.reconnectIndex, delays.length - 1)]!;
    this.reconnectIndex++;
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWithTokens();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private disconnectSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // ignore
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

  private clearAllImpulseTimers(): void {
    for (const t of this.impulseTimers.values()) window.clearTimeout(t);
    this.impulseTimers.clear();
  }

  private setState(
    state: TwitchEventSubState,
    error: string | null,
  ): void {
    this.state = state;
    this.lastError = error;
    inputBus.publish("TwitchEventSubActive", state === "connected");
    const snap = this.snapshot();
    for (const l of this.connectionListeners) l(snap);
  }

  private snapshot(): TwitchEventSubInfo {
    return {
      state: this.state,
      login: this.tokens?.login ?? null,
      error: this.lastError,
    };
  }
}

const TOKEN_STORAGE_KEY = "pngtuber-ultra-twitch-tokens-v1";
function loadStoredTokens(): TwitchTokenSnapshot | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TwitchTokenSnapshot;
  } catch {
    return null;
  }
}
function saveStoredTokens(tokens: TwitchTokenSnapshot): void {
  // Note: localStorage is not encrypted. Twitch access tokens grant
  // read access to the channel's events but no destructive scopes
  // are requested, so the blast radius of localStorage exfiltration
  // is bounded. A future hardening pass could move tokens to OS
  // keychain via tauri-plugin-stronghold or similar.
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}
function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}
void OAUTH_REDIRECT_URI; // imported for documentation reference

let twitchEventSubSingleton: TwitchEventSubSource | null = null;
export function getTwitchEventSubSource(): TwitchEventSubSource {
  if (!twitchEventSubSingleton) {
    twitchEventSubSingleton = new TwitchEventSubSource();
  }
  return twitchEventSubSingleton;
}

export function resetTwitchEventSubSource(): void {
  twitchEventSubSingleton?.destroy();
  twitchEventSubSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetTwitchEventSubSource());
}
