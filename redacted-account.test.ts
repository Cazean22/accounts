import { describe, expect, test } from "bun:test";

import { type AccountConfig } from "./oauth.ts";
import {
  redactedAccountSchema,
  storeRedactedAccountRequestSchema,
  toRedactedAccount,
} from "./redacted-account.ts";

const accountConfigFixture: AccountConfig = {
  id_token: "id-token",
  access_token: "access-token",
  refresh_token: "refresh-token",
  account_id: "44444444-4444-4444-8444-444444444444",
  last_refresh: "2026-03-19T12:00:00.000Z",
  email: "redacted@example.com",
  type: "codex",
  expired: "2026-03-19T13:00:00.000Z",
};

describe("redactedAccountSchema", () => {
  test("only includes the approved redacted fields", () => {
    const redactedAccount = toRedactedAccount(accountConfigFixture);

    expect(redactedAccount).toEqual({
      account_id: "44444444-4444-4444-8444-444444444444",
      email: "redacted@example.com",
      type: "codex",
      last_refresh: "2026-03-19T12:00:00.000Z",
      expired: "2026-03-19T13:00:00.000Z",
    });
    expect(Object.keys(redactedAccount).sort()).toEqual([
      "account_id",
      "email",
      "expired",
      "last_refresh",
      "type",
    ]);
  });

  test("rejects missing required redacted fields", () => {
    expect(() =>
      redactedAccountSchema.parse({
        account_id: "44444444-4444-4444-8444-444444444444",
        email: "redacted@example.com",
        type: "codex",
        last_refresh: "2026-03-19T12:00:00.000Z",
      })
    ).toThrow();
  });
});

describe("storeRedactedAccountRequestSchema", () => {
  test("parses the callback submission payload", () => {
    const parsed = storeRedactedAccountRequestSchema.parse({
      callbackUrl: "http://localhost:1455/auth/callback?code=abc&state=state-123",
      expectedState: "state-123",
      codeVerifier:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
      redirectUri: "http://localhost:1455/auth/callback",
    });

    expect(parsed.callbackUrl).toContain("code=abc");
    expect(parsed.expectedState).toBe("state-123");
  });
});
