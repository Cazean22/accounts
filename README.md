# accounts

This repo includes a safe Bun/TypeScript OAuth helper rewrite for PKCE-based authorization only.
It does **not** include temp-mail flows, signup automation, OTP handling, sentinel bypasses, workspace/account creation, or any other account-registration logic.
It also includes a safe Cloudflare Worker + D1 slice that persists only redacted account metadata — never OAuth tokens.

To install dependencies:

```bash
bun install
```

To split the existing `asserts/accounts.json` array into per-account files under `asserts/data`:

```bash
bun run index.ts
```

To generate an OAuth URL and PKCE values from the safe CLI demo:

```bash
bun run main.ts
```

To submit a copied callback URL and print the parsed token/account result as JSON:

```bash
bun run main.ts --callback-url "http://localhost:1455/auth/callback?code=YOUR_CODE&state=YOUR_STATE" --state "YOUR_STATE" --verifier "YOUR_VERIFIER"
```

To run tests:

```bash
bun test
```

To typecheck the project:

```bash
bun run typecheck
```

## Worker + D1

The root-level `worker.ts` exports a Cloudflare module worker with one endpoint:

```text
POST /oauth/callback
```

Request body:

```json
{
  "callbackUrl": "http://localhost:1455/auth/callback?code=YOUR_CODE&state=YOUR_STATE",
  "expectedState": "YOUR_STATE",
  "codeVerifier": "YOUR_PKCE_VERIFIER",
  "redirectUri": "http://localhost:1455/auth/callback"
}
```

Flow:

1. Validates the request with `storeRedactedAccountRequestSchema`
2. Calls `submitCallbackUrl()` from `oauth.ts`
3. Projects `result.accountConfig` to a redacted token-free record
4. Upserts that redacted record into D1
5. Returns JSON containing only the redacted account object

Persisted columns are limited to:

```text
account_id, email, type, last_refresh, expired
```

The Worker never persists, returns, or intentionally logs `id_token`, `access_token`, or `refresh_token`.

### D1 setup and migrations

`wrangler.toml` binds D1 as `ACCOUNTS_DB` and uses the `migrations/` directory.

Create the D1 database and apply migrations with Wrangler:

```bash
bunx wrangler d1 create accounts
bunx wrangler d1 migrations apply ACCOUNTS_DB --local
```

You can also validate the Worker configuration locally without deploying:

```bash
bun run check:worker
```

Note: `index.ts` is a local data-shaping utility for already-existing account JSON. The safe OAuth helper entrypoint is `main.ts`.

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
