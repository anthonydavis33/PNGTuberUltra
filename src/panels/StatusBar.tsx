// Bottom-strip status bar.
//
// Two sections: mic (left) and keyboard (right). Each owns its own readouts
// and settings gear/popover. The gears are anchored to their respective
// sides; popovers open above their gears.
//
// Subscribes to InputBus channels via useInputValue — mic channels publish
// at ~60Hz so this component re-renders that often. Acceptable for a small
// leaf component; do NOT replicate this pattern in heavier panels.

import { useEffect, useState } from "react";
import {
  Camera,
  CameraOff,
  Gamepad2,
  Heart,
  HeartOff,
  Keyboard,
  KeyboardMusic,
  Mic,
  MicOff,
  MousePointer,
  Settings,
  Tv,
  Webhook,
  CirclePlay,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getMicSource } from "../inputs/MicSource";
import { getKeyboardSource } from "../inputs/KeyboardSource";
import { getGlobalKeyboardSource } from "../inputs/GlobalKeyboardSource";
import { getGlobalMouseSource } from "../inputs/GlobalMouseSource";
import { getWebcamSource } from "../inputs/WebcamSource";
import { getLipsyncSource } from "../inputs/LipsyncSource";
import { getMouseSource } from "../inputs/MouseSource";
import { getAutoBlinkSource } from "../inputs/AutoBlinkSource";
import { getGamepadSource } from "../inputs/GamepadSource";
import {
  getMidiSource,
  type MidiConnectionInfo,
} from "../inputs/MidiSource";
import {
  getHeartRateSource,
  type HeartRateConnectionInfo,
} from "../inputs/HeartRateSource";
import {
  getTwitchChatSource,
  type TwitchConnectionInfo,
} from "../inputs/TwitchChatSource";
import {
  getTwitchEventSubSource,
  type TwitchEventSubInfo,
} from "../inputs/TwitchEventSubSource";
import {
  getYoutubeChatSource,
  type YoutubeConnectionInfo,
} from "../inputs/YoutubeChatSource";
import { getWebhookSource } from "../inputs/WebhookSource";
import { getWindSource } from "../inputs/WindSource";
import { useAvatar } from "../store/useAvatar";
import { useSettings } from "../store/useSettings";
import { useInputValue } from "../hooks/useInputValue";
import { resolveThresholdColor } from "../types/avatar";
import { VolumeMeter } from "../components/VolumeMeter";
import { ThresholdPopover } from "./ThresholdPopover";
import { KeyboardPopover } from "./KeyboardPopover";
import { WebcamPopover } from "./WebcamPopover";

export function StatusBar() {
  const micConfig = useAvatar((s) => s.model.inputs?.mic);
  const keyboardConfig = useAvatar((s) => s.model.inputs?.keyboard);
  const autoBlinkConfig = useAvatar((s) => s.model.inputs?.autoBlink);
  const getMicConfig = useAvatar((s) => s.getMicConfig);
  const getKeyboardConfig = useAvatar((s) => s.getKeyboardConfig);
  const getAutoBlinkConfig = useAvatar((s) => s.getAutoBlinkConfig);
  const globalKeyboardEnabled = useSettings((s) => s.globalKeyboardEnabled);
  const setGlobalKeyboardEnabled = useSettings(
    (s) => s.setGlobalKeyboardEnabled,
  );
  const globalMouseEnabled = useSettings((s) => s.globalMouseEnabled);
  const setGlobalMouseEnabled = useSettings((s) => s.setGlobalMouseEnabled);

  const [isMicRunning, setIsMicRunning] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [showMicPopover, setShowMicPopover] = useState(false);
  const [showKbPopover, setShowKbPopover] = useState(false);

  const [isCamRunning, setIsCamRunning] = useState(false);
  const [isCamLoading, setIsCamLoading] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [showCamPopover, setShowCamPopover] = useState(false);

  // Eager-init the always-on singletons so InputBus has values to read on
  // first frame. Webcam is start-on-demand only. Lipsync is a derived
  // source that subscribes to MicPhoneme + Viseme — must construct AFTER
  // those publish their initial null values, or its initial recompute
  // sees nothing meaningful.
  //
  // KeyboardSource is constructed here but NOT started — the coordinator
  // effect below picks local vs global based on the user's setting.
  useState(() => {
    getMicSource(useAvatar.getState().getMicConfig());
    getKeyboardSource();
    getGlobalKeyboardSource();
    getGlobalMouseSource();
    getMouseSource();
    getWebcamSource();
    getLipsyncSource();
    // Gamepad source listens for connect events from boot — the RAF
    // poll only spins up once a controller is plugged in, so this is
    // free CPU otherwise. Initial publish to the bus is null for every
    // Gamepad* channel so binding pickers see them on first render.
    getGamepadSource();
    // MIDI source eagerly requests Web MIDI access on construction.
    // First call triggers the OS / browser MIDI permission prompt;
    // subsequent constructions are no-ops thanks to the singleton.
    // Channels publish dynamically as the user touches knobs / keys
    // — no boot-time noise on the bus.
    getMidiSource();
    // Heart rate source: construction is cheap (no device call yet).
    // Real connection waits for the user to click the Connect button
    // in the StatusBar — Web Bluetooth requires a user gesture for
    // requestDevice(). We instantiate now just so the connection-
    // state subscriber and HeartRate*/HeartRateActive bus channels
    // are alive on first render.
    getHeartRateSource();
    // Twitch chat source: same pattern as HR — construction publishes
    // null channels, but no socket is opened until the auto-connect
    // effect (or a manual click) supplies a channel name.
    getTwitchChatSource();
    // Twitch EventSub: auto-restores from stored OAuth tokens if the
    // user previously connected. Requires a registered Twitch dev
    // app's Client ID — see TwitchEventSubSource header.
    getTwitchEventSubSource();
    // YouTube Live Chat: auto-restores from stored OAuth tokens.
    // Requires a Google Cloud OAuth Client ID — see
    // YoutubeChatSource header.
    getYoutubeChatSource();
    // Webhook receiver: subscribes to Tauri `webhook-event` events
    // emitted by the Rust HTTP server's POST /webhook/event endpoint.
    // External tools (TikTok bridges, Streamer.bot, custom scripts)
    // POST to http://localhost:47882/webhook/event to drive bindings.
    getWebhookSource();
    // Wind: synthetic ambient breeze. Self-gates on the windEnabled
    // setting — the source subscribes to it, only running its RAF
    // loop while enabled. Construction is cheap.
    getWindSource();
    // Apply current avatar's autoblink config — turns the source on
    // if the loaded avatar has it enabled, off otherwise. Subsequent
    // config changes route through the model-subscription effect
    // below.
    getAutoBlinkSource().applyConfig(
      useAvatar.getState().getAutoBlinkConfig(),
    );
    return null;
  });

  // Rust listener toggle: ON whenever EITHER global keyboard or
  // global mouse needs it; OFF only when both are disabled. The
  // command is cheap to call repeatedly (Rust ignores duplicate
  // enable; spawned thread persists for the life of the process)
  // so re-firing on every settings change is fine.
  useEffect(() => {
    const wantGlobal = globalKeyboardEnabled || globalMouseEnabled;
    invoke("set_global_input_enabled", { enabled: wantGlobal }).catch(
      (err) => {
        console.error("[global-input] Rust toggle failed:", err);
      },
    );
  }, [globalKeyboardEnabled, globalMouseEnabled]);

  // Keyboard source coordinator: exactly one of {local, global} is
  // active at a time so focused-window presses don't double-fire.
  // Same fail-safe pattern as before — on global startup error, log
  // and fall back to local + flip the setting off.
  useEffect(() => {
    const local = getKeyboardSource();
    const global = getGlobalKeyboardSource();

    let cancelled = false;
    if (globalKeyboardEnabled) {
      local.stop();
      global.start().catch((err) => {
        if (cancelled) return;
        console.error(
          "[keyboard] global hook failed, falling back to local:",
          err,
        );
        setGlobalKeyboardEnabled(false);
        local.start();
      });
    } else {
      void global.stop();
      local.start();
    }
    return () => {
      cancelled = true;
    };
  }, [globalKeyboardEnabled, setGlobalKeyboardEnabled]);

  // Mouse coordinator. Local source keeps publishing canvas-relative
  // position regardless (the editor needs that for sprite drag etc.);
  // global takes over buttons + wheel + screen position.
  useEffect(() => {
    const global = getGlobalMouseSource();
    let cancelled = false;
    if (globalMouseEnabled) {
      global.start().catch((err) => {
        if (cancelled) return;
        console.error(
          "[mouse] global hook failed, falling back to local:",
          err,
        );
        setGlobalMouseEnabled(false);
      });
    } else {
      void global.stop();
    }
    return () => {
      cancelled = true;
    };
  }, [globalMouseEnabled, setGlobalMouseEnabled]);

  const volume = useInputValue<number>("MicVolume") ?? 0;
  const state = useInputValue<string | null>("MicState");
  const phoneme = useInputValue<string | null>("MicPhoneme");
  const holdProgress = useInputValue<number | null>("MicHoldProgress");
  const lastKey = useInputValue<string | null>("KeyEvent");
  const region = useInputValue<string | null>("KeyRegion");
  const mouseX = useInputValue<number | null>("MouseX");
  const mouseY = useInputValue<number | null>("MouseY");
  const mouseInside = useInputValue<boolean | null>("MouseInside");
  const headYaw = useInputValue<number>("HeadYaw") ?? 0;
  const headPitch = useInputValue<number>("HeadPitch") ?? 0;
  const headRoll = useInputValue<number>("HeadRoll") ?? 0;
  const mouthOpen = useInputValue<number>("MouthOpen") ?? 0;
  const browRaise = useInputValue<number>("BrowRaise") ?? 0;
  const eyesClosed = useInputValue<number>("EyesClosed") ?? 0;
  const gazeX = useInputValue<number>("GazeX") ?? 0;
  const gazeY = useInputValue<number>("GazeY") ?? 0;
  const viseme = useInputValue<string | null>("Viseme");
  const lipsync = useInputValue<string | null>("Lipsync");
  // Gamepad live readouts — left stick + a few buttons. The bus
  // publishes these only when a pad is plugged in, so values default
  // to 0/false until then. The pad-connected indicator is driven off
  // GamepadSource's own subscribeConnection (not bus channels) since
  // we want a single "is anything plugged in" boolean and the pad
  // model name string.
  const gpLX = useInputValue<number | null>("GamepadLX");
  const gpLY = useInputValue<number | null>("GamepadLY");
  const [gamepadInfo, setGamepadInfo] = useState<{
    connected: boolean;
    name: string | null;
  }>({ connected: false, name: null });
  useEffect(() => {
    return getGamepadSource().subscribeConnection(setGamepadInfo);
  }, []);
  // MIDI live readouts: last CC# + value, last note number + velocity.
  // The "Any" channels update on every MIDI event regardless of which
  // controller fired, so they're the right pulse to show in a status
  // strip. Per-CC / per-note dynamic channels are only relevant inside
  // the binding picker.
  const midiCCAny = useInputValue<number | null>("MidiCCAny");
  const midiCCNumber = useInputValue<number | null>("MidiCCNumber");
  const midiNoteAny = useInputValue<number | null>("MidiNoteAny");
  const midiVelocity = useInputValue<number | null>("MidiVelocity");
  const [midiInfo, setMidiInfo] = useState<MidiConnectionInfo>({
    permission: "unknown",
    devices: [],
  });
  useEffect(() => {
    return getMidiSource().subscribeConnection(setMidiInfo);
  }, []);
  // Heart rate: BPM is the only thing the StatusBar actually displays
  // (HeartRateActive is implicit in whether BPM is null).
  const heartRate = useInputValue<number | null>("HeartRate");
  const [hrInfo, setHrInfo] = useState<HeartRateConnectionInfo>({
    state: "disconnected",
    deviceName: null,
    error: null,
  });
  useEffect(() => {
    return getHeartRateSource().subscribeConnection(setHrInfo);
  }, []);
  // Connect button click handler — must run from a user gesture
  // because Web Bluetooth's requestDevice() is gated on it. We also
  // route disconnect through the same button for the connected case.
  const handleHeartRateClick = (): void => {
    const src = getHeartRateSource();
    if (hrInfo.state === "connected") {
      void src.disconnect();
    } else {
      void src.connect();
    }
  };
  // Twitch chat — channel name lives in useSettings (persisted across
  // launches); active socket lives in TwitchChatSource. We display the
  // last chat user/message + connection state, with an inline popover
  // for editing the channel and toggling auto-connect.
  const twitchChannelSetting = useSettings((s) => s.twitchChannel);
  const setTwitchChannelSetting = useSettings((s) => s.setTwitchChannel);
  const twitchAutoConnect = useSettings((s) => s.twitchAutoConnect);
  const setTwitchAutoConnect = useSettings((s) => s.setTwitchAutoConnect);
  // Streaming-integration panel visibility (toggled in the app
  // settings popover). Default off so a fresh install isn't crowded
  // with icons most users don't need; streamers turn them on once.
  const showTwitchPanel = useSettings((s) => s.showTwitchPanel);
  const showYoutubePanel = useSettings((s) => s.showYoutubePanel);
  const showWebhookPanel = useSettings((s) => s.showWebhookPanel);
  const lastChatMessage = useInputValue<string | null>("TwitchChatMessage");
  const lastChatUser = useInputValue<string | null>("TwitchChatUser");
  const [twitchInfo, setTwitchInfo] = useState<TwitchConnectionInfo>({
    state: "disconnected",
    channel: null,
    error: null,
  });
  const [showTwitchPopover, setShowTwitchPopover] = useState(false);
  const [twitchInput, setTwitchInput] = useState(twitchChannelSetting);
  // Sync the popover's text input with the persisted setting whenever
  // the setting changes externally (e.g. settings imported, multi-tab).
  useEffect(() => setTwitchInput(twitchChannelSetting), [twitchChannelSetting]);
  useEffect(() => {
    return getTwitchChatSource().subscribeConnection(setTwitchInfo);
  }, []);
  // Auto-connect on boot when the user has flipped the auto-connect
  // toggle. We re-run if either setting changes — flipping auto on
  // immediately connects; flipping off disconnects the socket. Manual
  // connect via the popover bypasses this.
  useEffect(() => {
    const src = getTwitchChatSource();
    if (twitchAutoConnect && twitchChannelSetting.trim()) {
      src.setChannel(twitchChannelSetting.trim());
    } else if (!twitchAutoConnect) {
      src.setChannel(null);
    }
  }, [twitchAutoConnect, twitchChannelSetting]);
  const handleTwitchConnect = (): void => {
    const trimmed = twitchInput.trim();
    setTwitchChannelSetting(trimmed);
    if (trimmed) {
      getTwitchChatSource().setChannel(trimmed);
    } else {
      getTwitchChatSource().setChannel(null);
    }
  };
  const handleTwitchDisconnect = (): void => {
    getTwitchChatSource().setChannel(null);
  };
  // Twitch EventSub (OAuth) — separate state from chat. Authorizing
  // the app unlocks channel point redemptions, follows, raids, subs.
  const [twitchEventSubInfo, setTwitchEventSubInfo] =
    useState<TwitchEventSubInfo>({
      state: "disconnected",
      login: null,
      error: null,
    });
  useEffect(() => {
    return getTwitchEventSubSource().subscribeConnection(setTwitchEventSubInfo);
  }, []);

  // When EventSub is connected (either via fresh OAuth or by auto-
  // restoring from saved tokens on launch), auto-mirror the user's
  // login into the IRC chat channel and connect there too. This is
  // why the popover only needs ONE "Connect with Twitch" button —
  // OAuth implies the user wants their own channel monitored, and
  // their login is exactly the IRC channel name. If they later want
  // to monitor someone else's chat, the secondary "watch different
  // channel" section overrides this.
  useEffect(() => {
    if (
      twitchEventSubInfo.state === "connected" &&
      twitchEventSubInfo.login
    ) {
      const login = twitchEventSubInfo.login;
      setTwitchChannelSetting(login);
      getTwitchChatSource().setChannel(login);
    }
  }, [twitchEventSubInfo.state, twitchEventSubInfo.login, setTwitchChannelSetting]);

  /** Unified Twitch connect/disconnect — drives both OAuth (EventSub)
   *  AND IRC chat as one user-facing action. The auto-mirror effect
   *  above handles "OAuth → chat connect" once the login lands;
   *  here we only need to kick off OAuth or tear both down. */
  const handleTwitchUnifiedClick = (): void => {
    const eventSub = getTwitchEventSubSource();
    if (
      twitchEventSubInfo.state === "connected" ||
      twitchEventSubInfo.state === "connecting" ||
      twitchEventSubInfo.state === "authorizing"
    ) {
      // Disconnect both. EventSub clears its tokens; IRC drops the
      // socket. The persisted channel name is cleared too so a
      // restart doesn't silently reconnect to the previous account.
      eventSub.disconnect();
      getTwitchChatSource().setChannel(null);
      setTwitchChannelSetting("");
    } else {
      void eventSub.connect();
    }
  };

  /** Whether the user's current chat connection is to a *different*
   *  channel than their OAuth login — i.e. they explicitly used the
   *  secondary "watch a different channel" affordance. The unified
   *  Connect button shouldn't claim to "disconnect everything" when
   *  the user is also actively monitoring someone else's chat. */
  const isWatchingOtherChannel =
    twitchInfo.state === "connected" &&
    !!twitchInfo.channel &&
    twitchEventSubInfo.login !== null &&
    twitchInfo.channel.toLowerCase() !==
      twitchEventSubInfo.login.toLowerCase();

  /** OAuth requires a registered Twitch Client ID. If the maintainer
   *  hasn't filled it in (TWITCH_CLIENT_ID empty in source), surface
   *  a clear setup-task message with a one-click link to the Twitch
   *  dev console — this is a maintainer-only situation, not an
   *  end-user one. */
  const twitchOAuthConfigured = getTwitchEventSubSource().isConfigured();
  // YouTube Live Chat (OAuth + polling).
  const lastYtMessage = useInputValue<string | null>("YoutubeChatMessage");
  const lastYtUser = useInputValue<string | null>("YoutubeChatUser");
  const [youtubeInfo, setYoutubeInfo] = useState<YoutubeConnectionInfo>({
    state: "disconnected",
    channelTitle: null,
    error: null,
  });
  useEffect(() => {
    return getYoutubeChatSource().subscribeConnection(setYoutubeInfo);
  }, []);
  const handleYoutubeClick = (): void => {
    const src = getYoutubeChatSource();
    if (
      youtubeInfo.state === "polling" ||
      youtubeInfo.state === "waiting" ||
      youtubeInfo.state === "authorizing"
    ) {
      src.disconnect();
    } else {
      void src.connect();
    }
  };
  // YouTube popover open/close + configured-flag for the same
  // maintainer-setup pattern Twitch uses. Without a Client ID
  // baked into the source, the Connect button would just throw —
  // surface a clear setup walkthrough instead.
  const [showYoutubePopover, setShowYoutubePopover] = useState(false);
  const youtubeOAuthConfigured = getYoutubeChatSource().isConfigured();

  // Webhook receiver — boolean active state + a generic event pulse
  // for the StatusBar readout.
  const lastWebhookEvent = useInputValue<string | null>("WebhookEvent");
  const lastWebhookSource = useInputValue<string | null>("WebhookSource");
  const [webhookActive, setWebhookActive] = useState(false);
  useEffect(() => {
    return getWebhookSource().subscribeActive(setWebhookActive);
  }, []);

  // Keep mic source config in sync with the avatar.
  useEffect(() => {
    const mic = getMicSource(getMicConfig());
    mic.updateConfig(getMicConfig());
  }, [micConfig, getMicConfig]);

  // Keep keyboard source config in sync with the avatar.
  useEffect(() => {
    getKeyboardSource().updateConfig(getKeyboardConfig());
  }, [keyboardConfig, getKeyboardConfig]);

  // Keep auto-blink source config in sync with the avatar. Toggling
  // enabled in the popover stops/starts the source; tweaking the
  // interval range applies on the next scheduled blink.
  useEffect(() => {
    getAutoBlinkSource().applyConfig(getAutoBlinkConfig());
  }, [autoBlinkConfig, getAutoBlinkConfig]);

  const handleMicToggle = async () => {
    const mic = getMicSource(getMicConfig());
    if (isMicRunning) {
      mic.stop();
      setIsMicRunning(false);
      return;
    }
    try {
      await mic.start();
      setIsMicRunning(true);
      setMicError(null);
    } catch (err) {
      console.error("Mic start failed:", err);
      setMicError(
        err instanceof Error
          ? err.message
          : "Microphone unavailable or denied",
      );
      setIsMicRunning(false);
    }
  };

  const handleCamToggle = async () => {
    const cam = getWebcamSource();
    if (isCamRunning) {
      cam.stop();
      setIsCamRunning(false);
      return;
    }
    setIsCamLoading(true);
    try {
      await cam.start();
      setIsCamRunning(true);
      setCamError(null);
    } catch (err) {
      console.error("Webcam start failed:", err);
      setCamError(
        err instanceof Error
          ? err.message
          : "Webcam unavailable or denied",
      );
      setIsCamRunning(false);
    } finally {
      setIsCamLoading(false);
    }
  };

  const mic = micConfig ?? getMicConfig();
  const sortedThresholds = [...mic.thresholds].sort(
    (a, b) => a.minVolume - b.minVolume,
  );

  return (
    <footer className="status-bar">
      <div className="status-bar-row status-bar-row-primary">
      {/* ============================ MIC SECTION ============================ */}
      <section className="status-section">
        <button
          className={`mic-toggle ${isMicRunning ? "live" : ""}`}
          onClick={handleMicToggle}
          title={
            isMicRunning
              ? "Stop microphone capture"
              : "Start mic — feeds MicVolume / MicState / MicPhoneme to bindings"
          }
        >
          {isMicRunning ? <Mic size={14} /> : <MicOff size={14} />}
          <span>{isMicRunning ? "Live" : "Off"}</span>
        </button>

        <button
          className="status-gear"
          onClick={() => {
            setShowMicPopover((v) => !v);
            setShowKbPopover(false);
            setShowCamPopover(false);
            setShowTwitchPopover(false);
            setShowYoutubePopover(false);
          }}
          title="Mic settings — thresholds, hold times, phoneme detection"
          aria-label="Mic settings"
        >
          <Settings size={14} />
        </button>

        {showMicPopover && (
          <ThresholdPopover onClose={() => setShowMicPopover(false)} />
        )}

        <VolumeMeter
          volume={volume}
          thresholds={sortedThresholds}
          activeStateName={state ?? null}
          onUpdateThreshold={(id, patch) => {
            const updated = mic.thresholds.map((t) =>
              t.id === id ? { ...t, ...patch } : t,
            );
            useAvatar.getState().updateMicConfig({ thresholds: updated });
          }}
          isMicRunning={isMicRunning}
        />

        {(() => {
          // Hold-meter fill takes the color of whichever threshold is
          // currently in its hold-decay phase, so the hold timer's
          // animation visibly belongs to the right band on the
          // volume meter. activeStateName might be null mid-decay if
          // we just hit the end of the timer, so fall back to the
          // last known threshold color.
          const activeIdx = sortedThresholds.findIndex(
            (t) => t.name === state,
          );
          const activeColor =
            activeIdx >= 0
              ? resolveThresholdColor(sortedThresholds[activeIdx], activeIdx)
              : "var(--accent)";
          return (
            <div
              className="hold-meter"
              title={
                holdProgress != null
                  ? `Hold timer: ${Math.round((1 - holdProgress) * 100)}% remaining`
                  : "Hold timer (idle)"
              }
              aria-label="State hold timer"
            >
              {holdProgress != null && (
                <div
                  className="hold-meter-fill"
                  style={{
                    width: `${Math.round((1 - holdProgress) * 100)}%`,
                    background: activeColor,
                  }}
                />
              )}
            </div>
          );
        })()}

        <div className="status-values">
          <span className="status-value">
            <span className="status-label">Vol</span>
            <span className="status-num">{volume.toFixed(2)}</span>
          </span>
          <span className="status-value">
            <span className="status-label">State</span>
            <span className="status-num">{state ?? "—"}</span>
          </span>
          {mic.phonemesEnabled && (
            <span className="status-value">
              <span className="status-label">Phon</span>
              <span className="status-num">{phoneme ?? "—"}</span>
            </span>
          )}
        </div>

        {micError && <span className="status-error">{micError}</span>}
      </section>

      {/* ============================ KEYBOARD SECTION ============================ */}
      <section className="status-section status-section-right">
        <Keyboard size={14} className="status-icon" />
        <div className="status-values">
          <span className="status-value">
            <span className="status-label">Last</span>
            <span className="status-num">{lastKey ?? "—"}</span>
          </span>
          <span className="status-value">
            <span className="status-label">Region</span>
            <span className="status-num">{region ?? "—"}</span>
          </span>
        </div>
        <button
          className="status-gear"
          onClick={() => {
            setShowKbPopover((v) => !v);
            setShowMicPopover(false);
            setShowCamPopover(false);
            setShowTwitchPopover(false);
            setShowYoutubePopover(false);
          }}
          title="Keyboard settings — regions, hotkeys"
          aria-label="Keyboard settings"
        >
          <Settings size={14} />
        </button>

        {showKbPopover && (
          <KeyboardPopover onClose={() => setShowKbPopover(false)} />
        )}
      </section>
      </div>

      {/* ============================ WEBCAM ROW (full readouts) =================== */}
      <div className="status-bar-row status-bar-row-secondary">
        <section className="status-section">
          <button
            className={`mic-toggle ${isCamRunning ? "live" : ""}`}
            onClick={handleCamToggle}
            disabled={isCamLoading}
            title={
              isCamRunning
                ? "Stop webcam tracking"
                : "Start webcam — feeds head pose, mouth, gaze, and blink to bindings"
            }
          >
            {isCamRunning ? <Camera size={14} /> : <CameraOff size={14} />}
            <span>
              {isCamLoading ? "Loading…" : isCamRunning ? "Live" : "Off"}
            </span>
          </button>

          <button
            className="status-gear"
            onClick={() => {
              setShowCamPopover((v) => !v);
              setShowMicPopover(false);
              setShowKbPopover(false);
              setShowTwitchPopover(false);
              setShowYoutubePopover(false);
            }}
            title="Webcam settings — calibration, smoothing"
            aria-label="Webcam settings"
          >
            <Settings size={14} />
          </button>

          {showCamPopover && (
            <WebcamPopover onClose={() => setShowCamPopover(false)} />
          )}

          <div className="status-values status-values-webcam">
            <span className="status-value">
              <span className="status-label">Yaw</span>
              <span className="status-num">{headYaw.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Pitch</span>
              <span className="status-num">{headPitch.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Roll</span>
              <span className="status-num">{headRoll.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Mouth</span>
              <span className="status-num">{mouthOpen.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Brow</span>
              <span className="status-num">{browRaise.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Eyes</span>
              <span className="status-num">{eyesClosed.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">GazeX</span>
              <span className="status-num">{gazeX.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">GazeY</span>
              <span className="status-num">{gazeY.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Vis</span>
              <span className="status-num">{viseme ?? "—"}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Lip</span>
              <span className="status-num">{lipsync ?? "—"}</span>
            </span>
          </div>

          {camError && <span className="status-error">{camError}</span>}
        </section>

        {/* Gamepad live readout — sits between webcam and mouse on the
            secondary row. The icon goes "live" when a controller is
            connected; the LX/LY pair shows the left stick (deadzoned)
            in -1..1 with Y-up. No settings popover for v1 — gamepad
            has no configurable options yet. */}
        <section
          className="status-section status-section-right"
          title={
            gamepadInfo.connected
              ? `Gamepad: ${gamepadInfo.name ?? "connected"}\nLeft stick (LX/LY) live values, -1..1 Y-up. Press a button to wake the controller if values stay at 0.`
              : "No gamepad connected. Plug in an Xbox / PlayStation / generic controller and press any button — it'll appear here and Gamepad* channels become available in binding pickers."
          }
        >
          <Gamepad2
            size={14}
            className={`status-icon ${gamepadInfo.connected ? "live" : ""}`}
          />
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">LX</span>
              <span className="status-num">
                {gamepadInfo.connected && gpLX != null
                  ? gpLX.toFixed(2)
                  : "—"}
              </span>
            </span>
            <span className="status-value">
              <span className="status-label">LY</span>
              <span className="status-num">
                {gamepadInfo.connected && gpLY != null
                  ? gpLY.toFixed(2)
                  : "—"}
              </span>
            </span>
          </div>
        </section>

        {/* MIDI live readout — sits between gamepad and mouse. Icon
            goes "live" when at least one MIDI input device is
            connected. Last CC + last note are shown as a pulse: which
            controller# / note# fired most recently and at what value
            / velocity. No popover yet — MIDI has no configurable
            options at the source level (devices are auto-bound). */}
        <section
          className="status-section status-section-right"
          title={
            midiInfo.permission === "denied"
              ? "MIDI permission denied. Reload and accept the prompt to enable Midi* channels in bindings."
              : midiInfo.permission === "unsupported"
                ? "Web MIDI is not available in this build of the webview. Midi* channels won't fire."
                : midiInfo.devices.length === 0
                  ? "No MIDI devices connected. Plug in a controller — its knobs become MidiCC{N} channels and keys become MidiNote{N} channels in the binding picker."
                  : `MIDI: ${midiInfo.devices.join(", ")}\nLast CC and last note shown as live pulse.`
          }
        >
          <KeyboardMusic
            size={14}
            className={`status-icon ${midiInfo.devices.length > 0 ? "live" : ""}`}
          />
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">CC</span>
              <span className="status-num">
                {midiCCNumber != null && midiCCAny != null
                  ? `${midiCCNumber}=${midiCCAny.toFixed(2)}`
                  : "—"}
              </span>
            </span>
            <span className="status-value">
              <span className="status-label">Note</span>
              <span className="status-num">
                {midiNoteAny != null && midiVelocity != null
                  ? `${midiNoteAny} v${midiVelocity.toFixed(2)}`
                  : "—"}
              </span>
            </span>
          </div>
        </section>

        {/* Heart rate — needs an explicit Connect button because Web
            Bluetooth's requestDevice() is gated on a user gesture
            (can't auto-init like MIDI / Gamepad). The button toggles
            connect / disconnect. Live BPM shown as a chip while
            connected; greyed "—" when not. */}
        <section
          className="status-section status-section-right"
          title={
            hrInfo.state === "connected"
              ? `Heart rate: ${hrInfo.deviceName ?? "connected"}\nClick the icon to disconnect.`
              : hrInfo.state === "connecting"
                ? "Connecting to heart rate monitor…"
                : hrInfo.state === "error"
                  ? `Heart rate connection error: ${hrInfo.error ?? "unknown"}\nClick the icon to retry.`
                  : "Click the icon to connect a Bluetooth heart rate monitor (Polar H10, Wahoo TICKR, Apple Watch via 3rd-party broadcaster, etc.). HeartRate channel will publish BPM."
          }
        >
          <button
            className={`status-gear ${hrInfo.state === "connected" ? "live" : ""}`}
            onClick={handleHeartRateClick}
            disabled={hrInfo.state === "connecting"}
            aria-label={
              hrInfo.state === "connected"
                ? "Disconnect heart rate"
                : "Connect heart rate"
            }
            title={
              hrInfo.state === "connected"
                ? "Disconnect"
                : hrInfo.state === "connecting"
                  ? "Connecting…"
                  : "Connect heart rate monitor"
            }
          >
            {hrInfo.state === "connected" ? (
              <Heart size={14} />
            ) : (
              <HeartOff size={14} />
            )}
          </button>
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">BPM</span>
              <span className="status-num">
                {heartRate != null ? heartRate.toFixed(0) : "—"}
              </span>
            </span>
          </div>
        </section>

        {/* Twitch chat — channel name editable via inline popover. The
            anonymous IRC connection is read-only; no OAuth required.
            EventSub-only events (channel.follow, channel point
            redemptions) need a future OAuth pass — chat-derived events
            (subs, cheers, !commands, raw messages) work today.
            Hidden by default — toggle on under Settings → Streaming
            integrations. */}
        {showTwitchPanel && (
        <section
          className="status-section status-section-right"
          title={
            twitchInfo.state === "connected"
              ? `Twitch chat: #${twitchInfo.channel ?? "?"}\nClick the icon to edit channel / disconnect.`
              : twitchInfo.state === "connecting"
                ? `Connecting to #${twitchInfo.channel ?? "?"}…`
                : twitchInfo.state === "error"
                  ? `Twitch chat error: ${twitchInfo.error ?? "unknown"}\nClick to reconfigure.`
                  : "No Twitch channel configured. Click the icon to enter a channel name and connect (anonymous read-only — no login required)."
          }
        >
          <button
            className={`status-gear ${twitchInfo.state === "connected" ? "live" : ""}`}
            onClick={() => {
              setShowTwitchPopover((v) => !v);
              setShowMicPopover(false);
              setShowKbPopover(false);
              setShowCamPopover(false);
              setShowYoutubePopover(false);
            }}
            aria-label="Twitch chat settings"
            title="Twitch chat settings"
          >
            <Tv size={14} />
          </button>
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">Chat</span>
              <span className="status-num">
                {twitchInfo.state === "connected" && lastChatUser
                  ? `${lastChatUser}: ${(lastChatMessage ?? "").slice(0, 16)}`
                  : twitchInfo.state === "connected"
                    ? "live"
                    : "—"}
              </span>
            </span>
          </div>
          {showTwitchPopover && (
            <div className="settings-popover twitch-popover">
              <div className="settings-popover-header">
                <h3>Twitch</h3>
                <button
                  className="popover-close"
                  onClick={() => setShowTwitchPopover(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {/* Primary: one-click Connect with Twitch.
                  OAuth (implicit grant) → token validate → login is
                  auto-mirrored into the IRC chat channel by the
                  useEffect above. So this single button connects BOTH
                  chat AND EventSub events. */}
              <section className="popover-section">
                <label className="popover-label">Twitch account</label>
                {!twitchOAuthConfigured ? (
                  // Maintainer setup task — the project's Twitch dev
                  // app Client ID isn't filled in yet. Show this
                  // INSTEAD of a clickable Connect button so the
                  // user (the dev) doesn't waste time clicking
                  // something that can't possibly work, and doesn't
                  // misinterpret an error message as an input field.
                  <>
                    <p className="popover-hint" style={{ marginTop: 0 }}>
                      <strong>One-time maintainer setup:</strong>{" "}
                      register a Twitch dev application to enable
                      OAuth login for this build.
                    </p>
                    <ol
                      className="popover-hint"
                      style={{
                        marginTop: 4,
                        paddingLeft: 18,
                      }}
                    >
                      <li>
                        Open{" "}
                        <a
                          href="https://dev.twitch.tv/console/apps"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent)" }}
                        >
                          dev.twitch.tv/console/apps
                        </a>{" "}
                        and click "Register Your Application".
                      </li>
                      <li>
                        OAuth Redirect URLs:{" "}
                        <code>http://localhost:47883/oauth/callback</code>
                      </li>
                      <li>Category: Application Integration.</li>
                      <li>
                        Paste the resulting Client ID into{" "}
                        <code>TWITCH_CLIENT_ID</code> in{" "}
                        <code>src/inputs/TwitchEventSubSource.ts</code>{" "}
                        and rebuild.
                      </li>
                    </ol>
                    <p className="popover-hint">
                      End users won't see this message once
                      configured — the Connect button will work
                      normally and pop the Twitch consent screen in
                      the browser.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="popover-hint" style={{ marginTop: 0 }}>
                      {twitchEventSubInfo.state === "connected" ? (
                        <>
                          Connected as <code>{twitchEventSubInfo.login}</code>
                          {" — "}chat ✓ and channel-point / follow /
                          raid events ✓
                        </>
                      ) : twitchEventSubInfo.state === "authorizing" ? (
                        "Opening browser for authorization…"
                      ) : twitchEventSubInfo.state === "connecting" ? (
                        "Connecting to EventSub…"
                      ) : twitchEventSubInfo.state === "error" ? (
                        <span style={{ color: "var(--danger)" }}>
                          {twitchEventSubInfo.error}
                        </span>
                      ) : (
                        <>
                          One click connects chat + the OAuth-only
                          events (channel points, follows, raids).
                          Opens your browser for the Twitch consent
                          screen.
                        </>
                      )}
                    </p>
                    <div className="popover-button-row">
                      <button
                        type="button"
                        onClick={handleTwitchUnifiedClick}
                        disabled={
                          twitchEventSubInfo.state === "authorizing" ||
                          twitchEventSubInfo.state === "connecting"
                        }
                      >
                        {twitchEventSubInfo.state === "connected"
                          ? "Disconnect"
                          : twitchEventSubInfo.state === "authorizing"
                            ? "Authorizing…"
                            : twitchEventSubInfo.state === "connecting"
                              ? "Connecting…"
                              : "Connect with Twitch"}
                      </button>
                    </div>
                    <label className="popover-checkbox">
                      <input
                        type="checkbox"
                        checked={twitchAutoConnect}
                        onChange={(e) =>
                          setTwitchAutoConnect(e.target.checked)
                        }
                      />
                      <span>Auto-connect on app start</span>
                    </label>
                  </>
                )}
              </section>

              {/* Secondary: watch a DIFFERENT channel's chat. This is
                  the read-only IRC fallback — useful when the user
                  wants their avatar to react to a channel they don't
                  own (e.g. monitoring a friend's stream for a
                  collab). OAuth doesn't help here since EventSub
                  events on someone else's channel require being a
                  moderator of that channel. So this section only
                  drives the IRC chat source — separate from the
                  primary "your account" path above. */}
              <section
                className="popover-section"
                style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
              >
                <label className="popover-label">
                  Or watch a different channel's chat
                </label>
                <p className="popover-hint" style={{ marginTop: 0 }}>
                  Read-only anonymous IRC. Useful for monitoring
                  someone else's stream while collabing. Channel-
                  point / follow events stay tied to your own
                  account above.
                  {isWatchingOtherChannel && (
                    <>
                      {" "}
                      Currently watching{" "}
                      <code>#{twitchInfo.channel}</code>.
                    </>
                  )}
                </p>
                <input
                  type="text"
                  value={twitchInput}
                  onChange={(e) => setTwitchInput(e.target.value)}
                  placeholder="channel name (without the #)"
                  className="popover-text-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleTwitchConnect();
                  }}
                />
                <div className="popover-button-row">
                  <button
                    type="button"
                    onClick={handleTwitchConnect}
                    disabled={!twitchInput.trim()}
                  >
                    Watch chat
                  </button>
                  <button
                    type="button"
                    onClick={handleTwitchDisconnect}
                    disabled={!isWatchingOtherChannel}
                    title={
                      isWatchingOtherChannel
                        ? "Stop watching this channel's chat"
                        : "Only the secondary chat connection — your account stays connected"
                    }
                  >
                    Stop watching
                  </button>
                </div>
              </section>
            </div>
          )}
        </section>
        )}

        {/* YouTube Live Chat — popover-driven, mirroring the Twitch
            pattern. Click the icon → popover opens with either
            (a) maintainer setup instructions if YOUTUBE_CLIENT_ID
            isn't filled in, or (b) Connect / Disconnect controls.
            Direct icon-click connect was confusing when unconfigured
            (just dumped an error to the section's tooltip); the
            popover makes the setup task visible up front.
            Hidden by default — toggle on under Settings → Streaming
            integrations. */}
        {showYoutubePanel && (
        <section
          className="status-section status-section-right"
          title={
            youtubeInfo.state === "polling"
              ? `YouTube live chat: ${youtubeInfo.channelTitle ?? "connected"}`
              : youtubeInfo.state === "waiting"
                ? "YouTube authorized — waiting for an active broadcast"
                : youtubeInfo.state === "error"
                  ? `YouTube error: ${youtubeInfo.error ?? "unknown"}`
                  : "Click the icon for YouTube live chat settings"
          }
        >
          <button
            className={`status-gear ${youtubeInfo.state === "polling" ? "live" : ""}`}
            onClick={() => {
              setShowYoutubePopover((v) => !v);
              setShowMicPopover(false);
              setShowKbPopover(false);
              setShowCamPopover(false);
              setShowTwitchPopover(false);
            }}
            aria-label="YouTube live chat"
            title="YouTube live chat settings"
          >
            <CirclePlay size={14} />
          </button>
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">YT</span>
              <span className="status-num">
                {youtubeInfo.state === "polling" && lastYtUser
                  ? `${lastYtUser}: ${(lastYtMessage ?? "").slice(0, 14)}`
                  : youtubeInfo.state === "polling"
                    ? "live"
                    : youtubeInfo.state === "waiting"
                      ? "off-air"
                      : "—"}
              </span>
            </span>
          </div>
          {showYoutubePopover && (
            <div className="settings-popover youtube-popover">
              <div className="settings-popover-header">
                <h3>YouTube live chat</h3>
                <button
                  className="popover-close"
                  onClick={() => setShowYoutubePopover(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <section className="popover-section">
                <label className="popover-label">YouTube account</label>
                {!youtubeOAuthConfigured ? (
                  // Maintainer setup task — Google's flow is heftier
                  // than Twitch (Cloud project + API enable + OAuth
                  // consent screen) so the steps need to be a bit
                  // more detailed. Same shape as the Twitch one
                  // though: walk-through with a clickable link, no
                  // placeholder Connect button to mislead.
                  <>
                    <p className="popover-hint" style={{ marginTop: 0 }}>
                      <strong>One-time maintainer setup:</strong>{" "}
                      enable the YouTube Data API and create an OAuth
                      Client ID for this build.
                    </p>
                    <ol
                      className="popover-hint"
                      style={{ marginTop: 4, paddingLeft: 18 }}
                    >
                      <li>
                        Open{" "}
                        <a
                          href="https://console.cloud.google.com/"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent)" }}
                        >
                          console.cloud.google.com
                        </a>{" "}
                        and create / pick a project.
                      </li>
                      <li>
                        APIs &amp; Services → Library → enable{" "}
                        <strong>YouTube Data API v3</strong>.
                      </li>
                      <li>
                        OAuth consent screen → External, add scope{" "}
                        <code>youtube.readonly</code>, add yourself
                        as a test user while in test mode.
                      </li>
                      <li>
                        Credentials → Create Credentials → OAuth
                        client ID → Application type{" "}
                        <strong>Desktop app</strong> (or Web app
                        with the redirect below).
                      </li>
                      <li>
                        Authorized redirect URIs (Web app type
                        only):{" "}
                        <code>http://localhost:47883/oauth/callback</code>
                      </li>
                      <li>
                        Paste the Client ID into{" "}
                        <code>YOUTUBE_CLIENT_ID</code> in{" "}
                        <code>src/inputs/YoutubeChatSource.ts</code>{" "}
                        and rebuild.
                      </li>
                    </ol>
                    <p className="popover-hint">
                      End users won't see this once configured — they
                      just click Connect with YouTube and the consent
                      screen pops in their browser.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="popover-hint" style={{ marginTop: 0 }}>
                      {youtubeInfo.state === "polling" ? (
                        <>
                          Connected as{" "}
                          <code>
                            {youtubeInfo.channelTitle ?? "your channel"}
                          </code>
                          {" — "}live chat polling ✓
                        </>
                      ) : youtubeInfo.state === "waiting" ? (
                        <>
                          Authorized as{" "}
                          <code>
                            {youtubeInfo.channelTitle ?? "your channel"}
                          </code>
                          {" — "}waiting for an active broadcast. Go
                          live and the source will pick up your chat
                          automatically.
                        </>
                      ) : youtubeInfo.state === "authorizing" ? (
                        "Opening browser for authorization…"
                      ) : youtubeInfo.state === "error" ? (
                        <span style={{ color: "var(--danger)" }}>
                          {youtubeInfo.error}
                        </span>
                      ) : (
                        <>
                          One click connects your YouTube account.
                          Adds <code>YoutubeChatMessage</code>,{" "}
                          <code>YoutubeChatCommand</code>,{" "}
                          <code>YoutubeSuperChat</code>, and{" "}
                          <code>YoutubeMember</code> channels.
                        </>
                      )}
                    </p>
                    <div className="popover-button-row">
                      <button
                        type="button"
                        onClick={handleYoutubeClick}
                        disabled={youtubeInfo.state === "authorizing"}
                      >
                        {youtubeInfo.state === "polling" ||
                        youtubeInfo.state === "waiting"
                          ? "Disconnect"
                          : youtubeInfo.state === "authorizing"
                            ? "Authorizing…"
                            : "Connect with YouTube"}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          )}
        </section>
        )}

        {/* Webhook receiver — universal external-event ingress. The
            Rust server is always listening at /webhook/event, so this
            section is read-only (no connect button). Shows last
            received event for sanity-checking external bridges.
            Hidden by default — toggle on under Settings → Streaming
            integrations. */}
        {showWebhookPanel && (
        <section
          className="status-section status-section-right"
          title={
            webhookActive
              ? `Webhook receiver: POST http://localhost:47882/webhook/event\nHeaders: X-Source, X-Event. Body: any JSON.\nLast event: ${lastWebhookEvent ?? "—"}${lastWebhookSource ? ` from ${lastWebhookSource}` : ""}`
              : "Webhook receiver not active — Rust HTTP server failed to bind. External event bridges (TikTok, Streamer.bot, etc.) won't reach the bus."
          }
        >
          <Webhook
            size={14}
            className={`status-icon ${webhookActive && lastWebhookEvent ? "live" : ""}`}
          />
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">Hook</span>
              <span className="status-num">
                {lastWebhookEvent
                  ? `${lastWebhookSource ?? "?"}/${lastWebhookEvent}`
                  : webhookActive
                    ? "ready"
                    : "off"}
              </span>
            </span>
          </div>
        </section>
        )}

        {/* Mouse readout pinned to the bottom-right of the webcam row.
            Range -1..1 over the canvas; Y is up-positive (+1 top, -1
            bottom). Useful while tuning pose bindings on Mouse channels. */}
        <section
          className="status-section status-section-right"
          title="Live MouseX / MouseY values published to bindings. Range -1..1 over the canvas. Y is up-positive: +1 at top, -1 at bottom."
        >
          <MousePointer
            size={14}
            className={`status-icon ${mouseInside ? "live" : ""}`}
          />
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">X</span>
              <span className="status-num">
                {mouseX != null ? mouseX.toFixed(2) : "—"}
              </span>
            </span>
            <span className="status-value">
              <span className="status-label">Y</span>
              <span className="status-num">
                {mouseY != null ? mouseY.toFixed(2) : "—"}
              </span>
            </span>
          </div>
        </section>
      </div>
    </footer>
  );
}
