import {
  authFilesResponseSchema,
  type AuthFileEntry,
  type AuthFilesResponse,
} from "./types.ts";
import { accountSchema, accountsSchema, type AccountConfig } from "./oauth.ts";
import z from "zod";
import { appendUrlPath } from "./utils.ts";

const CONCURRENCY = 10;
const COMPARE_FIELDS = ["email", "type", "last_refresh", "expired"] as const;

const cleanConfigSchema = z.object({
  uploadUrl: z.url(),
  uploadApiToken: z.string().min(1),
  d1WorkerUrl: z.url(),
});

const errorMessageBodySchema = z.object({
  type: z.string().min(1).nullable(),
  message: z.string().min(1),
  code: z.string().min(1).optional(),
});

const errorMessageSchema = z.object({
  error: errorMessageBodySchema,
  status: z.number().optional(),
});

type CleanConfig = z.infer<typeof cleanConfigSchema>;
type ComparedField = (typeof COMPARE_FIELDS)[number];
type ParsedStatusMessage = z.infer<typeof errorMessageSchema>;

export interface AccountFieldDiff {
  field: ComparedField;
  localValue: AccountConfig[ComparedField];
  remoteValue: AccountConfig[ComparedField];
}

interface OperationFailure {
  ok: false;
  detail: string;
  status?: number;
}

interface OperationSuccess {
  ok: true;
}

type OperationResult = OperationSuccess | OperationFailure;

type AccountLookupResult =
  | { ok: true; account: AccountConfig }
  | OperationFailure;

type SyncAccountResult =
  | {
      ok: true;
      action: "unchanged" | "updated";
      diffs: AccountFieldDiff[];
    }
  | {
      ok: false;
      step: "fetch-d1" | "update-d1";
      detail: string;
    };

type EntryOutcome =
  | {
      ok: true;
      entryName: string;
      entryStatus: AuthFileEntry["status"];
      accountId: string;
      localAction: "kept" | "deleted";
      d1Action: "unchanged" | "updated" | "deleted";
      diffs: AccountFieldDiff[];
      reason: string;
    }
  | {
      ok: false;
      entryName: string;
      entryStatus: AuthFileEntry["status"];
      accountId?: string;
      localAction: "kept" | "deleted" | "unknown";
      step: "download" | "fetch-d1" | "update-d1" | "delete-d1" | "delete-local";
      detail: string;
    };

function createFailure(detail: string, status?: number): OperationFailure {
  return status === undefined ? { ok: false, detail } : { ok: false, detail, status };
}

function makeHeaders(config: CleanConfig): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${config.uploadApiToken}`);
  headers.set("Content-Type", "application/json");
  return headers;
}

async function readResponseDetail(response: Response): Promise<string> {
  const responseText = (await response.text()).trim();
  return responseText === "" ? response.statusText : responseText;
}

async function fetchAuthFiles(config: CleanConfig): Promise<AuthFilesResponse> {
  const response = await fetch(config.uploadUrl, {
    method: "GET",
    headers: makeHeaders(config),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);

    throw new Error(
      `Failed to fetch auth files (${response.status}): ${detail}`,
    );
  }

  return authFilesResponseSchema.parse(await response.json());
}

async function deleteLocalAuthFile(
  config: CleanConfig,
  entry: AuthFileEntry,
): Promise<OperationResult> {
  try {
    const url = new URL(config.uploadUrl);
    url.searchParams.set("name", entry.name);

    const response = await fetch(url, {
      method: "DELETE",
      headers: makeHeaders(config),
      signal: AbortSignal.timeout(9_000),
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return createFailure(
        `failed to delete local auth file (${response.status}): ${detail}`,
        response.status,
      );
    }

    return { ok: true };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return createFailure("failed to delete local auth file: timeout");
    }

    return createFailure(
      `failed to delete local auth file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function deleteTokenFromD1(
  config: CleanConfig,
  accountId: string,
): Promise<OperationResult> {
  try {
    const url = appendUrlPath(config.d1WorkerUrl, "tokens");
    url.searchParams.set("account_id", accountId);

    const response = await fetch(url, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9_000),
    });

    if (response.status === 404) {
      return createFailure("token not found in D1", response.status);
    }

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return createFailure(
        `failed to delete D1 token (${response.status}): ${detail}`,
        response.status,
      );
    }

    return { ok: true };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return createFailure("failed to delete D1 token: timeout");
    }

    return createFailure(
      `failed to delete D1 token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function updateTokenInD1(
  config: CleanConfig,
  account: AccountConfig,
): Promise<OperationResult> {
  try {
    const url = appendUrlPath(config.d1WorkerUrl, "tokens");
    url.searchParams.set("account_id", account.account_id);

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(9_000),
      body: JSON.stringify(account),
    });

    if (response.status === 404) {
      return createFailure("token not found in D1", response.status);
    }

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return createFailure(
        `failed to update D1 token (${response.status}): ${detail}`,
        response.status,
      );
    }

    return { ok: true };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return createFailure("failed to update D1 token: timeout");
    }

    return createFailure(
      `failed to update D1 token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function downloadAuthFile(
  config: CleanConfig,
  name: string,
): Promise<AccountLookupResult> {
  try {
    const url = appendUrlPath(config.uploadUrl, "download");
    url.searchParams.set("name", name);

    const response = await fetch(url, {
      method: "GET",
      headers: makeHeaders(config),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return createFailure(
        `failed to download auth file (${response.status}): ${detail}`,
        response.status,
      );
    }

    const parsed = accountSchema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, account: parsed.data }
      : createFailure("invalid auth file format");
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return createFailure("failed to download auth file: timeout");
    }

    return createFailure(
      `failed to download auth file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchD1Token(
  config: CleanConfig,
  accountId: string,
): Promise<AccountLookupResult> {
  try {
    const url = appendUrlPath(config.d1WorkerUrl, "tokens/search");
    url.searchParams.set("account_id", accountId);

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return createFailure("token not found in D1", response.status);
    }

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return createFailure(
        `failed to fetch D1 token (${response.status}): ${detail}`,
        response.status,
      );
    }

    const parsed = accountsSchema.safeParse(await response.json());
    if (!parsed.success) {
      return createFailure("D1 returned an invalid token list");
    }

    const [account] = parsed.data;
    if (account === undefined) {
      return createFailure("no tokens found in D1");
    }

    return { ok: true, account };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return createFailure("failed to fetch D1 token: timeout");
    }

    return createFailure(
      `failed to fetch D1 token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseStatusMessage(
  statusMessage: string,
): ParsedStatusMessage | null {
  const trimmedStatusMessage = statusMessage.trim();

  if (trimmedStatusMessage === "") {
    return null;
  }

  try {
    const parsedJson: unknown = JSON.parse(trimmedStatusMessage);
    const parsedMessage = errorMessageSchema.safeParse(parsedJson);
    return parsedMessage.success ? parsedMessage.data : null;
  } catch {
    return null;
  }
}

export function getAccountDiffs(
  localAccount: AccountConfig,
  remoteAccount: AccountConfig,
): AccountFieldDiff[] {
  const diffs: AccountFieldDiff[] = [];

  for (const field of COMPARE_FIELDS) {
    const localValue = localAccount[field];
    const remoteValue = remoteAccount[field];

    if (localValue !== remoteValue) {
      diffs.push({
        field,
        localValue,
        remoteValue,
      });
    }
  }

  return diffs;
}

function formatDiffs(diffs: AccountFieldDiff[]): string {
  return diffs
    .map(({ field, localValue, remoteValue }) => {
      return `${field}: ${String(remoteValue)} -> ${String(localValue)}`;
    })
    .join(", ");
}

async function syncD1Account(
  config: CleanConfig,
  localAccount: AccountConfig,
): Promise<SyncAccountResult> {
  const d1AccountResult = await fetchD1Token(config, localAccount.account_id);
  if (!d1AccountResult.ok) {
    return {
      ok: false,
      step: "fetch-d1",
      detail: d1AccountResult.detail,
    };
  }

  const diffs = getAccountDiffs(localAccount, d1AccountResult.account);
  if (diffs.length === 0) {
    return {
      ok: true,
      action: "unchanged",
      diffs,
    };
  }

  const updateResult = await updateTokenInD1(config, localAccount);
  if (!updateResult.ok) {
    return {
      ok: false,
      step: "update-d1",
      detail: updateResult.detail,
    };
  }

  return {
    ok: true,
    action: "updated",
    diffs,
  };
}

async function processAuthFileEntry(
  config: CleanConfig,
  entry: AuthFileEntry,
): Promise<EntryOutcome> {
  const downloadedAccountResult = await downloadAuthFile(config, entry.name);

  if (!downloadedAccountResult.ok) {
    if (entry.status !== "error") {
      return {
        ok: false,
        entryName: entry.name,
        entryStatus: entry.status,
        localAction: "kept",
        step: "download",
        detail: downloadedAccountResult.detail,
      };
    }

    const deleteLocalResult = await deleteLocalAuthFile(config, entry);
    if (!deleteLocalResult.ok) {
      return {
        ok: false,
        entryName: entry.name,
        entryStatus: entry.status,
        localAction: "unknown",
        step: "delete-local",
        detail: `${downloadedAccountResult.detail}; ${deleteLocalResult.detail}`,
      };
    }

    return {
      ok: false,
      entryName: entry.name,
      entryStatus: entry.status,
      localAction: "deleted",
      step: "download",
      detail:
        `${downloadedAccountResult.detail}; removed errored local auth file without D1 sync`,
    };
  }

  const localAccount = downloadedAccountResult.account;

  if (entry.status !== "error") {
    const syncResult = await syncD1Account(config, localAccount);
    if (!syncResult.ok) {
      return {
        ok: false,
        entryName: entry.name,
        entryStatus: entry.status,
        accountId: localAccount.account_id,
        localAction: "kept",
        step: syncResult.step,
        detail: syncResult.detail,
      };
    }

    return {
      ok: true,
      entryName: entry.name,
      entryStatus: entry.status,
      accountId: localAccount.account_id,
      localAction: "kept",
      d1Action: syncResult.action,
      diffs: syncResult.diffs,
      reason: "auth file healthy",
    };
  }

  const parsedStatusMessage = parseStatusMessage(entry.status_message);

  if (parsedStatusMessage?.status === 401) {
    const deleteD1Result = await deleteTokenFromD1(config, localAccount.account_id);
    const deleteLocalResult = await deleteLocalAuthFile(config, entry);

    if (!deleteLocalResult.ok) {
      return {
        ok: false,
        entryName: entry.name,
        entryStatus: entry.status,
        accountId: localAccount.account_id,
        localAction: "unknown",
        step: "delete-local",
        detail: !deleteD1Result.ok
          ? `${deleteD1Result.detail}; ${deleteLocalResult.detail}`
          : deleteLocalResult.detail,
      };
    }

    if (!deleteD1Result.ok) {
      return {
        ok: false,
        entryName: entry.name,
        entryStatus: entry.status,
        accountId: localAccount.account_id,
        localAction: "deleted",
        step: "delete-d1",
        detail: `${deleteD1Result.detail}; removed local auth file`,
      };
    }

    return {
      ok: true,
      entryName: entry.name,
      entryStatus: entry.status,
      accountId: localAccount.account_id,
      localAction: "deleted",
      d1Action: "deleted",
      diffs: [],
      reason: "401 auth error",
    };
  }

  const syncResult = await syncD1Account(config, localAccount);
  const deleteLocalResult = await deleteLocalAuthFile(config, entry);

  if (!deleteLocalResult.ok) {
    return {
      ok: false,
      entryName: entry.name,
      entryStatus: entry.status,
      accountId: localAccount.account_id,
      localAction: "unknown",
      step: "delete-local",
      detail: !syncResult.ok
        ? `${syncResult.detail}; ${deleteLocalResult.detail}`
        : deleteLocalResult.detail,
    };
  }

  if (!syncResult.ok) {
    return {
      ok: false,
      entryName: entry.name,
      entryStatus: entry.status,
      accountId: localAccount.account_id,
      localAction: "deleted",
      step: syncResult.step,
      detail: `${syncResult.detail}; removed local auth file`,
    };
  }

  return {
    ok: true,
    entryName: entry.name,
    entryStatus: entry.status,
    accountId: localAccount.account_id,
    localAction: "deleted",
    d1Action: syncResult.action,
    diffs: syncResult.diffs,
    reason: parsedStatusMessage?.error.message ?? "errored auth file",
  };
}

function formatOutcomeLog(outcome: EntryOutcome): string {
  if (!outcome.ok) {
    const accountSuffix = outcome.accountId === undefined
      ? ""
      : ` (${outcome.accountId})`;

    return `[fail] ${outcome.entryName}${accountSuffix}: ${outcome.detail}`;
  }

  const entryLabel = `${outcome.entryName} (${outcome.accountId})`;

  if (outcome.localAction === "kept") {
    if (outcome.d1Action === "updated") {
      return `[keep] ${entryLabel}: updated D1 token [${formatDiffs(outcome.diffs)}]`;
    }

    return `[keep] ${entryLabel}: up to date`;
  }

  if (outcome.d1Action === "deleted") {
    return `[delete] ${entryLabel}: ${outcome.reason}; deleted D1 token and local auth file`;
  }

  if (outcome.d1Action === "updated") {
    return `[delete] ${entryLabel}: ${outcome.reason}; updated D1 token [${formatDiffs(outcome.diffs)}] and removed local auth file`;
  }

  return `[delete] ${entryLabel}: ${outcome.reason}; removed local auth file`;
}

function summarizeOutcomes(outcomes: EntryOutcome[]): string {
  let keptCount = 0;
  let deletedCount = 0;
  let updatedCount = 0;
  let deletedD1Count = 0;
  let failedCount = 0;

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failedCount += 1;
      continue;
    }

    if (outcome.localAction === "kept") {
      keptCount += 1;
    } else {
      deletedCount += 1;
    }

    if (outcome.d1Action === "updated") {
      updatedCount += 1;
    }

    if (outcome.d1Action === "deleted") {
      deletedD1Count += 1;
    }
  }

  return `Summary: ${keptCount} kept, ${deletedCount} deleted, ${updatedCount} D1 updates, ${deletedD1Count} D1 deletions, ${failedCount} failed out of ${outcomes.length}.`;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }

      results[currentIndex] = await fn(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

async function main(): Promise<void> {
  const config = cleanConfigSchema.parse({
    uploadUrl: Bun.env.UPLOAD_URL,
    uploadApiToken: Bun.env.UPLOAD_API_TOKEN,
    d1WorkerUrl: Bun.env.D1_WORKER_URL,
  });

  const data = await fetchAuthFiles(config);
  const outcomes = await runWithConcurrency(
    data.files,
    CONCURRENCY,
    (entry) => processAuthFileEntry(config, entry),
  );

  for (const outcome of outcomes) {
    if (outcome.ok) {
      console.log(formatOutcomeLog(outcome));
    } else {
      console.error(formatOutcomeLog(outcome));
    }
  }

  console.log(summarizeOutcomes(outcomes));

  const failedCount = outcomes.filter((outcome) => !outcome.ok).length;
  if (failedCount > 0) {
    throw new Error(`Failed to clean ${failedCount} of ${outcomes.length} auth files.`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`,
    );
    process.exitCode = 1;
  }
}
