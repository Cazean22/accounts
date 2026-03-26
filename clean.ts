import {
  authFilesResponseSchema,
  type AuthFileEntry,
  type AuthFilesResponse,
  type AccountStatus,
} from "./types.ts";
import { accountSchema, accountsSchema, type AccountConfig } from "./oauth.ts";

const CONCURRENCY = 10;
const COMPARE_FIELDS = ["email", "type", "last_refresh", "expired"] as const;

function makeHeaders(): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${process.env.UPLOAD_API_TOKEN}`);
  headers.set("Content-Type", "application/json");
  return headers;
}

async function fetchAuthFiles(): Promise<AuthFilesResponse> {
  const response = await fetch(`${process.env.UPLOAD_URL}/`, {
    method: "GET",
    headers: makeHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim() || response.statusText;
    throw new Error(
      `Failed to fetch auth files (${response.status}): ${detail}`,
    );
  }
  return authFilesResponseSchema.parse(await response.json());
}

interface AccountResult {
  account?: AccountConfig;
  error?: string;
}

async function downloadAuthFile(name: string): Promise<AccountResult> {
  try {
    const url = new URL(`${process.env.UPLOAD_URL}/download`);
    url.searchParams.set("name", name);
    const response = await fetch(url, {
      method: "GET",
      headers: makeHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return { error: `download http ${response.status}` };
    }
    const json = await response.json();
    const parsed = accountSchema.safeParse(json);
    if (!parsed.success) {
      return { error: "invalid auth file format" };
    }
    return { account: parsed.data };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { error: "timeout" };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchD1Token(accountId: string): Promise<AccountResult> {
  try {
    const url = new URL(`${process.env.D1_WORKER_URL}/tokens/search`);
    url.searchParams.set("account_id", accountId);
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      return { error: "not found in D1" };
    }
    if (!response.ok) {
      return { error: `d1 http ${response.status}` };
    }
    const json = await response.json();
    if (typeof json !== "object" || json === null || !Array.isArray(json)) {
      return { error: "d1 invalid response" };
    }
    const parsed = accountsSchema.safeParse(json);
    if (!parsed.success) {
      return { error: "d1 invalid response" };
    }
    if (parsed.data.length === 0) {
      return { error: "no tokens found in D1" };
    }
    return { account: parsed.data[0] };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { error: "d1 timeout" };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function diffFields(cpa: AccountConfig, d1: AccountConfig): string[] {
  const diffs: string[] = [];
  for (const field of COMPARE_FIELDS) {
    if (cpa[field] !== d1[field]) {
      diffs.push(`${field}: CPA=${cpa[field]} vs D1=${d1[field]}`);
    }
  }
  return diffs;
}

function classifyAccount(
  entry: AuthFileEntry,
  download: AccountResult,
  d1Result: AccountResult,
): AccountStatus {
  const now = new Date();
  const reasons: string[] = [];

  if (entry.unavailable) reasons.push("unavailable");
  if (entry.disabled) reasons.push("disabled");

  const tokenExpired =
    download.account?.expired !== undefined &&
    new Date(download.account.expired) < now;
  if (tokenExpired) reasons.push("token expired");

  if (download.error) reasons.push(`download error: ${download.error}`);

  if (d1Result.error) {
    reasons.push(`d1 error: ${d1Result.error}`);
  } else if (download.account && d1Result.account) {
    const diffs = diffFields(download.account, d1Result.account);
    if (diffs.length > 0) {
      reasons.push(`mismatch: ${diffs.join("; ")}`);
    }
  }

  return {
    name: entry.name,
    authIndex: entry.auth_index,
    email: entry.email,
    unavailable: entry.unavailable,
    disabled: entry.disabled,
    tokenExpired,
    downloadError: download.error,
    invalid: reasons.length > 0,
    reasons,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function main(): Promise<void> {
  const data = await fetchAuthFiles();
  const entries = data.files;
  console.log(`Fetched ${entries.length} auth files`);

  const [downloads, d1Results] = await Promise.all([
    runWithConcurrency(entries, CONCURRENCY, (entry) =>
      downloadAuthFile(entry.name),
    ),
    runWithConcurrency(entries, CONCURRENCY, (entry) => {
      const accountId =
        entry.id_token?.chatgpt_account_id ?? entry.account ?? "";
      if (accountId === "") {
        return Promise.resolve({ error: "no account_id" } as AccountResult);
      }
      return fetchD1Token(accountId);
    }),
  ]);

  const statuses: AccountStatus[] = entries.map((entry, i) =>
    classifyAccount(entry, downloads[i]!, d1Results[i]!),
  );

  const invalidAccounts = statuses.filter((s) => s.invalid);
  const validAccounts = statuses.filter((s) => !s.invalid);

  console.log(`\nTotal: ${statuses.length}`);
  console.log(`Invalid: ${invalidAccounts.length}`);
  console.log(`Valid: ${validAccounts.length}`);

  if (invalidAccounts.length > 0) {
    console.log("\n--- Invalid accounts ---");
    for (const acct of invalidAccounts) {
      console.log(
        `  ${acct.name} (${acct.email ?? "no email"}) — ${acct.reasons.join(", ")}`,
      );
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : `Unexpected error: ${String(error)}`,
  );
  process.exit(1);
}
