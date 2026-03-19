import { describe, expect, test } from "bun:test";

import { type D1DatabaseLike } from "./d1-store.ts";
import { type AccountConfig, type OAuthSubmissionResult } from "./oauth.ts";
import { type RedactedAccount } from "./redacted-account.ts";
import { handleRequest, type WorkerEnv } from "./worker.ts";

const validPkceVerifier =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

const accountConfigFixture: AccountConfig = {
  id_token: "id-token",
  access_token: "access-token",
  refresh_token: "refresh-token",
  account_id: "66666666-6666-4666-8666-666666666666",
  last_refresh: "2026-03-19T12:00:00.000Z",
  email: "worker@example.com",
  type: "codex",
  expired: "2026-03-19T13:00:00.000Z",
};

function createSubmissionResult(): OAuthSubmissionResult {
  return {
    callback: {
      code: "code-123",
      state: "state-123",
      error: "",
      errorDescription: "",
    },
    tokenResponse: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid email profile offline_access",
    },
    untrustedIdTokenPayload: {
      email: "worker@example.com",
    },
    accountConfig: accountConfigFixture,
  };
}

function createEnv(): WorkerEnv {
  const db: D1DatabaseLike = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async run() {
          return { success: true };
        },
      };
    },
  };

  return {
    ACCOUNTS_DB: db,
  };
}

describe("handleRequest", () => {
  test("returns 404 for unknown paths", async () => {
    const response = await handleRequest(
      new Request("https://example.com/unknown", { method: "POST" }),
      createEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  test("returns 405 for the known path with the wrong method", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", { method: "GET" }),
      createEnv(),
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "Method not allowed" });
  });

  test("stores and returns only the redacted account fields", async () => {
    let submitCalls = 0;
    let storedAccount: RedactedAccount | undefined;

    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callbackUrl:
            "http://localhost:1455/auth/callback?code=code-123&state=state-123",
          expectedState: "state-123",
          codeVerifier: validPkceVerifier,
        }),
      }),
      createEnv(),
      {
        async submitCallbackUrl() {
          submitCalls += 1;

          return createSubmissionResult();
        },
        async upsertRedactedAccount(_db, account) {
          storedAccount = account;
        },
      },
    );

    expect(submitCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(storedAccount).toEqual({
      account_id: "66666666-6666-4666-8666-666666666666",
      email: "worker@example.com",
      type: "codex",
      last_refresh: "2026-03-19T12:00:00.000Z",
      expired: "2026-03-19T13:00:00.000Z",
    });
    expect(await response.json()).toEqual({
      account: {
        account_id: "66666666-6666-4666-8666-666666666666",
        email: "worker@example.com",
        type: "codex",
        last_refresh: "2026-03-19T12:00:00.000Z",
        expired: "2026-03-19T13:00:00.000Z",
      },
    });
  });

  test("maps validation failures to 400", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callbackUrl: "",
          expectedState: "state-123",
          codeVerifier: validPkceVerifier,
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.any(String),
    });
  });

  test("maps malformed JSON to 400", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.any(String),
    });
  });

  test("maps malformed callback URLs to 400", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callbackUrl: "::://not-a-url",
          expectedState: "state-123",
          codeVerifier: validPkceVerifier,
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.any(String),
    });
  });

  test("maps callback parsing and state errors to 400", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callbackUrl:
            "http://localhost:1455/auth/callback?code=code-123&state=wrong-state",
          expectedState: "state-123",
          codeVerifier: validPkceVerifier,
        }),
      }),
      createEnv(),
      {
        async submitCallbackUrl() {
          throw new Error("State validation failed");
        },
        async upsertRedactedAccount() {
          throw new Error("Should not be called");
        },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "State validation failed",
    });
  });

  test("maps upstream token exchange failures to 502", async () => {
    const response = await handleRequest(
      new Request("https://example.com/oauth/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callbackUrl:
            "http://localhost:1455/auth/callback?code=code-123&state=state-123",
          expectedState: "state-123",
          codeVerifier: validPkceVerifier,
        }),
      }),
      createEnv(),
      {
        async submitCallbackUrl() {
          throw new Error("Token exchange failed: 401: unauthorized");
        },
        async upsertRedactedAccount() {
          throw new Error("Should not be called");
        },
      },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Token exchange failed: 401: unauthorized",
    });
  });
});
