# OpenAI Codex Account Registration Flow

This document provides a detailed, step-by-step explanation of the automated account registration flow implemented in `main.py`. The flow is split into two phases: **Registration** (creating the account) and **Login** (obtaining OAuth tokens). This two-phase design is the key technique that bypasses the phone verification (`add_phone`) gate.

---

## Architecture Overview

```
Phase 1: REGISTRATION (Session s)            Phase 2: LOGIN (Session s2)
========================================      ========================================
1. Generate temp email                        7a. New OAuth init (fresh session)
2. OAuth init (get oai-did)                   7b. authorize/continue (screen_hint=login)
3. Sentinel + SignUp                          7c. Password verify
4. Set password + trigger OTP                 7d. Login email OTP
5. Verify registration OTP                    8.  Consent + Workspace selection
6. Create account (name/birthdate)            9.  Follow redirects -> Callback URL
     |                                        10. Exchange authorization code for tokens
     | Account now exists server-side.
     | Registration session ABANDONED.              |
     +----> add_phone gate is irrelevant            +----> Tokens obtained successfully
```

The critical insight: after step 6, the account exists in OpenAI's system. The registration session (`s`) may be stuck at an `add_phone` gate, but that session is simply discarded. A brand-new login session (`s2`) authenticates with the just-created credentials. The **login pipeline does not enforce phone verification**, so tokens are obtained cleanly.

---

## Prerequisites

| Component | Purpose |
|---|---|
| `curl_cffi` | HTTP client with TLS fingerprint impersonation (`impersonate="chrome"`) to avoid bot detection |
| TempMail.lol API | Disposable email inbox creation and polling |
| Proxy (optional) | Route traffic through a non-restricted region (avoid CN/HK/RU IPs) |

---

## Phase 1: Registration

### Step 1 - Generate Temporary Email

```
POST https://api.tempmail.lol/v2/inbox/create
Body: {}
```

**What happens:**
- A `curl_cffi` session with Chrome TLS fingerprinting is created, optionally using a proxy.
- The TempMail.lol v2 API creates a random disposable email address.
- The response contains `address` (the email) and `token` (used to poll for incoming messages later).

**Why it matters:**
- The email must be a real, receivable address because OpenAI sends OTP verification codes to it.
- Using `curl_cffi` with `impersonate="chrome"` ensures the TLS handshake fingerprint matches a real Chrome browser, avoiding Cloudflare/bot detection on the email API itself.

**Variables produced:** `email`, `inbox` (EMail object for polling)

---

### Step 2 - OAuth Initialization (Registration Session)

```
GET https://auth.openai.com/oauth/authorize?client_id=...&response_type=code&redirect_uri=...&scope=...&state=...&code_challenge=...&code_challenge_method=S256&prompt=login&id_token_add_organizations=true&codex_cli_simplified_flow=true
```

**What happens:**
1. **Generate PKCE pair:** A `code_verifier` (random 64-byte URL-safe string) and its SHA-256 hash `code_challenge` are generated. This is the standard PKCE (Proof Key for Code Exchange) flow required by OAuth 2.0 public clients.
2. **Generate state:** A random `state` string for CSRF protection.
3. **Build authorize URL** with these parameters:
   - `client_id`: `app_EMoamEEZ73f0CkXaXp7hrann` (OpenAI Codex CLI client)
   - `redirect_uri`: `http://localhost:1455/auth/callback` (local callback, never actually served)
   - `scope`: `openid email profile offline_access` (request refresh token via `offline_access`)
   - `codex_cli_simplified_flow`: `true` (tells auth server this is a CLI flow)
4. **GET the authorize URL** using session `s`. This initiates the auth flow server-side and sets the `oai-did` cookie.

**Critical cookie:** `oai-did` - A device identifier cookie set by OpenAI's auth server. This is required for all subsequent API calls in the session (especially Sentinel token requests). If missing, the flow cannot proceed.

**Variables produced:** `oauth` (OAuthStart dataclass), `did` (oai-did cookie value)

---

### Step 3 - Sentinel Token + SignUp

#### 3a. Sentinel Token Request

```
POST https://sentinel.openai.com/backend-api/sentinel/req
Headers:
  origin: https://sentinel.openai.com
  referer: https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6
  content-type: text/plain;charset=UTF-8
Body: {"p": "", "id": "<oai-did>", "flow": "authorize_continue"}
```

**What happens:**
- The Sentinel service is OpenAI's proof-of-work / anti-bot challenge system.
- A token is requested with the device ID (`oai-did`) and the flow name `authorize_continue`.
- The response contains a `token` field (the solved challenge).
- This token is packaged into a JSON string: `{"p": "", "t": "", "c": "<token>", "id": "<did>", "flow": "authorize_continue"}`

**Why it matters:**
- Every sensitive API call (signup, create_account, login, password verify) requires a fresh Sentinel token in the `openai-sentinel-token` header.
- Without it, the request is rejected as a bot.

#### 3b. SignUp Request

```
POST https://auth.openai.com/api/accounts/authorize/continue
Headers:
  referer: https://auth.openai.com/create-account
  accept: application/json
  content-type: application/json
  openai-sentinel-token: <sentinel_json>
Body: {"username": {"value": "<email>", "kind": "email"}, "screen_hint": "signup"}
```

**What happens:**
- This tells OpenAI's auth server: "I want to **sign up** a new account with this email address."
- `screen_hint: "signup"` is critical -- it routes the flow into the registration pipeline (as opposed to `"login"` which enters the login pipeline).
- If the email is already registered, this will fail.
- On success (HTTP 200), the server acknowledges the signup intent and the session moves to the password-setting stage.

---

### Step 4 - Set Password + Trigger Registration OTP

#### 4a. Register Password

```
POST https://auth.openai.com/api/accounts/user/register
Headers:
  referer: https://auth.openai.com/create-account/password
  accept: application/json
  content-type: application/json
Body: {"password": "<generated_password>", "username": "<email>"}
```

**What happens:**
- A strong password is generated: 10 random alphanumeric characters + `Aa1@!` suffix (guarantees uppercase, lowercase, digit, and special character requirements).
- The password and email are submitted to create the credential pair server-side.

**Variables produced:** `openai_pwd` (saved for the login phase later)

#### 4b. Navigate to Password Page

```
GET https://auth.openai.com/create-account/password
```

This page navigation is needed to maintain correct server-side session state (the auth server tracks which "page" the user is on).

#### 4c. Send OTP

```
GET https://auth.openai.com/api/accounts/email-otp/send
Headers:
  referer: https://auth.openai.com/create-account/password
  accept: application/json
```

**What happens:**
- Triggers OpenAI to send a 6-digit OTP verification code to the registered email address.
- This is the **registration OTP** (distinct from the login OTP that comes later).

---

### Step 5 - Wait for and Verify Registration OTP

#### 5a. Poll for Email

The `inbox.wait_for_message()` method polls `GET https://api.tempmail.lol/v2/inbox?token=<token>` every 5 seconds, for up to 300 seconds (5 minutes).

**Filter function:** Only accepts emails whose subject contains any of: `openai`, `verification`, `code`, `otp`.

**OTP extraction:** A regex `\b(\d{6})\b` extracts the first 6-digit number from the email body (or HTML body, or subject as fallback).

**Variables produced:** `registration_otp` (the 6-digit code)

#### 5b. Validate OTP

```
POST https://auth.openai.com/api/accounts/email-otp/validate
Headers:
  referer: https://auth.openai.com/email-verification
  accept: application/json
  content-type: application/json
Body: {"code": "<6-digit-code>"}
```

**What happens:**
- Submits the extracted OTP to the auth server.
- On success (HTTP 200), the email is verified, and the registration flow advances to the "about you" profile step.

---

### Step 6 - Create Account (Profile Information)

```
POST https://auth.openai.com/api/accounts/create_account
Headers:
  referer: https://auth.openai.com/about-you
  accept: application/json
  content-type: application/json
  openai-sentinel-token: <fresh_sentinel_json>
Body: {"name": "<random_name>", "birthdate": "<random_date>"}
```

**What happens:**
- A new Sentinel token is requested (required for this endpoint).
- A random name (e.g., "Emma Johnson") and birthdate (e.g., "1993-07-15") are generated.
- The profile information is submitted, completing the account creation.

**Critical point - what happens next in the registration flow:**
- The server response may contain `{"page": {"type": "add_phone"}}`, meaning OpenAI wants phone verification.
- **In the old approach**, this was a dead end -- the code would fail here.
- **In the new approach**, we don't care about this response at all. The account already exists server-side with valid email + password credentials. We simply abandon session `s` and proceed to Phase 2.

**Randomized data rationale:**
- Using the same name/birthdate for every account is a fingerprinting signal.
- Random names are drawn from pools of 10 common first names and 10 common last names (100 combinations).
- Birthdates range from 1985 to 2003, with random month (1-12) and day (1-28, safe for all months).

---

## Phase 2: Login (Bypass add_phone)

This is the core innovation. A completely fresh HTTP session (`s2`) is created to log in with the credentials from Phase 1. The login pipeline does not enforce the `add_phone` gate.

This phase has **3 retry attempts** with 2-second delays between retries, to handle transient TLS or network errors.

### Step 7a - New OAuth Initialization (Login Session)

```python
s2 = requests.Session(proxies=proxies, impersonate="chrome")
oauth2 = generate_oauth_url()
s2.get(oauth2.auth_url)
did2 = s2.cookies.get("oai-did")
```

**What happens:**
- A **completely new** `curl_cffi` session is created. It has no cookies, no state from the registration session.
- A **new** OAuth flow is initialized with fresh `state`, `code_verifier`, and `code_challenge`.
- A **new** `oai-did` cookie is obtained.

**Why a new session:** The registration session's server-side state is stuck at `add_phone`. A fresh session starts with a clean slate -- from the server's perspective, this is a different device/browser visiting for the first time.

### Step 7b - Login authorize/continue

```
POST https://auth.openai.com/api/accounts/authorize/continue
Headers:
  referer: https://auth.openai.com/log-in
  accept: application/json
  content-type: application/json
  openai-sentinel-token: <sentinel_for_s2>
Body: {"username": {"value": "<email>", "kind": "email"}, "screen_hint": "login"}
```

**Key difference from Step 3b:**
- `screen_hint` is `"login"` (not `"signup"`)
- `referer` is `https://auth.openai.com/log-in` (not `/create-account`)

**What happens:**
- The auth server recognizes the email as an existing account and enters the **login** pipeline.
- The response contains a `continue_url` that the client must GET to advance the flow.

**Why this bypasses add_phone:**
The `add_phone` requirement is a gate in the **registration** pipeline only. The login pipeline has its own set of verification steps (password + email OTP), and phone verification is not among them.

### Step 7c - Password Verification

```
POST https://auth.openai.com/api/accounts/password/verify
Headers:
  referer: https://auth.openai.com/log-in/password
  accept: application/json
  content-type: application/json
  openai-sentinel-token: <sentinel_for_s2>
Body: {"password": "<openai_pwd>"}
```

**What happens:**
- The password set during registration (step 4a) is submitted for verification.
- A fresh Sentinel token is required for this endpoint.
- On success, the flow advances to email verification.

### Step 7d - Login Email OTP

#### Trigger OTP

```
GET https://auth.openai.com/email-verification
Headers:
  referer: https://auth.openai.com/log-in/password
```

**What happens:**
- Navigating to the email-verification page automatically triggers the server to send a new OTP to the email address.
- A 2-second wait is added before starting to poll, to give the email time to arrive.

#### Poll for Login OTP

The same TempMail.lol inbox is polled (up to 40 iterations, 2 seconds apart = ~80 seconds max):

```python
# Extract all 6-digit codes from all emails
# Filter out the registration_otp (already used in step 5)
# The remaining code is the login OTP
new_codes = [c for c in all_codes if c != registration_otp]
```

**Why filtering is needed:**
The TempMail.lol inbox returns ALL emails received since creation. The registration OTP email is still there. By excluding the known `registration_otp` value, we isolate the new login OTP.

#### Validate Login OTP

```
POST https://auth.openai.com/api/accounts/email-otp/validate
Headers:
  referer: https://auth.openai.com/email-verification
  accept: application/json
  content-type: application/json
Body: {"code": "<login_otp>"}
```

**What happens:**
- The login OTP is validated.
- The response contains a `continue_url` for the consent/workspace selection step.

---

### Step 8 - Consent + Workspace Selection

#### 8a. Follow Consent URL

```
GET <continue_url from OTP validation response>
```

This sets the `oai-client-auth-session` cookie, which contains the workspace information.

#### 8b. Parse Auth Cookie

The `oai-client-auth-session` cookie is a base64-encoded JSON payload (before the first `.`). It contains:

```json
{
  "workspaces": [
    {"id": "ws_xxxxx", ...}
  ],
  ...
}
```

The first workspace ID is extracted.

#### 8c. Select Workspace

```
POST https://auth.openai.com/api/accounts/workspace/select
Headers:
  referer: <consent_url>
  accept: application/json
  content-type: application/json
Body: {"workspace_id": "<workspace_id>"}
```

**What happens:**
- Selects the workspace (account context) for the token.
- The response may contain a `continue_url` for the final redirect chain.

#### 8d. Handle Organization Selection (if required)

If the workspace selection response contains `page.type == "organization_select"`, an additional step is needed:

```
POST https://auth.openai.com/api/accounts/organization/select
Body: {"org_id": "<org_id>", "project_id": "<default_project_id>"}
```

This selects the first available organization and its default project.

---

### Step 9 - Follow Redirects to Callback URL

```python
r = s2.get(sel_data["continue_url"], allow_redirects=False)
for _ in range(20):
    loc = r.headers.get("Location", "")
    if loc.startswith("http://localhost"):
        cbk = loc
        break
    if r.status_code not in (301, 302, 303) or not loc:
        break
    r = s2.get(loc, allow_redirects=False)
```

**What happens:**
- Starting from the `continue_url`, each redirect is followed manually (one hop at a time).
- The loop continues until a `Location` header points to `http://localhost:1455/auth/callback?code=...&state=...`.
- This localhost URL is never actually served -- it's the OAuth callback URL that would normally be handled by a local server. The `code` and `state` parameters are extracted from it.

**Why up to 20 hops:**
OpenAI's auth flow involves multiple intermediate redirects through different subdomains. The exact number can vary, so a generous limit of 20 is used instead of hardcoding a specific number.

---

### Step 10 - Exchange Authorization Code for Tokens

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Body:
  grant_type=authorization_code
  client_id=app_EMoamEEZ73f0CkXaXp7hrann
  code=<authorization_code>
  redirect_uri=http://localhost:1455/auth/callback
  code_verifier=<code_verifier_from_step_7a>
```

**What happens:**
- The standard OAuth 2.0 authorization code exchange.
- The `code` from the callback URL and the `code_verifier` from the PKCE pair (generated in step 7a for session `s2`) are sent.
- The token endpoint verifies:
  1. The `code` is valid and not expired.
  2. The `code_verifier` hashes to the `code_challenge` sent in step 7a.
  3. The `redirect_uri` matches.
  4. The `client_id` matches.

**Important:** The token exchange uses session `s2` (via the `session` parameter), so it goes through the proxy and has Chrome TLS fingerprinting. This avoids bot detection on the token endpoint.

**Response:**

```json
{
  "access_token": "eyJ...",
  "refresh_token": "v1.xxx...",
  "id_token": "eyJ...",
  "expires_in": 1800,
  "token_type": "Bearer"
}
```

**Token processing:**
1. The `id_token` is decoded (base64, no signature verification) to extract:
   - `email`: the account's email address
   - `https://api.openai.com/auth.chatgpt_account_id`: the account ID
2. The expiration time is calculated as `now + expires_in` and formatted as RFC 3339.
3. All fields are assembled into the final config JSON:

```json
{
  "id_token": "eyJ...",
  "access_token": "eyJ...",
  "refresh_token": "v1.xxx...",
  "account_id": "acc_xxxxx",
  "last_refresh": "2026-03-22T10:00:00Z",
  "email": "random@tempmail.lol",
  "type": "codex",
  "expired": "2026-03-22T10:30:00Z"
}
```

---

## Flow Diagram with HTTP Requests

```
SESSION s (Registration)
========================

[1] POST api.tempmail.lol/v2/inbox/create
         --> email, token

[2] GET  auth.openai.com/oauth/authorize?...
         --> oai-did cookie

[3] POST sentinel.openai.com/.../sentinel/req     (Sentinel #1)
    POST auth.openai.com/.../authorize/continue    (screen_hint=signup)

[4] POST auth.openai.com/.../user/register         (set password)
    GET  auth.openai.com/create-account/password    (navigate)
    GET  auth.openai.com/.../email-otp/send         (trigger OTP)

[5] POLL api.tempmail.lol/v2/inbox?token=...        (wait for email)
    POST auth.openai.com/.../email-otp/validate     (verify OTP)

[6] POST sentinel.openai.com/.../sentinel/req       (Sentinel #2)
    POST auth.openai.com/.../create_account          (name + birthdate)

    ---- Session s ABANDONED (add_phone is irrelevant) ----


SESSION s2 (Login)
==================

[7a] GET  auth.openai.com/oauth/authorize?...       (new OAuth flow)
          --> oai-did cookie (new)

[7b] POST sentinel.openai.com/.../sentinel/req      (Sentinel #3)
     POST auth.openai.com/.../authorize/continue     (screen_hint=login)
     GET  <continue_url>

[7c] POST sentinel.openai.com/.../sentinel/req      (Sentinel #4)
     POST auth.openai.com/.../password/verify        (verify password)

[7d] GET  auth.openai.com/email-verification         (trigger login OTP)
     POLL api.tempmail.lol/v2/inbox?token=...        (wait, filter out registration OTP)
     POST auth.openai.com/.../email-otp/validate     (verify login OTP)

[8]  GET  <consent continue_url>                     (set auth cookie)
     POST auth.openai.com/.../workspace/select       (select workspace)
     POST auth.openai.com/.../organization/select    (if needed)

[9]  GET  <continue_url> --> 302 --> 302 --> ...     (follow redirects)
          --> http://localhost:1455/auth/callback?code=...&state=...

[10] POST auth.openai.com/oauth/token                (exchange code for tokens)
          --> access_token, refresh_token, id_token
```

---

## Why the Two-Phase Approach Bypasses add_phone

| Aspect | Registration Pipeline | Login Pipeline |
|---|---|---|
| Entry point | `screen_hint: "signup"` | `screen_hint: "login"` |
| Verification steps | email OTP -> create_account -> **add_phone** -> workspace | password -> email OTP -> consent -> workspace |
| Phone verification | **Enforced** (gate between create_account and workspace) | **Not enforced** |
| Session | `s` (abandoned after step 6) | `s2` (fresh, no registration state) |

The `add_phone` check is a server-side gate that exists **only in the registration flow's state machine**. After `create_account` responds, the server's next expected step for that session is phone verification. But the account credentials (email + password) are already persisted server-side.

By opening a completely new session with a new `oai-did`, new OAuth state, and using `screen_hint: "login"`, we enter a different server-side state machine that has no `add_phone` gate. The login flow trusts that the email is already verified (it was, during registration) and only requires password + email OTP.

---

## Error Handling and Retry Logic

The login phase (step 7-10) is wrapped in a retry loop:

```python
for login_attempt in range(3):
    try:
        # ... entire login flow ...
        return submit_callback_url(...)  # success -> return
    except Exception as e:
        if login_attempt == 2:
            return f"[!] 登录重试 3 次均失败: {e}"  # give up after 3 tries
        print(f"[!] 登录失败，重试 ({login_attempt + 1}/3): {e}")
        time.sleep(2)
```

Each retry creates a completely fresh session, OAuth state, and Sentinel tokens. This handles transient TLS handshake failures, network timeouts, and other intermittent errors.

---

## Sentinel Token Details

The Sentinel system acts as OpenAI's anti-bot proof-of-work mechanism. Key details:

- **Endpoint:** `POST https://sentinel.openai.com/backend-api/sentinel/req`
- **Required headers:** Must include correct `origin` and `referer` pointing to `sentinel.openai.com`
- **Request body:** `{"p": "", "id": "<oai-did>", "flow": "authorize_continue"}`
- **Response:** `{"token": "<challenge_solution>"}`
- **Header format:** The solved token is wrapped in a JSON string and sent as the `openai-sentinel-token` header:
  ```json
  {"p": "", "t": "", "c": "<solved_token>", "id": "<oai-did>", "flow": "authorize_continue"}
  ```

Sentinel tokens are **session-scoped** -- a token obtained with session `s` and its `oai-did` cannot be used with session `s2` and its different `oai-did`. Each session must request its own tokens.

---

## Main Loop (Production)

The `__main__` block runs the registration in an infinite loop:

1. Call `run(proxy)` to register one account.
2. If the result starts with `{` (valid JSON), it's a success:
   - Parse and re-serialize the config JSON.
   - POST it to the configured `TOKENS_URL` server.
   - Expect HTTP 201 (Created) from the server.
3. If it starts with `[!]` or `[-]`, it's an error message -- log and continue.
4. On exception, wait 3 seconds and retry.
5. Always wait 1 second between iterations to avoid hammering APIs.
