import { describe, expect, test } from "bun:test";

import {
  AUTH_URL,
  CLIENT_ID,
  decodeJwtPayloadWithoutVerification,
  type FetchLike,
  generateOAuthUrl,
  generatePkceChallenge,
  type OAuthTokenResponse,
  parseCallbackUrl,
  shapeAccountConfig,
  submitCallbackUrl,
  TOKEN_URL,
} from "./oauth.ts";

function encodeBase64UrlJson(value: Record<string, unknown>): string {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";

  for (const byte of jsonBytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function createJwtLike(payload: Record<string, unknown>): string {
  return [
    encodeBase64UrlJson({ alg: "none", typ: "JWT" }),
    encodeBase64UrlJson(payload),
    "signature",
  ].join(".");
}

const validPkceVerifier =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

describe("parseCallbackUrl", () => {
  test("merges fragment values when query values are missing", () => {
    const parsed = parseCallbackUrl(
      "localhost:1455/auth/callback?code=&state=#code=query-code&state=query-state",
    );

    expect(parsed).toEqual({
      code: "query-code",
      state: "query-state",
      error: "",
      errorDescription: "",
    });
  });

  test("supports bare query string callback input", () => {
    const parsed = parseCallbackUrl("code=abc123&state=state-456");

    expect(parsed.code).toBe("abc123");
    expect(parsed.state).toBe("state-456");
  });

  test("supports fragment-only callback input", () => {
    const parsed = parseCallbackUrl("#code=fragment-code&state=fragment-state");

    expect(parsed).toEqual({
      code: "fragment-code",
      state: "fragment-state",
      error: "",
      errorDescription: "",
    });
  });
});

describe("decodeJwtPayloadWithoutVerification", () => {
  test("returns an untrusted payload object when the token is parseable", () => {
    const token = createJwtLike({
      email: "safe@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "11111111-1111-4111-8111-111111111111",
      },
    });

    expect(decodeJwtPayloadWithoutVerification(token)).toEqual({
      email: "safe@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "11111111-1111-4111-8111-111111111111",
      },
    });
  });
});

describe("generateOAuthUrl", () => {
  test("builds the authorize URL with a derived PKCE challenge", async () => {
    const start = await generateOAuthUrl({
      state: "fixed-state",
      codeVerifier: validPkceVerifier,
      redirectUri: "http://localhost:1455/auth/callback",
      scope: "openid email",
    });

    const url = new URL(start.authUrl);
    const expectedChallenge = await generatePkceChallenge(validPkceVerifier);

    expect(url.origin + url.pathname).toBe(AUTH_URL);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("state")).toBe("fixed-state");
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(start.codeVerifier).toBe(validPkceVerifier);
  });
});

describe("shapeAccountConfig", () => {
  test("derives the persisted account config from token response data", () => {
    const tokenResponse: OAuthTokenResponse = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: createJwtLike({
        email: "shape@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
      expires_in: 120,
      token_type: undefined,
      scope: undefined,
    };

    const config = shapeAccountConfig({
      tokenResponse,
      now: new Date("2026-03-19T12:00:00.000Z"),
    });

    expect(config.email).toBe("shape@example.com");
    expect(config.account_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(config.last_refresh).toBe("2026-03-19T12:00:00.000Z");
    expect(config.expired).toBe("2026-03-19T12:02:00.000Z");
    expect(config.type).toBe("codex");
  });
});

describe("submitCallbackUrl", () => {
  test("exchanges the code and returns typed parsed results", async () => {
    const idToken = createJwtLike({
      email: "submit@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "33333333-3333-4333-8333-333333333333",
      },
    });
    let requestBody = "";

    const fetchMock: FetchLike = async (input, init) => {
      expect(input).toBe(TOKEN_URL);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      });

      const body = init?.body;
      if (!(body instanceof URLSearchParams)) {
        throw new Error("Expected URLSearchParams request body");
      }

      requestBody = body.toString();

      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          id_token: idToken,
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    };

    const result = await submitCallbackUrl({
      callbackUrl:
        "http://localhost:1455/auth/callback?code=code-123&state=state-123",
      expectedState: "state-123",
      codeVerifier: validPkceVerifier,
      fetchImpl: fetchMock,
      now: new Date("2026-03-19T12:00:00.000Z"),
    });

    expect(requestBody).toBe(
      "grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=code-123&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_verifier=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._%7E",
    );
    expect(result.callback.code).toBe("code-123");
    expect(result.accountConfig.email).toBe("submit@example.com");
    expect(result.accountConfig.account_id).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.untrustedIdTokenPayload.email).toBe("submit@example.com");
  });

  test("rejects callback state mismatches before token exchange", async () => {
    let fetchCalls = 0;

    const fetchMock: FetchLike = async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    };

    await expect(
      submitCallbackUrl({
        callbackUrl:
          "http://localhost:1455/auth/callback?code=code-123&state=wrong-state",
        expectedState: "expected-state",
        codeVerifier: validPkceVerifier,
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("State validation failed");

    expect(fetchCalls).toBe(0);
  });

  test("rejects token responses that omit required token fields", async () => {
    const fetchMock: FetchLike = async () =>
      new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );

    await expect(
      submitCallbackUrl({
        callbackUrl:
          "http://localhost:1455/auth/callback?code=code-123&state=state-123",
        expectedState: "state-123",
        codeVerifier: validPkceVerifier,
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow();
  });

  test("rejects invalid PKCE verifier overrides before token exchange", async () => {
    let fetchCalls = 0;

    const fetchMock: FetchLike = async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    };

    await expect(
      submitCallbackUrl({
        callbackUrl:
          "http://localhost:1455/auth/callback?code=code-123&state=state-123",
        expectedState: "state-123",
        codeVerifier: "short",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchCalls).toBe(0);
  });
});

describe("generateOAuthUrl", () => {
  test("rejects invalid PKCE verifier overrides", async () => {
    await expect(
      generateOAuthUrl({
        codeVerifier: "short",
      }),
    ).rejects.toThrow();
  });
});
