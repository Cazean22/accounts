import { z } from "zod";

export const AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const DEFAULT_SCOPE = "openid email profile offline_access";
export const PKCE_CODE_CHALLENGE_METHOD = "S256" as const;

const requiredTrimmedStringSchema = z.string().trim().min(1);

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value.trim();
  }

  return value;
}, z.string().optional());

const nonNegativeIntegerSchema = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return 0;
}, z.number().int().nonnegative());

export const parsedCallbackSchema = z.object({
  code: z.string(),
  state: z.string(),
  error: z.string(),
  errorDescription: z.string(),
});

export const untrustedJwtPayloadSchema = z.record(z.string(), z.unknown());

export const oauthTokenResponseSchema = z
  .object({
    access_token: requiredTrimmedStringSchema,
    refresh_token: requiredTrimmedStringSchema,
    id_token: requiredTrimmedStringSchema,
    expires_in: nonNegativeIntegerSchema.optional().default(0),
    token_type: optionalTrimmedStringSchema,
    scope: optionalTrimmedStringSchema,
  })
  .passthrough();

export const accountSchema = z.object({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  account_id: z.string().uuid(),
  last_refresh: z.string().datetime({ offset: true }),
  email: z.string().email(),
  type: z.string(),
  expired: z.string().datetime({ offset: true }),
});

export const accountsSchema = z.array(accountSchema);

export const oauthStartSchema = z.object({
  authUrl: z.string().url(),
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string().min(1),
  scope: z.string().min(1),
});

export const oauthSubmissionResultSchema = z.object({
  callback: parsedCallbackSchema,
  tokenResponse: oauthTokenResponseSchema,
  untrustedIdTokenPayload: untrustedJwtPayloadSchema,
  accountConfig: accountSchema,
});

export type ParsedCallback = z.infer<typeof parsedCallbackSchema>;
export type UntrustedJwtPayload = z.infer<typeof untrustedJwtPayloadSchema>;
export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type Accounts = z.infer<typeof accountsSchema>;
export type OAuthStart = z.infer<typeof oauthStartSchema>;
export type OAuthSubmissionResult = z.infer<typeof oauthSubmissionResultSchema>;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GenerateOAuthUrlOptions {
  redirectUri?: string;
  scope?: string;
  state?: string;
  codeVerifier?: string;
}

export interface PostFormTokenExchangeOptions {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
  tokenUrl?: string;
  clientId?: string;
  fetchImpl?: FetchLike;
}

export interface ShapeAccountConfigOptions {
  tokenResponse: OAuthTokenResponse;
  now?: Date;
  accountType?: string;
  untrustedIdTokenPayload?: UntrustedJwtPayload;
}

export interface SubmitCallbackUrlOptions {
  callbackUrl: string;
  expectedState: string;
  codeVerifier: string;
  redirectUri?: string;
  tokenUrl?: string;
  clientId?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  accountType?: string;
}

const pkceVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9\-._~]+$/u);

const nonEmptyStringSchema = z.string().trim().min(1);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(`${normalized}${padding}`);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getStringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function validatePkceVerifier(codeVerifier: string): string {
  return pkceVerifierSchema.parse(codeVerifier);
}

function normalizeCallbackCandidate(callbackUrl: string): string {
  let candidate = callbackUrl.trim();

  if (candidate === "") {
    return candidate;
  }

  if (!candidate.includes("://")) {
    if (
      candidate.startsWith("?") ||
      candidate.startsWith("#") ||
      candidate.startsWith("/")
    ) {
      candidate = `http://localhost${candidate}`;
    } else if (candidate.includes("=")) {
      const looksLikePath =
        candidate.includes("/") ||
        candidate.includes("?") ||
        candidate.includes("#") ||
        candidate.includes(":");

      candidate = looksLikePath
        ? `http://${candidate}`
        : `http://localhost/?${candidate}`;
    } else {
      candidate = `http://${candidate}`;
    }
  }

  return candidate;
}

export function generateRandomState(byteLength = 16): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function generatePkceVerifier(byteLength = 64): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function generatePkceChallenge(verifier: string): Promise<string> {
  validatePkceVerifier(verifier);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return bytesToBase64Url(new Uint8Array(digest));
}

export function parseCallbackUrl(callbackUrl: string): ParsedCallback {
  const candidate = normalizeCallbackCandidate(callbackUrl);

  if (candidate === "") {
    return parsedCallbackSchema.parse({
      code: "",
      state: "",
      error: "",
      errorDescription: "",
    });
  }

  const parsedUrl = new URL(candidate);
  const queryParams = new URLSearchParams(parsedUrl.search);
  const fragmentParams = new URLSearchParams(parsedUrl.hash.replace(/^#/u, ""));

  for (const [key, value] of fragmentParams.entries()) {
    const currentValue = queryParams.get(key);
    if (currentValue === null || currentValue.trim() === "") {
      queryParams.set(key, value);
    }
  }

  let code = queryParams.get("code")?.trim() ?? "";
  let state = queryParams.get("state")?.trim() ?? "";
  let error = queryParams.get("error")?.trim() ?? "";
  let errorDescription = queryParams.get("error_description")?.trim() ?? "";

  if (error === "" && errorDescription !== "") {
    error = errorDescription;
    errorDescription = "";
  }

  return parsedCallbackSchema.parse({
    code,
    state,
    error,
    errorDescription,
  });
}

export function decodeJwtPayloadWithoutVerification(
  token: string,
): UntrustedJwtPayload {
  const segments = token.split(".");

  if (segments.length < 3) {
    return {};
  }

  const payloadSegment = segments[1];

  if (payloadSegment === undefined || payloadSegment === "") {
    return {};
  }

  try {
    const payloadBytes = base64UrlToBytes(payloadSegment);
    const decoded = new TextDecoder().decode(payloadBytes);
    const parsedJson: unknown = JSON.parse(decoded);
    const payloadRecord = toRecord(parsedJson);

    return payloadRecord === null
      ? {}
      : untrustedJwtPayloadSchema.parse(payloadRecord);
  } catch {
    return {};
  }
}

export async function postFormTokenExchange({
  code,
  codeVerifier,
  redirectUri = DEFAULT_REDIRECT_URI,
  tokenUrl = TOKEN_URL,
  clientId = CLIENT_ID,
  fetchImpl = fetch,
}: PostFormTokenExchangeOptions): Promise<OAuthTokenResponse> {
  const validatedCode = nonEmptyStringSchema.parse(code);
  const validatedCodeVerifier = validatePkceVerifier(codeVerifier);
  const validatedRedirectUri = nonEmptyStringSchema.parse(redirectUri);
  const validatedTokenUrl = nonEmptyStringSchema.parse(tokenUrl);
  const validatedClientId = nonEmptyStringSchema.parse(clientId);

  const response = await fetchImpl(validatedTokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: validatedClientId,
      code: validatedCode,
      redirect_uri: validatedRedirectUri,
      code_verifier: validatedCodeVerifier,
    }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}: ${rawText}`);
  }

  let parsedJson: unknown = {};

  if (rawText !== "") {
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new Error("Token exchange failed: response was not valid JSON");
    }
  }

  return oauthTokenResponseSchema.parse(parsedJson);
}

export function shapeAccountConfig({
  tokenResponse,
  now = new Date(),
  accountType = "codex",
  untrustedIdTokenPayload = decodeJwtPayloadWithoutVerification(tokenResponse.id_token),
}: ShapeAccountConfigOptions): AccountConfig {
  const authClaims = toRecord(
    untrustedIdTokenPayload["https://api.openai.com/auth"],
  );
  const expiresAt = new Date(now.getTime() + tokenResponse.expires_in * 1000);

  return accountSchema.parse({
    id_token: tokenResponse.id_token,
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    account_id: getStringValue(authClaims ?? {}, "chatgpt_account_id"),
    last_refresh: now.toISOString(),
    email: getStringValue(untrustedIdTokenPayload, "email"),
    type: accountType,
    expired: expiresAt.toISOString(),
  });
}

export async function generateOAuthUrl({
  redirectUri = DEFAULT_REDIRECT_URI,
  scope = DEFAULT_SCOPE,
  state = generateRandomState(),
  codeVerifier = generatePkceVerifier(),
}: GenerateOAuthUrlOptions = {}): Promise<OAuthStart> {
  const validatedRedirectUri = nonEmptyStringSchema.parse(redirectUri);
  const validatedScope = nonEmptyStringSchema.parse(scope);
  const validatedState = nonEmptyStringSchema.parse(state);
  const validatedCodeVerifier = validatePkceVerifier(codeVerifier);
  const codeChallenge = await generatePkceChallenge(validatedCodeVerifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: validatedRedirectUri,
    scope: validatedScope,
    state: validatedState,
    code_challenge: codeChallenge,
    code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });

  return oauthStartSchema.parse({
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state: validatedState,
    codeVerifier: validatedCodeVerifier,
    redirectUri: validatedRedirectUri,
    scope: validatedScope,
  });
}

export async function submitCallbackUrl({
  callbackUrl,
  expectedState,
  codeVerifier,
  redirectUri = DEFAULT_REDIRECT_URI,
  tokenUrl = TOKEN_URL,
  clientId = CLIENT_ID,
  fetchImpl = fetch,
  now,
  accountType,
}: SubmitCallbackUrlOptions): Promise<OAuthSubmissionResult> {
  const validatedExpectedState = nonEmptyStringSchema.parse(expectedState);
  const validatedCodeVerifier = validatePkceVerifier(codeVerifier);
  const callback = parseCallbackUrl(callbackUrl);

  if (callback.error !== "") {
    const details = callback.errorDescription === ""
      ? callback.error
      : `${callback.error}: ${callback.errorDescription}`;
    throw new Error(`OAuth error: ${details}`);
  }

  if (callback.code === "") {
    throw new Error("Callback URL is missing ?code=");
  }

  if (callback.state === "") {
    throw new Error("Callback URL is missing ?state=");
  }

  if (callback.state !== validatedExpectedState) {
    throw new Error("State validation failed");
  }

  const tokenResponse = await postFormTokenExchange({
    code: callback.code,
    codeVerifier: validatedCodeVerifier,
    redirectUri,
    tokenUrl,
    clientId,
    fetchImpl,
  });
  const untrustedIdTokenPayload = decodeJwtPayloadWithoutVerification(
    tokenResponse.id_token,
  );
  const accountConfig = shapeAccountConfig({
    tokenResponse,
    now,
    accountType,
    untrustedIdTokenPayload,
  });

  return oauthSubmissionResultSchema.parse({
    callback,
    tokenResponse,
    untrustedIdTokenPayload,
    accountConfig,
  });
}
