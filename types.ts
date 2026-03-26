import { z } from "zod";

// Shared helpers
const optionalDatetime = z.iso.datetime({ offset: true }).optional();

// Auth file schemas (from CLIProxyAPI /v0/management/auth-files)
export const codexIdTokenSchema = z.object({
  chatgpt_account_id: z.string(),
  plan_type: z.string(),
  chatgpt_subscription_active_start: z.iso
    .datetime({ offset: true })
    .optional(),
  chatgpt_subscription_active_until: z.iso
    .datetime({ offset: true })
    .optional(),
});

export const authFileEntrySchema = z.object({
  id: z.string(),
  auth_index: z.string(),
  name: z.string(),
  type: z.string(),
  provider: z.string(),
  label: z.string(),
  status: z.string(),
  status_message: z.string(),
  disabled: z.boolean(),
  unavailable: z.boolean(),
  runtime_only: z.boolean(),
  source: z.enum(["memory", "file"]),
  size: z.number().int().nonnegative(),
  email: z.string().optional(),
  account_type: z.string().optional(),
  account: z.string().optional(),
  created_at: optionalDatetime,
  modtime: optionalDatetime,
  updated_at: optionalDatetime,
  last_refresh: optionalDatetime,
  next_retry_after: optionalDatetime,
  path: z.string().optional(),
  priority: z.number().int().optional(),
  note: z.string().optional(),
  id_token: codexIdTokenSchema.optional(),
});

export const authFilesResponseSchema = z.object({
  files: z.array(authFileEntrySchema),
});

export type CodexIdToken = z.infer<typeof codexIdTokenSchema>;
export type AuthFileEntry = z.infer<typeof authFileEntrySchema>;
export type AuthFilesResponse = z.infer<typeof authFilesResponseSchema>;

// Probe result for wham/usage via /v0/management/api-call
export const probeResponseSchema = z.object({
  status_code: z.number().int(),
  body: z.unknown().optional(),
});
export type ProbeResponse = z.infer<typeof probeResponseSchema>;

export interface AccountStatus {
  name: string;
  authIndex: string;
  email?: string;
  unavailable: boolean;
  disabled: boolean;
  tokenExpired: boolean;
  downloadError?: string;
  invalid: boolean;
  reasons: string[];
}

// Update accounts schemas
export const updateAccountsConfigSchema = z.object({
  sourceAccountsBaseUrl: z.url(),
  uploadUrl: z.url(),
  uploadApiToken: z.string().min(1),
  limit: z.number().int().positive().max(100),
  insecureTls: z.boolean(),
});

export interface UploadRequestInit extends RequestInit {
  tls?: {
    rejectUnauthorized?: boolean;
  };
}

export interface UploadResult {
  accountId: string;
  ok: boolean;
  status?: number;
  detail?: string;
}
