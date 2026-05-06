// YouTube Live Chat input source — OAuth 2.0 + polling.
//
// Pipeline:
//   1. User clicks "Connect with YouTube" in StatusBar.
//   2. oauthFlow() drives Google's auth-code-with-PKCE flow.
//   3. POST oauth2.googleapis.com/token → access_token + refresh_token.
//   4. GET youtube/v3/liveBroadcasts?broadcastStatus=active&mine=true
//      → find the user's currently-live stream → snippet.liveChatId.
//      Poll every 60s if no active broadcast (the user may not be
//      live yet when they connect; we wait for them to go live).
//   5. Once we have liveChatId, GET youtube/v3/liveChat/messages?
//      liveChatId=…&pageToken=… every `pollingIntervalMillis` (the
//      response tells us how often to poll — typically ~5 seconds).
//   6. Parse messages → publish to bus.
//
// Why polling and not push? YouTube doesn't expose a push channel
// (no WebSocket / webhook for Live Chat). Polling is the only
// supported delivery mechanism. The 5s cadence is YouTube's
// recommendation; polling faster will get rate-limited.
//
// Channels published (impulses unless noted):
//   YoutubeChatMessage      — last text chat body
//   YoutubeChatUser         — last user's display name
//   YoutubeChatCommand      — last !command name (impulse, auto-clears)
//   YoutubeSuperChat        — donor's display name (impulse)
//   YoutubeSuperChatAmount  — amount in dollars (continuous impulse;
//                             we convert from amountMicros to whole
//                             units for binding ergonomics — $5.00
//                             arrives as 5, not 5_000_000)
//   YoutubeMember           — new member's display name (impulse)
//   YoutubeMemberMonths     — milestone month count (impulse)
//   YoutubeChatActive       — boolean: connected with a live broadcast
//
// API quotas:
//   YouTube Data API v3 has a daily quota (10k units default, request-
//   able up). Polling /liveChat/messages costs 5 units per request.
//   At 5s cadence that's 7,200 units/day per active broadcast — fits
//   comfortably under the default for a single streamer.
//
// Token storage: same localStorage approach as Twitch. Refresh
// tokens for offline access (we request access_type=offline +
// prompt=consent on every connect to ensure we get one).
//
// Maintainer note on YOUTUBE_CLIENT_ID:
//   1. console.cloud.google.com → New Project (or use existing).
//   2. APIs & Services → Library → enable "YouTube Data API v3".
//   3. APIs & Services → OAuth consent screen → External + add the
//      `youtube.readonly` scope. Add yourself as a test user while
//      the app is in test mode.
//   4. APIs & Services → Credentials → Create Credentials → OAuth
//      client ID → Application type "Desktop app" (Google's
//      "Web application" type also works as long as you set the
//      redirect URI exactly to http://localhost:47883/oauth/callback).
//   5. Drop the resulting Client ID below.
//   The Client Secret is NOT used (PKCE handles secure auth code
//   exchange from a desktop app).

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";
import { oauthCodeFlow } from "./oauth";

/** Google OAuth Client ID. Maintainer fills this in. */
const YOUTUBE_CLIENT_ID = "";

const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LIVE_BROADCASTS_URL =
  "https://www.googleapis.com/youtube/v3/liveBroadcasts";
const LIVE_CHAT_MESSAGES_URL =
  "https://www.googleapis.com/youtube/v3/liveChat/messages";

/** How often to recheck for an active broadcast when none is live yet.
 *  60s feels right — broadcasts don't come up that often; polling
 *  faster mostly burns API quota for nothing. */
const BROADCAST_RECHECK_MS = 60_000;

/** Floor for the chat-message poll cadence. YouTube's response field
 *  `pollingIntervalMillis` tells us how often to poll; we honor that
 *  but never poll more often than this. Defends against a buggy /
 *  unexpected response that would otherwise burst us into rate limits. */
const MIN_CHAT_POLL_MS = 2_000;

const STRING_CLEAR_MS = 800;
const NUMERIC_CLEAR_MS = 500;

export const YOUTUBE_CHANNELS = [
  "YoutubeChatMessage",
  "YoutubeChatUser",
  "YoutubeChatCommand",
  "YoutubeSuperChat",
  "YoutubeSuperChatAmount",
  "YoutubeMember",
  "YoutubeMemberMonths",
  "YoutubeChatActive",
] as const;

export type YoutubeState =
  | "disconnected"
  | "authorizing"
  | "waiting" /* connected, but no active broadcast yet */
  | "polling"
  | "error";

export interface YoutubeConnectionInfo {
  state: YoutubeState;
  /** Authenticated user's channel display name, when available. */
  channelTitle: string | null;
  error: string | null;
}

interface YoutubeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  channelTitle: string | null;
}

interface YoutubeChatMessage {
  id: string;
  snippet: {
    type: string;
    publishedAt: string;
    hasDisplayContent: boolean;
    displayMessage?: string;
    textMessageDetails?: { messageText: string };
    superChatDetails?: {
      amountMicros: string;
      currency: string;
      amountDisplayString: string;
      userComment?: string;
      tier?: number;
    };
    superStickerDetails?: {
      amountMicros: string;
      currency: string;
      amountDisplayString: string;
      tier?: number;
    };
    memberMilestoneChatDetails?: {
      memberMonth: number;
      userComment?: string;
    };
  };
  authorDetails: {
    channelId: string;
    displayName: string;
    isChatModerator: boolean;
    isChatOwner: boolean;
    isChatSponsor: boolean;
    isVerified: boolean;
  };
}

class YoutubeChatSource {
  private tokens: YoutubeTokens | null = null;
  private state: YoutubeState = "disconnected";
  private lastError: string | null = null;
  private liveChatId: string | null = null;
  private nextPageToken: string | null = null;
  private pollTimer: number | null = null;
  private impulseTimers: Map<string, number> = new Map();
  private connectionListeners = new Set<
    (info: YoutubeConnectionInfo) => void
  >();
  private intentionalDisconnect = false;

  constructor() {
    for (const c of YOUTUBE_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("YoutubeChatActive", false);
    inputBus.publish("YoutubeSuperChatAmount", 0);
    inputBus.publish("YoutubeMemberMonths", 0);

    const saved = loadStoredTokens();
    if (saved) {
      this.tokens = saved;
      void this.startPollingFlow();
    }
  }

  destroy(): void {
    this.intentionalDisconnect = true;
    this.clearPollTimer();
    this.clearAllImpulseTimers();
    this.connectionListeners.clear();
    for (const c of YOUTUBE_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("YoutubeChatActive", false);
  }

  isConfigured(): boolean {
    return YOUTUBE_CLIENT_ID.length > 0;
  }

  subscribeConnection(
    listener: (info: YoutubeConnectionInfo) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.state === "authorizing" || this.state === "polling") return;
    if (!this.isConfigured()) {
      this.setState("error", "YouTube Client ID not configured (maintainer task)");
      return;
    }
    this.intentionalDisconnect = false;
    this.setState("authorizing", null);
    try {
      const result = await oauthCodeFlow({
        flowId: "youtube",
        authUrl: AUTH_URL,
        clientId: YOUTUBE_CLIENT_ID,
        scope: YOUTUBE_SCOPES,
        // access_type=offline + prompt=consent → guarantees a refresh
        // token in the response. Without prompt=consent, Google omits
        // the refresh token on subsequent connects (security feature
        // for incremental auth — but we want the token every time
        // since we may have lost the previous one).
        extraParams: {
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      });
      const tokenResp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: YOUTUBE_CLIENT_ID,
          code: result.code,
          code_verifier: result.codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: result.redirectUri,
        }).toString(),
      });
      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
      }
      const tokenJson = (await tokenResp.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      // Find the user's channel title for UX (StatusBar tooltip).
      const channelTitle = await this.fetchOwnChannelTitle(
        tokenJson.access_token,
      );
      this.tokens = {
        accessToken: tokenJson.access_token,
        // Google sometimes omits the refresh token on re-auth — fall
        // back to existing one if so.
        refreshToken:
          tokenJson.refresh_token ?? this.tokens?.refreshToken ?? "",
        expiresAt: Date.now() + tokenJson.expires_in * 1000,
        channelTitle,
      };
      saveStoredTokens(this.tokens);
      await this.startPollingFlow();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState("error", msg);
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearPollTimer();
    this.tokens = null;
    this.liveChatId = null;
    this.nextPageToken = null;
    clearStoredTokens();
    this.setState("disconnected", null);
  }

  private async startPollingFlow(): Promise<void> {
    if (!this.tokens) return;
    this.intentionalDisconnect = false;
    this.setState("waiting", null);
    await this.findActiveBroadcast();
  }

  private async findActiveBroadcast(): Promise<void> {
    if (this.intentionalDisconnect || !this.tokens) return;
    const url = new URL(LIVE_BROADCASTS_URL);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("broadcastStatus", "active");
    url.searchParams.set("mine", "true");
    const resp = await this.authFetch(url.toString());
    if (!resp) return; // auth error already surfaced
    if (!resp.ok) {
      // Quota exceeded / temporary errors — retry on the broadcast
      // recheck cadence rather than tearing down.
      this.setState("error", `liveBroadcasts ${resp.status}`);
      this.scheduleNextBroadcastCheck();
      return;
    }
    const json = (await resp.json()) as {
      items?: Array<{
        snippet?: { liveChatId?: string; title?: string };
      }>;
    };
    const item = json.items?.[0];
    const chatId = item?.snippet?.liveChatId;
    if (!chatId) {
      // No active broadcast — keep waiting.
      this.setState("waiting", null);
      this.scheduleNextBroadcastCheck();
      return;
    }
    this.liveChatId = chatId;
    // Use the very first poll (no pageToken) to skip backlog. We
    // explicitly want forward-only chat to avoid replaying messages
    // from earlier in the stream.
    this.nextPageToken = null;
    this.setState("polling", null);
    void this.pollChatMessages();
  }

  private scheduleNextBroadcastCheck(): void {
    this.clearPollTimer();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.findActiveBroadcast();
    }, BROADCAST_RECHECK_MS);
  }

  private async pollChatMessages(): Promise<void> {
    if (this.intentionalDisconnect || !this.liveChatId) return;
    const url = new URL(LIVE_CHAT_MESSAGES_URL);
    url.searchParams.set("liveChatId", this.liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    url.searchParams.set("maxResults", "200");
    if (this.nextPageToken) {
      url.searchParams.set("pageToken", this.nextPageToken);
    }
    const resp = await this.authFetch(url.toString());
    if (!resp) return;
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 404) {
        // Broadcast ended or chat disabled — go back to waiting.
        this.liveChatId = null;
        this.nextPageToken = null;
        this.setState("waiting", null);
        this.scheduleNextBroadcastCheck();
        return;
      }
      this.setState("error", `liveChat/messages ${resp.status}`);
      this.clearPollTimer();
      this.pollTimer = window.setTimeout(() => {
        this.pollTimer = null;
        void this.pollChatMessages();
      }, 10_000);
      return;
    }
    const json = (await resp.json()) as {
      items?: YoutubeChatMessage[];
      nextPageToken?: string;
      pollingIntervalMillis?: number;
    };
    const items = json.items ?? [];
    // First fetch returns backlog — by skipping the first batch we
    // ensure bindings only fire on messages sent AFTER the user
    // connected. After we have a nextPageToken, all subsequent
    // batches are the new messages since last poll.
    if (this.nextPageToken !== null) {
      for (const m of items) this.handleMessage(m);
    }
    this.nextPageToken = json.nextPageToken ?? this.nextPageToken;

    const interval = Math.max(
      MIN_CHAT_POLL_MS,
      json.pollingIntervalMillis ?? 5_000,
    );
    this.clearPollTimer();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.pollChatMessages();
    }, interval);
  }

  private handleMessage(m: YoutubeChatMessage): void {
    if (useSettings.getState().inputPaused) return;
    const author = m.authorDetails.displayName;
    const type = m.snippet.type;
    switch (type) {
      case "textMessageEvent": {
        const text = m.snippet.textMessageDetails?.messageText ?? "";
        this.publishImpulseString("YoutubeChatMessage", text, STRING_CLEAR_MS);
        this.publishImpulseString("YoutubeChatUser", author, STRING_CLEAR_MS);
        const trimmed = text.trim();
        if (trimmed.startsWith("!")) {
          const cmd = trimmed.slice(1).split(/\s+/)[0] ?? "";
          if (cmd) {
            this.publishImpulseString(
              "YoutubeChatCommand",
              cmd,
              STRING_CLEAR_MS,
            );
          }
        }
        break;
      }
      case "superChatEvent": {
        const sc = m.snippet.superChatDetails;
        if (!sc) break;
        const amount = parseInt(sc.amountMicros, 10) / 1_000_000;
        this.publishImpulseString("YoutubeSuperChat", author, STRING_CLEAR_MS);
        this.publishImpulseNumber(
          "YoutubeSuperChatAmount",
          amount,
          NUMERIC_CLEAR_MS,
        );
        break;
      }
      case "superStickerEvent": {
        const ss = m.snippet.superStickerDetails;
        if (!ss) break;
        const amount = parseInt(ss.amountMicros, 10) / 1_000_000;
        // Treat super stickers as super chats for v1 — the avatar
        // doesn't need to distinguish; both are paid attention.
        this.publishImpulseString("YoutubeSuperChat", author, STRING_CLEAR_MS);
        this.publishImpulseNumber(
          "YoutubeSuperChatAmount",
          amount,
          NUMERIC_CLEAR_MS,
        );
        break;
      }
      case "newSponsorEvent": {
        // YouTube channel members ("sponsors" in the API).
        this.publishImpulseString("YoutubeMember", author, STRING_CLEAR_MS);
        this.publishImpulseNumber("YoutubeMemberMonths", 1, NUMERIC_CLEAR_MS);
        break;
      }
      case "memberMilestoneChatEvent": {
        const months =
          m.snippet.memberMilestoneChatDetails?.memberMonth ?? 0;
        this.publishImpulseString("YoutubeMember", author, STRING_CLEAR_MS);
        this.publishImpulseNumber(
          "YoutubeMemberMonths",
          months,
          NUMERIC_CLEAR_MS,
        );
        break;
      }
      default:
        // Other event types (chatEndedEvent, sponsorOnly toggles, etc.)
        // — quietly skip.
        break;
    }
  }

  /** Wrap fetch with auth header injection + automatic refresh on 401.
   *  Returns null if auth is irrecoverably broken (token cleared). */
  private async authFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response | null> {
    if (!this.tokens) return null;
    const doFetch = (token: string) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    let resp = await doFetch(this.tokens.accessToken);
    if (resp.status !== 401) return resp;
    // Try refresh once.
    const refreshed = await this.tryRefresh();
    if (!refreshed) {
      this.tokens = null;
      clearStoredTokens();
      this.setState("error", "Token expired — please reconnect");
      return null;
    }
    resp = await doFetch(this.tokens!.accessToken);
    return resp;
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.tokens || !this.tokens.refreshToken) return false;
    try {
      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: YOUTUBE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: this.tokens.refreshToken,
        }).toString(),
      });
      if (!resp.ok) return false;
      const json = (await resp.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string;
      };
      this.tokens = {
        ...this.tokens,
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? this.tokens.refreshToken,
        expiresAt: Date.now() + json.expires_in * 1000,
      };
      saveStoredTokens(this.tokens);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchOwnChannelTitle(
    accessToken: string,
  ): Promise<string | null> {
    try {
      const resp = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        items?: Array<{ snippet?: { title?: string } }>;
      };
      return json.items?.[0]?.snippet?.title ?? null;
    } catch {
      return null;
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
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

  private setState(state: YoutubeState, error: string | null): void {
    this.state = state;
    this.lastError = error;
    inputBus.publish("YoutubeChatActive", state === "polling");
    const snap = this.snapshot();
    for (const l of this.connectionListeners) l(snap);
  }

  private snapshot(): YoutubeConnectionInfo {
    return {
      state: this.state,
      channelTitle: this.tokens?.channelTitle ?? null,
      error: this.lastError,
    };
  }
}

const TOKEN_STORAGE_KEY = "pngtuber-ultra-youtube-tokens-v1";
function loadStoredTokens(): YoutubeTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as YoutubeTokens;
  } catch {
    return null;
  }
}
function saveStoredTokens(tokens: YoutubeTokens): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}
function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

let youtubeChatSingleton: YoutubeChatSource | null = null;
export function getYoutubeChatSource(): YoutubeChatSource {
  if (!youtubeChatSingleton) youtubeChatSingleton = new YoutubeChatSource();
  return youtubeChatSingleton;
}

export function resetYoutubeChatSource(): void {
  youtubeChatSingleton?.destroy();
  youtubeChatSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetYoutubeChatSource());
}
