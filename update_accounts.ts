import { z } from "zod";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { accountsSchema, type AccountConfig } from "./oauth.ts";
const configSchema = z.object({
    sourceAccountsBaseUrl: z.url(),
    uploadUrl: z.url(),
    uploadApiToken: z.string().min(1),
    limit: z.number().int().positive().max(100),
    insecureTls: z.boolean(),
});

interface UploadRequestInit extends RequestInit {
  tls?: {
    rejectUnauthorized?: boolean;
  };
}

interface UploadResult {
  accountId: string;
  ok: boolean;
  status?: number;
  detail?: string;
}

async function fetchAccounts(sourceAccountsUrl: string): Promise<AccountConfig[]> {
  const response = await fetch(sourceAccountsUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const responseText = (await response.text()).trim();
    const detail = responseText === "" ? response.statusText : responseText;

    throw new Error(
      `Failed to fetch accounts from source (${response.status}): ${detail}`,
    );
  }

  const rawAccounts = await response.json();
  const accounts = accountsSchema.parse(rawAccounts);

  return accounts;
}

function getAccountFilename(account: AccountConfig): string {
  return `${account.account_id}.json`;
}

async function writeAccountsTempFile(account: AccountConfig): Promise<string> {
  const filename = getAccountFilename(account);
  const tempFilePath = join(
    tmpdir(),
    filename,
  );

  await Bun.write(tempFilePath, JSON.stringify(account, null, 2));

  return tempFilePath;
}

async function uploadAccountsFile(
  filename: string,
  uploadedFilename: string,
  accountId: string,
  uploadUrl: string,
  uploadApiToken: string | undefined,
  insecureTls: boolean,
): Promise<UploadResult> {
  const file = Bun.file(filename);
  const formData = new FormData();
  formData.append("file", file, uploadedFilename);

  const headers = new Headers();

  if (uploadApiToken !== undefined) {
    headers.set("Authorization", `Bearer ${uploadApiToken}`);
  }

  const requestInit: UploadRequestInit = {
    method: "POST",
    headers,
    body: formData,
    signal: AbortSignal.timeout(30_000),
  };

  if (insecureTls) {
    requestInit.tls = { rejectUnauthorized: false };
  }

  try {
    const response = await fetch(uploadUrl, requestInit);

    if (response.ok) {
      return {
        accountId,
        ok: true,
        status: response.status,
      };
    }

    const responseText = (await response.text()).trim();
    const detail = responseText === "" ? response.statusText : responseText;

    return {
      accountId,
      ok: false,
      status: response.status,
      detail,
    };
  } catch (error: unknown) {
    return {
      accountId,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
    const config = configSchema.parse({
        sourceAccountsBaseUrl: Bun.env.SOURCE_ACCOUNTS_URL,
        uploadUrl: Bun.env.UPLOAD_URL,
        uploadApiToken: Bun.env.UPLOAD_API_TOKEN,
        limit: parseInt(Bun.env.UPDATE_ACCOUNTS_LIMIT ?? "100", 10),
        insecureTls: Bun.env.INSECURE_TLS === "true",
    });
    const sourceUrl = new URL(config.sourceAccountsBaseUrl);
    sourceUrl.searchParams.set("limit", String(config.limit));
    const accounts = await fetchAccounts(config.sourceAccountsBaseUrl);
    const uploadResults: UploadResult[] = [];

    for (const account of accounts) {
        const uploadedFilename = getAccountFilename(account);
        let tempFilePath: string | undefined;

        try {
            tempFilePath = await writeAccountsTempFile(account);
            console.log(`Prepared ${uploadedFilename} at ${tempFilePath}`);

            const uploadResult = await uploadAccountsFile(
                tempFilePath,
                uploadedFilename,
                account.account_id,
                config.uploadUrl,
                config.uploadApiToken,
                config.insecureTls,
            );

        uploadResults.push(uploadResult);

        if (uploadResult.ok) {
            console.log(`Uploaded ${uploadedFilename} to ${config.uploadUrl}`);
        } else {
            const statusSuffix =
                typeof uploadResult.status === "number"
                    ? ` (status ${uploadResult.status})`
                    : "";
            const detailSuffix =
                uploadResult.detail === undefined ? "" : `: ${uploadResult.detail}`;

            console.error(
                `Failed to upload ${uploadedFilename}${statusSuffix}${detailSuffix}`,
            );
        }
        } finally {
            if (tempFilePath !== undefined) {
                await rm(tempFilePath, { force: true });
            }
        }
    }

  const successfulUploads = uploadResults.filter((result) => result.ok);
  const failedUploads = uploadResults.filter((result) => !result.ok);

  console.log(
    `${successfulUploads.length}/${accounts.length} account files for ${config.uploadUrl}`,
  );

  if (failedUploads.length > 0) {
    throw new Error(
      `Failed to upload ${failedUploads.length} of ${accounts.length} account files.`,
    );
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(
    error instanceof Error ? error.message : `Unexpected error: ${String(error)}`,
  );
  process.exit(1);
}
