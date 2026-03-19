import { redactedAccountSchema, type RedactedAccount } from "./redacted-account.ts";

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

const UPSERT_REDACTED_ACCOUNT_SQL = `INSERT INTO accounts (
  account_id,
  email,
  type,
  last_refresh,
  expired
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(account_id) DO UPDATE SET
  email = excluded.email,
  type = excluded.type,
  last_refresh = excluded.last_refresh,
  expired = excluded.expired`;

export async function upsertRedactedAccount(
  db: D1DatabaseLike,
  account: RedactedAccount,
): Promise<void> {
  const validatedAccount = redactedAccountSchema.parse(account);

  await db
    .prepare(UPSERT_REDACTED_ACCOUNT_SQL)
    .bind(
      validatedAccount.account_id,
      validatedAccount.email,
      validatedAccount.type,
      validatedAccount.last_refresh,
      validatedAccount.expired,
    )
    .run();
}
