# AGENTS.md

Guidance for coding agents working in `/Users/yangtingmei/Documents/codes/ts/accounts`.
Follow the repo’s actual commands and patterns unless the user explicitly asks otherwise.

## Scope and Safety

- This is a **safe Bun/TypeScript OAuth helper** plus a **safe Cloudflare Worker + D1** repo.
- Do **not** add temp-mail flows, signup automation, OTP handling, sentinel bypasses, workspace/account creation, or similar account-registration automation.
- Do **not** persist `id_token`, `access_token`, or `refresh_token` in the Worker/D1 path.
- The Worker/D1 layer is for **redacted account metadata only**.
- If asked to widen the repo into unsafe automation, stop and explain the boundary.

## Source of Truth

Prefer these files when deciding how to work:

- `CLAUDE.md` — Bun-first runtime and tooling preferences
- `README.md` — human-facing workflow and scope notes
- `package.json` — scripts and installed tools
- `tsconfig.json` — strict TypeScript rules
- `wrangler.toml` — Worker entrypoint and D1 binding config

Checked and currently **not present**:

- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`

## Runtime and Tooling

- Prefer **Bun** over Node/npm/yarn/pnpm.
- Use `bun run <file>` for entrypoints.
- Use `bun test` for tests.
- Use `bunx <tool>` for CLIs like TypeScript and Wrangler.
- Bun loads `.env` automatically; do not add `dotenv` unless explicitly requested.

## Install / Run / Verify

Run all commands from `/Users/yangtingmei/Documents/codes/ts/accounts`.

### Install

```bash
bun install
```

### Main entrypoints

```bash
bun run index.ts
bun run main.ts
bun run main.ts --callback-url "http://localhost:1455/auth/callback?code=YOUR_CODE&state=YOUR_STATE" --state "YOUR_STATE" --verifier "YOUR_VERIFIER"
```

### Tests

```bash
bun test
bun test worker.test.ts
bun test oauth.test.ts
bun test --test-name-pattern "stores and returns only the redacted account fields"
bun test worker.test.ts --test-name-pattern "maps malformed JSON to 400"
```

### Typecheck

```bash
bun run typecheck
# equivalent:
bunx tsc --noEmit
```

### Worker / D1

`wrangler.toml` currently binds D1 as `codex` and uses `migrations/`.

```bash
bun run check:worker
bunx wrangler d1 create codex
bunx wrangler d1 migrations apply codex --local
bunx wrangler d1 migrations apply codex
```

### Typical verification sequence

```bash
bun test && bun run typecheck && bun run check:worker
```

## Project Layout

- `oauth.ts` — PKCE/OAuth helpers, schemas, token parsing, typed shaping logic
- `main.ts` — CLI/demo entrypoint for the safe OAuth flow
- `index.ts` — Bun script that reshapes `asserts/accounts.json` into per-account files
- `redacted-account.ts` — redacted persistence schema and projection helpers
- `d1-store.ts` — D1 storage helper for redacted account rows
- `worker.ts` — Cloudflare Worker entrypoint
- `*.test.ts` — root-level Bun tests
- `migrations/` — D1 SQL migrations

Keep the repo **flat**. Do not introduce `src/` unless explicitly requested.

## TypeScript Rules

Follow `tsconfig.json` closely:

- `strict: true`
- `moduleResolution: "bundler"`
- `allowImportingTsExtensions: true`
- `verbatimModuleSyntax: true`
- `noEmit: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitOverride: true`

Practical implications:

- Always use explicit local import extensions like `./oauth.ts`.
- Prefer narrow, validated types over broad object shapes.
- Treat unchecked property access as suspicious.

## Import and Formatting Style

- External imports first, then a blank line, then local imports.
- Use named imports.
- Use inline `type` imports where appropriate.
- Use **2-space indentation**.
- Use **double quotes** and **semicolons**.
- Keep trailing commas in multiline objects, arrays, params, and imports.
- Match the surrounding file when wrapping long expressions.

Example:

```ts
import { ZodError } from "zod";

import { submitCallbackUrl, type FetchLike } from "./oauth.ts";
```

## Naming Conventions

- `camelCase` for functions, locals, helpers, fixtures, and object fields
- `PascalCase` for interfaces and type aliases
- `SCREAMING_SNAKE_CASE` for stable constants, URLs, and SQL constants
- Suffix Zod schemas with `Schema`
- Suffix option bags with `Options`

Examples already used here:

- `oauthTokenResponseSchema`
- `SubmitCallbackUrlOptions`
- `UPSERT_REDACTED_ACCOUNT_SQL`

## Schema and Type Style

- Zod schemas are the source of truth at trust boundaries.
- Export schemas for public contracts and derive types with `z.infer<typeof ...>`.
- Parse or validate request JSON, callback input, token responses, DB inputs, and file inputs.
- Prefer schema composition over duplication: `pick`, `array`, `optional`, `default`, `preprocess`, `transform`.
- If you project a safe subset from a larger shape, parse it again with the smaller schema.

This repo is intentionally **schema-first**.

## Error Handling

- Validate early and fail fast.
- Throw plain `Error` objects with stable, readable messages.
- At HTTP boundaries, map errors into explicit status codes.
- Use narrow predicates like `instanceof ZodError` or stable message-prefix checks.
- Never use empty catch blocks.
- Never suppress types with `as any`, `@ts-ignore`, or `@ts-expect-error`.

## Worker and Database Conventions

- Keep `worker.ts` thin; move reusable logic into modules.
- Return JSON through small helpers instead of repeating inline response construction.
- Use parameterized SQL only.
- Never interpolate values directly into SQL strings.
- Validate data before persistence.
- Persist only the redacted account shape, never the full token-bearing account shape.

## Test Conventions

- Use `bun:test` with `describe`, `test`, and `expect`.
- Keep tests close to the exported behavior they cover.
- Prefer local fixtures and tiny helper constructors.
- Prefer dependency injection over global monkey-patching.
- Cover both success paths and error paths.
- For safety-sensitive code, assert both what **is** returned and what **is not** returned.

Good examples in this repo:

- `worker.test.ts` — HTTP request/response behavior
- `d1-store.test.ts` — SQL shape assertions
- `redacted-account.test.ts` — schema projection and field exclusion
- `oauth.test.ts` — fetch mocking and boundary validation

## Bun-First Preferences from CLAUDE.md

- Use `bun test` instead of Jest/Vitest.
- Use `bun run <script>` instead of npm/yarn/pnpm script runners.
- Use `bunx <package> <command>` instead of `npx`.
- Prefer `Bun.file` and `Bun.write` for Bun-side file work.

Avoid introducing these without a strong reason:

- Express
- dotenv
- ws
- pg / postgres.js
- ioredis
- Vite for simple Bun-served work

## Current Caveat

- Oracle review found that the current Worker request schema still allows optional caller-controlled overrides such as `redirectUri`, `tokenUrl`, `clientId`, and `accountType`, while `README.md` documents a tighter request shape.
- If you touch `worker.ts` or `redacted-account.ts`, prefer tightening or clearly documenting that contract instead of widening it.

## Minimum Finish Checklist

For most TypeScript changes:

```bash
bun test
bun run typecheck
```

For Worker or D1 changes, also run:

```bash
bun run check:worker
```

If you changed one module, run its closest targeted tests first, then the full suite.
