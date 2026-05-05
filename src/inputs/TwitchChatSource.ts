// Twitch chat input source — anonymous IRC over WebSocket.
//
// Pipeline:
//   wss://irc-ws.chat.twitch.tv:443
//     → CAP REQ tags + commands (for subs, cheers, raids in IRC tags)
//     → PASS / NICK as anonymous (justinfan*)
//     → JOIN #channel
//     → onmessage: parse IRC frame, publish to InputBus
//
// Why anonymous IRC and not the EventSub WebSocket?
//   EventSub gives richer events (channel.follow, channel.subscribe,
//   channel_points redemptions) but requires a registered Twitch app +
//   OAuth flow + token storage. For a v1 that lets streamers wave their
//   PNGTuber at chat, the anonymous IRC stream covers ~80% of value
//   for ~5% of complexity:
//     - Chat messages: TwitchChatMessage / TwitchChatUser
//     - !commands:     TwitchChatCommand
//     - Cheers:        TwitchBits (parsed from `bits` IRC tag on PRIVMSG)
//     - Subs / resubs: TwitchSubscriber (parsed from USERNOTICE msg-id)
//   Channel point redemptions and raw follow events do require EventSub
//   — when someone asks, that's a clean second pass on this file.
//
// Channels published:
//   TwitchChatActive   — boolean, true while WebSocket is open AND has
//                        successfully JOIN'd the configured channel.
//   TwitchChatMessage  — string, last chat message body. Re-published
//                        per message so the version counter increments
//                        even when the same user repeats a message.
//   TwitchChatUser     — string, last chat user's display-name (or
//                        login if display-name tag is absent — falls
//                        back gracefully on bot accounts).
//   TwitchChatCommand  — string, the bare command word from a `!cmd`
//                        message (no leading "!"), or null if the
//                        latest message wasn't a command. Auto-clears
//                        to null after CMD_CLEAR_MS so bindings see a
//                        clean impulse instead of staying "stuck" on
//                        the last command. Same shape as MouseWheel.
//   TwitchBits         — number, last cheer amount. Auto-clears to 0
//                        after IMPULSE_CLEAR_MS. Pair with a Spring
//                        modifier to integrate the impulse over time.
//   TwitchSubscriber   — string, last subscriber's username. Same
//                        impulse + auto-clear pattern.
//
// Reconnection: WebSocket close (network blip, Twitch maintenance,
// channel offline) triggers exponential backoff up to 30s. We do NOT
// auto-reconnect after a destroy() / setChannel(null), only after
// unsolicited closes.
//
// YouTube: deferred. Same shape would publish `YoutubeChatMessage`,
// `YoutubeSuperChat`, etc. — but YouTube's Live Chat API requires OAuth
// 2.0 + polling /liveChatMessages, which is a substantial follow-up.
// When implemented, the YoutubeChatSource singleton lives next to this
// one and the binding picker enumerates both under a `streaming events`
// header.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

export const TWITCH_CHANNELS = [
  "TwitchChatActive",
  "TwitchChatMessage",
  "TwitchChatUser",
  "TwitchChatCommand",
  "TwitchBits",
  "TwitchSubscriber",
] as const;

const IRC_WS_URL = "wss://irc-ws.chat.twitch.tv:443";

/** How long after a !command fires before TwitchChatCommand auto-clears
 *  to null — long enough for binding edge detectors to fire, short
 *  enough that bindings don't stay stuck on the last command. */
const CMD_CLEAR_MS = 200;
/** Same idea for bits / subscriber impulse channels. Slightly longer
 *  than commands because animations triggered by these often want a
 *  more deliberate window. */
const IMPULSE_CLEAR_MS = 500;
/** Reconnect backoff schedule on unsolicited socket close. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

export type TwitchConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface TwitchConnectionInfo {
  state: TwitchConnectionState;
  /** Channel name we're trying to connect to (lower-cased). */
  channel: string | null;
  /** Most recent error message, set when state === "error". */
  error: string | null;
}

class TwitchChatSource {
  private ws: WebSocket | null = null;
  private channel: string | null = null;
  private state: TwitchConnectionState = "disconnected";
  private lastError: string | null = null;
  private reconnectIndex = 0;
  private reconnectTimer: number | null = null;
  /** True if the user explicitly disconnected — suppresses reconnect. */
  private intentionalDisconnect = false;
  private cmdClearTimer: number | null = null;
  private bitsClearTimer: number | null = null;
  private subClearTimer: number | null = null;
  private connectionListeners = new Set<
    (info: TwitchConnectionInfo) => void
  >();

  constructor() {
    for (const c of TWITCH_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("TwitchChatActive", false);
    inputBus.publish("TwitchBits", 0);
  }

  destroy(): void {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.clearImpulseTimers();
    this.connectionListeners.clear();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const c of TWITCH_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("TwitchChatActive", false);
    inputBus.publish("TwitchBits", 0);
  }

  subscribeConnection(
    listener: (info: TwitchConnectionInfo) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /** Set (or change) the channel to connect to. Pass null to disconnect.
   *  Lower-cases the input — Twitch IRC channels are always lowercase. */
  setChannel(channelName: string | null): void {
    const lc = channelName ? channelName.trim().toLowerCase() : null;
    if (lc === this.channel) return;
    this.channel = lc;
    this.intentionalDisconnect = lc === null;
    this.reconnectIndex = 0;
    this.clearReconnect();
    this.disconnectSocket();
    if (lc) this.openSocket();
    else this.setState("disconnected", null);
  }

  private snapshot(): TwitchConnectionInfo {
    return {
      state: this.state,
      channel: this.channel,
      error: this.lastError,
    };
  }

  private setState(
    state: TwitchConnectionState,
    error: string | null,
  ): void {
    this.state = state;
    this.lastError = error;
    inputBus.publish("TwitchChatActive", state === "connected");
    const snap = this.snapshot();
    for (const l of this.connectionListeners) l(snap);
  }

  private openSocket(): void {
    if (!this.channel) return;
    this.setState("connecting", null);
    this.intentionalDisconnect = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(IRC_WS_URL);
    } catch (e) {
      this.setState("error", e instanceof Error ? e.message : "WS error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (e) => this.handleMessage(e);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => {
      // Twitch's WebSocket gives error events that don't carry useful
      // diagnostic info — log the connection state and rely on the
      // close handler for reconnect. We don't surface the error
      // separately because every onerror is followed by an onclose
      // anyway.
    };
  }

  private disconnectSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private handleOpen(): void {
    if (!this.ws || !this.channel) return;
    // Request tags + commands capabilities — without `tags` we don't
    // get cheer / sub / display-name metadata; without `commands` we
    // don't get USERNOTICE for subs/raids.
    this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    // Anonymous read-only access — Twitch accepts any nick prefixed
    // `justinfan` without auth. Random suffix avoids collisions if
    // multiple instances of the editor run on the same network.
    const anonNick = `justinfan${Math.floor(Math.random() * 1_000_000)}`;
    this.ws.send(`PASS oauth:anonymous`);
    this.ws.send(`NICK ${anonNick}`);
    this.ws.send(`JOIN #${this.channel}`);
    // We optimistically transition to "connected" here; if the JOIN
    // fails (channel doesn't exist, banned nick), Twitch closes the
    // socket and we'll handle it as an unsolicited close.
    this.setState("connected", null);
    this.reconnectIndex = 0;
  }

  private handleClose(): void {
    if (this.intentionalDisconnect) {
      this.setState("disconnected", null);
      return;
    }
    this.setState("error", "connection lost");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || !this.channel) return;
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectIndex, RECONNECT_DELAYS_MS.length - 1)
      ]!;
    this.reconnectIndex++;
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearImpulseTimers(): void {
    if (this.cmdClearTimer !== null) {
      window.clearTimeout(this.cmdClearTimer);
      this.cmdClearTimer = null;
    }
    if (this.bitsClearTimer !== null) {
      window.clearTimeout(this.bitsClearTimer);
      this.bitsClearTimer = null;
    }
    if (this.subClearTimer !== null) {
      window.clearTimeout(this.subClearTimer);
      this.subClearTimer = null;
    }
  }

  private handleMessage(e: MessageEvent): void {
    if (useSettings.getState().inputPaused) return;
    const data = typeof e.data === "string" ? e.data : "";
    if (!data) return;
    // Twitch can batch multiple IRC frames in one WebSocket message,
    // delimited by \r\n. Parse line-by-line.
    for (const rawLine of data.split("\r\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      this.handleIrcLine(line);
    }
  }

  private handleIrcLine(line: string): void {
    // Server pings — must respond or Twitch closes the socket.
    if (line.startsWith("PING")) {
      this.ws?.send("PONG :tmi.twitch.tv");
      return;
    }
    const parsed = parseIrc(line);
    if (!parsed) return;
    if (parsed.command === "PRIVMSG") {
      this.handlePrivmsg(parsed);
    } else if (parsed.command === "USERNOTICE") {
      this.handleUsernotice(parsed);
    }
  }

  private handlePrivmsg(p: IrcMessage): void {
    const message = p.params[1] ?? "";
    if (!message) return;
    const user =
      p.tags["display-name"] || p.tags["login"] || p.prefix?.split("!")[0] || "";
    inputBus.publish("TwitchChatMessage", message);
    inputBus.publish("TwitchChatUser", user);

    // !command detection: first whitespace-delimited token starting
    // with "!". We strip the leading "!" so bindings can match on the
    // command name directly.
    const trimmed = message.trim();
    if (trimmed.startsWith("!")) {
      const cmd = trimmed.slice(1).split(/\s+/)[0] ?? "";
      if (cmd) {
        inputBus.publish("TwitchChatCommand", cmd);
        if (this.cmdClearTimer !== null)
          window.clearTimeout(this.cmdClearTimer);
        this.cmdClearTimer = window.setTimeout(() => {
          inputBus.publish("TwitchChatCommand", null);
          this.cmdClearTimer = null;
        }, CMD_CLEAR_MS);
      }
    }

    // Cheer detection: PRIVMSG with `bits` tag. Value is a string
    // integer total bits in the message.
    const bitsTag = p.tags["bits"];
    if (bitsTag) {
      const bits = parseInt(bitsTag, 10);
      if (Number.isFinite(bits) && bits > 0) {
        inputBus.publish("TwitchBits", bits);
        if (this.bitsClearTimer !== null)
          window.clearTimeout(this.bitsClearTimer);
        this.bitsClearTimer = window.setTimeout(() => {
          inputBus.publish("TwitchBits", 0);
          this.bitsClearTimer = null;
        }, IMPULSE_CLEAR_MS);
      }
    }
  }

  private handleUsernotice(p: IrcMessage): void {
    // Sub / resub / subgift / raid all come through USERNOTICE with
    // a `msg-id` tag that disambiguates. We unify "this user just
    // subbed in some way" into TwitchSubscriber for v1 — finer-grained
    // events (sub vs subgift vs resub) can split into their own
    // channels later.
    const msgId = p.tags["msg-id"];
    if (
      msgId === "sub" ||
      msgId === "resub" ||
      msgId === "subgift" ||
      msgId === "anonsubgift" ||
      msgId === "submysterygift"
    ) {
      const user =
        p.tags["display-name"] || p.tags["login"] || "anonymous";
      inputBus.publish("TwitchSubscriber", user);
      if (this.subClearTimer !== null)
        window.clearTimeout(this.subClearTimer);
      this.subClearTimer = window.setTimeout(() => {
        inputBus.publish("TwitchSubscriber", null);
        this.subClearTimer = null;
      }, IMPULSE_CLEAR_MS);
    }
  }
}

interface IrcMessage {
  tags: Record<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
}

/** Parse a Twitch IRC line. Twitch's IRCv3 tags format:
 *    @tag1=value1;tag2=value2 :prefix COMMAND param1 param2 :trailing
 *  Tags are optional; trailing param is everything after the second `:`
 *  (the actual chat message body for PRIVMSG). */
function parseIrc(line: string): IrcMessage | null {
  if (!line) return null;
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    const tagSection = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const pair of tagSection.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) tags[pair] = "";
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
  }
  let prefix: string | null = null;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  // Trailing parameter starts at " :".
  const trailingIndex = rest.indexOf(" :");
  let trailing: string | null = null;
  if (trailingIndex >= 0) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }
  const parts = rest.split(" ").filter(Boolean);
  const command = parts[0] ?? "";
  const params = parts.slice(1);
  if (trailing !== null) params.push(trailing);
  return { tags, prefix, command, params };
}

/** Twitch's IRCv3 tag escaping — semicolons / spaces / newlines etc are
 *  escape-encoded in tag values. We undo it here. */
function unescapeTag(v: string): string {
  return v
    .replace(/\\:/g, ";")
    .replace(/\\s/g, " ")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

let twitchSingleton: TwitchChatSource | null = null;
export function getTwitchChatSource(): TwitchChatSource {
  if (!twitchSingleton) twitchSingleton = new TwitchChatSource();
  return twitchSingleton;
}

export function resetTwitchChatSource(): void {
  twitchSingleton?.destroy();
  twitchSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetTwitchChatSource());
}
