import { z } from "zod";

import { accountSchema, type AccountConfig } from "./oauth.ts";

export const redactedAccountSchema = accountSchema.pick({
  account_id: true,
  email: true,
  type: true,
  last_refresh: true,
  expired: true,
});

export type RedactedAccount = z.infer<typeof redactedAccountSchema>;

export const storeRedactedAccountRequestSchema = z.object({
  callbackUrl: z.string().trim().min(1),
  expectedState: z.string().trim().min(1),
  codeVerifier: z.string().trim().min(1),
  redirectUri: z.string().trim().min(1).optional(),
  tokenUrl: z.string().trim().min(1).optional(),
  clientId: z.string().trim().min(1).optional(),
  accountType: z.string().trim().min(1).optional(),
});

export type StoreRedactedAccountRequest = z.infer<
  typeof storeRedactedAccountRequestSchema
>;

export function toRedactedAccount(account: AccountConfig): RedactedAccount {
  return redactedAccountSchema.parse(account);
}
