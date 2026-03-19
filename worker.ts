import { ZodError } from "zod";

import { upsertRedactedAccount, type D1DatabaseLike } from "./d1-store.ts";
import { submitCallbackUrl, type FetchLike } from "./oauth.ts";
import {
  storeRedactedAccountRequestSchema,
  toRedactedAccount,
  type RedactedAccount,
  type StoreRedactedAccountRequest,
} from "./redacted-account.ts";

export interface WorkerEnv {
  ACCOUNTS_DB: D1DatabaseLike;
}

interface WorkerDeps {
  submitCallbackUrl: typeof submitCallbackUrl;
  upsertRedactedAccount: typeof upsertRedactedAccount;
  fetchImpl?: FetchLike;
}

interface ErrorResponseOptions {
  status: number;
  error: string;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(body: { account: RedactedAccount } | { error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function isValidationLikeError(error: unknown): boolean {
  return error instanceof ZodError;
}

function isUpstreamTokenExchangeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Token exchange failed:");
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isClientCallbackError(error: unknown): boolean {
  if (isValidationLikeError(error)) {
    return true;
  }

  if (error instanceof SyntaxError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error instanceof TypeError &&
    error.message.includes("cannot be parsed as a URL")
  ) {
    return true;
  }

  return [
    "OAuth error:",
    "Callback URL is missing ?code=",
    "Callback URL is missing ?state=",
    "State validation failed",
  ].some((prefix) => error.message.startsWith(prefix));
}

function errorResponse({ status, error }: ErrorResponseOptions): Response {
  return jsonResponse({ error }, status);
}

async function parseStoreRequest(request: Request): Promise<StoreRedactedAccountRequest> {
  const payload: unknown = await request.json();
  return storeRedactedAccountRequestSchema.parse(payload);
}

export async function handleRequest(
  request: Request,
  env: WorkerEnv,
  deps: WorkerDeps = {
    submitCallbackUrl,
    upsertRedactedAccount,
  },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== "/oauth/callback") {
    return errorResponse({ status: 404, error: "Not found" });
  }

  if (request.method !== "POST") {
    return errorResponse({ status: 405, error: "Method not allowed" });
  }

  try {
    const parsedRequest = await parseStoreRequest(request);
    const result = await deps.submitCallbackUrl({
      callbackUrl: parsedRequest.callbackUrl,
      expectedState: parsedRequest.expectedState,
      codeVerifier: parsedRequest.codeVerifier,
      redirectUri: parsedRequest.redirectUri,
      tokenUrl: parsedRequest.tokenUrl,
      clientId: parsedRequest.clientId,
      accountType: parsedRequest.accountType,
      fetchImpl: deps.fetchImpl,
    });
    const redactedAccount = toRedactedAccount(result.accountConfig);

    await deps.upsertRedactedAccount(env.ACCOUNTS_DB, redactedAccount);

    return jsonResponse({ account: redactedAccount });
  } catch (error) {
    if (isClientCallbackError(error)) {
      return errorResponse({
        status: 400,
        error: getErrorMessage(error, "Invalid request"),
      });
    }

    if (isUpstreamTokenExchangeError(error)) {
      return errorResponse({
        status: 502,
        error: getErrorMessage(error, "Token exchange failed"),
      });
    }

    return errorResponse({ status: 500, error: "Internal server error" });
  }
}

const worker = {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};

export default worker;
