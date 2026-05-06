// Shared OAuth 2.0 helper — supports two flow shapes that both land
// on the same Rust callback listener:
//
//   - Auth-code-with-PKCE (oauthCodeFlow): used by providers that
//     properly support PKCE for public clients (YouTube/Google).
//     Returns the authorization code; caller exchanges it for tokens.
//
//   - Implicit grant (oauthImplicitFlow): used by providers that
//     DON'T support PKCE for public clients (Twitch). Returns the
//     access_token directly — no exchange step. Tokens are not
//     refreshable; users have to re-authorize when they expire.
//
// Both flows share the listener mechanics: Rust spawns a one-shot
// HTTP listener on 127.0.0.1:47883, the browser hits /oauth/callback
// after consent, our HTML+JS shim parses both the query string AND
// the URL fragment, then POSTs the result back. Rust emits an
// `oauth-callback` Tauri event regardless of which flow type was
// used; this module dispatches based on which fields are present.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Redirect URI all OAuth flows redirect back to. Must match the
 *  value registered in each provider's developer console verbatim. */
export const OAUTH_REDIRECT_URI = "http://localhost:47883/oauth/callback";

interface OAuthCallbackPayload {
  flowId: string;
  code: string | null;
  accessToken: string | null;
  state: string | null;
  scope: string | null;
  error: string | null;
  errorDescription: string | null;
}

interface BaseFlowOptions {
  /** Identifier matched in callback events ("twitch", "youtube"). */
  flowId: string;
  /** Provider's authorize endpoint. */
  authUrl: string;
  /** OAuth client ID (registered in the provider's dev console). */
  clientId: string;
  /** Space-delimited scope list. */
  scope: string;
  /** Extra query params to include on the auth URL. */
  extraParams?: Record<string, string>;
  /** Reject after this many ms with a TIMEOUT error. Default 5min. */
  timeoutMs?: number;
}

export interface OAuthCodeResult {
  code: string;
  state: string;
  /** PKCE verifier — caller MUST send this in the token-exchange POST
   *  so the provider can verify it matches the challenge. */
  codeVerifier: string;
  /** Exact redirect URI used — providers' token endpoints reject the
   *  exchange unless this matches the auth-URL value byte-for-byte. */
  redirectUri: string;
}

export interface OAuthTokenResult {
  accessToken: string;
  state: string;
  /** Granted scopes (space-delimited or comma-separated depending on
   *  provider). Useful for sanity-checking the user accepted what we
   *  asked for. */
  scope: string | null;
}

/**
 * Auth-code-with-PKCE flow. Use for providers that support PKCE —
 * notably Google/YouTube.
 *
 * Flow: builds auth URL with response_type=code + code_challenge,
 * opens browser, waits for redirect, returns {code, codeVerifier}.
 * Caller is responsible for exchanging the code for tokens via the
 * provider's token endpoint (sending code_verifier in the body).
 */
export async function oauthCodeFlow(
  options: BaseFlowOptions,
): Promise<OAuthCodeResult> {
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(16);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: options.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...(options.extraParams ?? {}),
  });

  const payload = await runFlow(options, params, state);
  if (!payload.code) {
    throw new Error(
      `OAuth ${options.flowId} returned without a code (got access_token=${
        payload.accessToken ? "yes" : "no"
      })`,
    );
  }
  return {
    code: payload.code,
    state: payload.state!,
    codeVerifier,
    redirectUri: OAUTH_REDIRECT_URI,
  };
}

/**
 * Implicit-grant flow. Use for providers that DON'T support PKCE for
 * public desktop clients — notably Twitch.
 *
 * Flow: builds auth URL with response_type=token, opens browser,
 * waits for redirect, returns {accessToken} directly. No exchange
 * step; the token is the result.
 *
 * Note: implicit flow doesn't return a refresh token. When the access
 * token expires (Twitch tokens last ~60 days), the user has to
 * re-authorize. Surface this clearly in the source's connection-state
 * UI so users know what's going on when their session drops.
 */
export async function oauthImplicitFlow(
  options: BaseFlowOptions,
): Promise<OAuthTokenResult> {
  const state = randomBase64Url(16);

  const params = new URLSearchParams({
    response_type: "token",
    client_id: options.clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: options.scope,
    state,
    ...(options.extraParams ?? {}),
  });

  const payload = await runFlow(options, params, state);
  if (!payload.accessToken) {
    throw new Error(
      `OAuth ${options.flowId} returned without an access_token (got code=${
        payload.code ? "yes" : "no"
      })`,
    );
  }
  return {
    accessToken: payload.accessToken,
    state: payload.state!,
    scope: payload.scope,
  };
}

/** Shared mechanics: open browser → wait for callback → return raw
 *  payload. Both flows call this; the only difference is which fields
 *  of the payload they read. */
async function runFlow(
  options: BaseFlowOptions,
  params: URLSearchParams,
  expectedState: string,
): Promise<OAuthCallbackPayload> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const fullAuthUrl = `${options.authUrl}?${params.toString()}`;

  let unlisten: UnlistenFn | null = null;
  let timeoutHandle: number | null = null;

  const result = new Promise<OAuthCallbackPayload>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (unlisten) unlisten();
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      void invoke("cancel_oauth_callback_listener");
      action();
    };

    listen<OAuthCallbackPayload>("oauth-callback", (event) => {
      const payload = event.payload;
      if (payload.flowId !== options.flowId) return;
      if (payload.error) {
        finish(() =>
          reject(
            new Error(
              `OAuth ${options.flowId} error: ${payload.error}${
                payload.errorDescription
                  ? ` — ${payload.errorDescription}`
                  : ""
              }`,
            ),
          ),
        );
        return;
      }
      if (payload.state !== expectedState) {
        finish(() =>
          reject(
            new Error(
              `OAuth ${options.flowId} state mismatch — possible CSRF; refusing to proceed`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(payload));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e) => finish(() => reject(e)));

    timeoutHandle = window.setTimeout(() => {
      finish(() =>
        reject(new Error(`OAuth ${options.flowId} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
  });

  await invoke("start_oauth_callback_listener", { flowId: options.flowId });
  await openUrl(fullAuthUrl);
  return result;
}

/** Generate `n` random bytes encoded as base64url. */
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
