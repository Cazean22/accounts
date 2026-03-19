import { describe, expect, test } from "bun:test";

import { upsertRedactedAccount, type D1DatabaseLike } from "./d1-store.ts";
import { type RedactedAccount } from "./redacted-account.ts";

const redactedAccountFixture: RedactedAccount = {
  account_id: "55555555-5555-4555-8555-555555555555",
  email: "d1@example.com",
  type: "codex",
  last_refresh: "2026-03-19T12:00:00.000Z",
  expired: "2026-03-19T13:00:00.000Z",
};

describe("upsertRedactedAccount", () => {
  test("uses a parameterized upsert for the redacted columns only", async () => {
    let preparedSql = "";
    let boundValues: unknown[] = [];
    let runCalls = 0;

    const db: D1DatabaseLike = {
      prepare(query) {
        preparedSql = query;

        return {
          bind(...values: unknown[]) {
            boundValues = values;
            return this;
          },
          async run() {
            runCalls += 1;
            return { success: true };
          },
        };
      },
    };

    await upsertRedactedAccount(db, redactedAccountFixture);

    expect(preparedSql).toContain("INSERT INTO accounts");
    expect(preparedSql).toContain("account_id");
    expect(preparedSql).toContain("email");
    expect(preparedSql).toContain("type");
    expect(preparedSql).toContain("last_refresh");
    expect(preparedSql).toContain("expired");
    expect(preparedSql).not.toContain("access_token");
    expect(preparedSql).not.toContain("refresh_token");
    expect(preparedSql).not.toContain("id_token");
    expect(boundValues).toEqual([
      "55555555-5555-4555-8555-555555555555",
      "d1@example.com",
      "codex",
      "2026-03-19T12:00:00.000Z",
      "2026-03-19T13:00:00.000Z",
    ]);
    expect(runCalls).toBe(1);
  });
});
