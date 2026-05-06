// Shared OAuth 2.0 helper — drives the auth-code-with-PKCE flow used
// by Twitch and YouTube. Both providers happen to land on the same
// flow shape (browser → user grants → loopback redirect → token
// exchange), and both work with the same redirect URI on a localhost
// port owned by the Rust backend.
//
// Pipeline:
//   1. Frontend generates a random PKCE verifier + S256 challenge.
//   2. Calls Rust `start_oauth_callback_listener` → returns the port
//      a one-shot HTTP server is now bound to (currently fixed at
//      47883; flow_id distinguishes concurrent providers, though
//      practically only one flow runs at a time).
//   3. Frontend opens the provider's auth URL in the system browser
//      via `@tauri-apps/plugin-opener`. Provider sends the user
//      through its consent UI then redirects to
//      http://localhost:47883/oauth/callback?code=…&state=…
//   4. Rust listener captures the request, sends a "you can close
//      this tab" success page back to the browser, and emits an
//      `oauth-callback` Tauri event with the parsed code/state.
//   5. This module's `oauthFlow()` resolves with the code; caller
//      exchanges it for tokens via direct fetch to the provider's
//      token endpoint (PKCE means no client_secret is needed —
//      essential for desktop apps that can't keep secrets).
//
// Why PKCE and not the implicit flow? Implicit flow returns the token
// in the URL fragment, which is not sent to the redirect server (it's
// a browser-only concept). Capturing it would require running JS on
// the success page that POSTs the fragment back — workable but
// fragile. Auth code with PKCE is the modern recommendation from
// IETF (RFC 8252) anyway.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Redirect URI all OAuth flows redirect back to. Must match the
 *  value registered in each provider's developer console. The Rust
 *  side hard-codes the port in OAUTH_CALLBACK_PORT — they have to
 *  match. */
export const OAUTH_REDIRECT_URI =
  "http://localhost:47883/oauth/callback";

interface OAuthCallbackPayload {
  flowId: string;
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

interface OAuthFlowOptions {
  /** Identifier passed to Rust + matched in the callback event payload.
   *  Picks "twitch" or "youtube" — kept as an open string so future
   *  providers don't require touching shared types. */
  flowId: string;
  /** Provider's authorize endpoint, e.g.
   *  "https://id.twitch.tv/oauth2/authorize" or
   *  "https://accounts.google.com/o/oauth2/v2/auth". */
  authUrl: string;
  /** OAuth client ID for this provider, registered by the project
   *  maintainer (or overridden by the user via settings if they want
   *  to use their own dev app). */
  clientId: string;
  /** Space-delimited scope list, e.g.
   *  "channel:read:redemptions moderator:read:followers". */
  scope: string;
  /** Extra query params to include on the auth URL. Useful for
   *  provider-specific flags (Twitch's `force_verify`, Google's
   *  `access_type=offline` for refresh tokens, etc.). */
  extraParams?: Record<string, string>;
  /** Timeout in milliseconds before the flow rejects with a TIMEOUT
   *  error. Default 5 minutes — long enough that users can read the
   *  consent screen and check passwords, short enough that an
   *  abandoned flow eventually frees the listener port. */
  timeoutMs?: number;
}

export interface OAuthCodeResult {
  code: string;
  state: string;
  /** PKCE verifier — caller must send this in the token-exchange POST
   *  so the provider can verify it matches the challenge. */
  codeVerifier: string;
  /** The exact redirect URI used — providers' token endpoints reject
   *  the exchange unless it matches the auth-URL value byte-for-byte. */
  redirectUri: string;
}

/**
 * Run an OAuth code-with-PKCE flow end-to-end. Resolves with the
 * authorization code (caller exchanges it for tokens) plus the PKCE
 * verifier + redirect URI that need to be sent in the token POST.
 * Rejects on user-cancel, timeout, or provider error.
 */
export async function oauthFlow(
  options: OAuthFlowOptions,
): Promise<OAuthCodeResult> {
  const { flowId, authUrl, clientId, scope, extraParams = {} } = options;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  // PKCE: 64 random bytes → base64url verifier → SHA-256 → base64url
  // challenge. The challenge ships in the auth URL; the verifier
  // stays local until the token exchange. RFC 7636 minimum verifier
  // length is 43 chars; 64 raw bytes (86 chars base64url) is the
  // practical recommendation.
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(16);

  // Compose the auth URL.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...extraParams,
  });
  const fullAuthUrl = `${authUrl}?${params.toString()}`;

  // Wire up the Tauri callback listener BEFORE opening the browser —
  // there's a tiny race window where a user could click through the
  // consent screen faster than we set up the listener if we did this
  // in the other order. Vanishingly unlikely, but free to prevent.
  let unlisten: UnlistenFn | null = null;
  let timeoutHandle: number | null = null;
  const result = new Promise<OAuthCodeResult>((resolve, reject) => {
    let settled = false;
    const finish = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      if (unlisten) unlisten();
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      void invoke("cancel_oauth_callback_listener");
      action();
    };

    listen<OAuthCallbackPayload>("oauth-callback", (event) => {
      const payload = event.payload;
      if (payload.flowId !== flowId) return; // not us
      if (payload.error) {
        finish(() =>
          reject(
            new Error(
              `OAuth ${flowId} error: ${payload.error}${
                payload.errorDescription
                  ? ` — ${payload.errorDescription}`
                  : ""
              }`,
            ),
          ),
        );
        return;
      }
      if (!payload.code) {
        finish(() =>
          reject(new Error(`OAuth ${flowId} returned without a code`)),
        );
        return;
      }
      // Anti-CSRF check: provider must echo back the state we sent.
      if (payload.state !== state) {
        finish(() =>
          reject(
            new Error(
              `OAuth ${flowId} state mismatch — possible CSRF; refusing to proceed`,
            ),
          ),
        );
        return;
      }
      finish(() =>
        resolve({
          code: payload.code!,
          state: payload.state!,
          codeVerifier,
          redirectUri: OAUTH_REDIRECT_URI,
        }),
      );
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e) => {
        finish(() => reject(e));
      });

    timeoutHandle = window.setTimeout(() => {
      finish(() =>
        reject(new Error(`OAuth ${flowId} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
  });

  // Spin up the Rust listener, then open the browser. If the listener
  // fails to bind (port collision), Rust emits an error callback —
  // the listener-promise above handles it.
  await invoke("start_oauth_callback_listener", { flowId });
  await openUrl(fullAuthUrl);

  return result;
}

/** Generate `n` random bytes and encode as base64url (RFC 4648 §5,
 *  trailing `=` padding stripped, `+`/`/` → `-`/`_`). Suitable for
 *  PKCE verifiers and OAuth state tokens. */
function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlFromBytes(new Uint8Array(hash));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
