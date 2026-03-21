import { appendFile } from "node:fs/promises";

import { Session, type SimpleResponse } from "./session.ts";
import { EMail, Message, type MessageData } from "./tempmail.ts";
import { generateOAuthUrl, submitCallbackUrl } from "./oauth.ts";

// ====================== Safe JSON parsing ======================

async function safeJson(resp: SimpleResponse, label: string): Promise<unknown> {
  const text = await resp.text();
  if (text.startsWith("<")) {
    throw new Error(
      `${label} returned HTML instead of JSON (status ${resp.status}). Likely Cloudflare challenge.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} returned invalid JSON (status ${resp.status}): ${text.slice(0, 200)}`,
    );
  }
}

// ====================== Password generation ======================

function getPassword(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let base = "";
  for (let i = 0; i < 10; i++) {
    base += chars[Math.floor(Math.random() * chars.length)];
  }
  return base + "Aa1@!";
}

// ====================== Randomized profile data ======================

const FIRST_NAMES = ["James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Sophia", "Mason", "Lucas", "Mia"];
const LAST_NAMES = ["Smith", "Johnson", "Brown", "Davis", "Wilson", "Moore", "Taylor", "Clark", "Lee", "Hall"];

function randomName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

function randomBirthdate(): string {
  const year = 1985 + Math.floor(Math.random() * 19); // 1985-2003
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ====================== Sentinel helper ======================

async function buildSentinel(s: Session, did: string): Promise<string> {
  const resp = await s.post(
    "https://sentinel.openai.com/backend-api/sentinel/req",
    {
      headers: {
        origin: "https://sentinel.openai.com",
        referer:
          "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6",
        "content-type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify({ p: "", id: did, flow: "authorize_continue" }),
    },
  );
  if (resp.status !== 200) {
    throw new Error(`Sentinel verification failed: ${await resp.text()}`);
  }
  const data = (await safeJson(resp, "Sentinel")) as { token?: string };
  return JSON.stringify({
    p: "",
    t: "",
    c: data.token ?? "",
    id: did,
    flow: "authorize_continue",
  });
}

// ====================== OTP filter ======================

const otpFilter = (msg: Message) => {
  const subj = (msg.subject ?? "").toLowerCase();
  return ["openai", "验证码", "verification", "code", "otp"].some((kw) =>
    subj.includes(kw),
  );
};

// ====================== Core logic (registration + login) ======================

async function run(proxy: string): Promise<string> {
  const s = await Session.create({ proxy: proxy || undefined });

  try {
    // 1. Generate email (TempMail.lol, via proxy)
    const inbox = await EMail.create(proxy || undefined);
    const email = inbox.address;

    // 2. OAuth init (registration session)
    const oauth = await generateOAuthUrl();
    try {
      await s.get(oauth.authUrl);
    } catch {
      // Expected: OAuth redirects to localhost:1455 which isn't running
    }
    const did = await s.getCookie("https://auth.openai.com", "oai-did");
    if (!did) return "[!] Error: failed to retrieve oai-did cookie";

    // 3. Sentinel + SignUp
    const signupResp = await s.post(
      "https://auth.openai.com/api/accounts/authorize/continue",
      {
        headers: {
          referer: "https://auth.openai.com/create-account",
          accept: "application/json",
          "content-type": "application/json",
          "openai-sentinel-token": await buildSentinel(s, did),
        },
        body: JSON.stringify({
          username: { value: email, kind: "email" },
          screen_hint: "signup",
        }),
      },
    );
    if (signupResp.status !== 200) {
      return `[!] SignUp failed: ${await signupResp.text()}`;
    }

    // 4. Set password + trigger registration OTP
    const openaiPwd = getPassword();
    const regResp = await s.post(
      "https://auth.openai.com/api/accounts/user/register",
      {
        headers: {
          referer: "https://auth.openai.com/create-account/password",
          accept: "application/json",
          "content-type": "application/json",
        },
        json: { password: openaiPwd, username: email },
      },
    );
    if (regResp.status !== 200) {
      return `[!] Password registration failed: ${await regResp.text()}`;
    }

    await s.get("https://auth.openai.com/create-account/password");
    const otpSend = await s.get(
      "https://auth.openai.com/api/accounts/email-otp/send",
      {
        headers: {
          referer: "https://auth.openai.com/create-account/password",
          accept: "application/json",
        },
      },
    );
    if (otpSend.status !== 200) {
      return `[!] Failed to send OTP: ${await otpSend.text()}`;
    }

    // 5. Wait for and verify registration OTP
    console.log("[*] Waiting for registration OTP email...");
    await Bun.sleep(1_000);
    const msg = await inbox.waitForMessage(300_000, otpFilter);
    const codeMatch = (msg.body || msg.htmlBody || msg.subject || "").match(
      /\b(\d{6})\b/,
    );
    if (!codeMatch?.[1]) {
      return "[!] Could not find a 6-digit verification code in the email";
    }
    const registrationOtp = codeMatch[1];

    const validateResp = await s.post(
      "https://auth.openai.com/api/accounts/email-otp/validate",
      {
        headers: {
          referer: "https://auth.openai.com/email-verification",
          accept: "application/json",
          "content-type": "application/json",
        },
        json: { code: registrationOtp },
      },
    );
    if (validateResp.status !== 200) {
      return `[!] OTP verification failed: ${await validateResp.text()}`;
    }
    console.log("[+] Registration OTP verified successfully");

    // 6. Create account (randomized name + birthdate, with Sentinel)
    const createAccountResp = await s.post(
      "https://auth.openai.com/api/accounts/create_account",
      {
        headers: {
          referer: "https://auth.openai.com/about-you",
          accept: "application/json",
          "content-type": "application/json",
          "openai-sentinel-token": await buildSentinel(s, did),
        },
        json: { name: randomName(), birthdate: randomBirthdate() },
      },
    );
    if (createAccountResp.status !== 200) {
      return `[!] Create account failed: ${await createAccountResp.text()}`;
    }
    console.log("[+] Account created successfully");

    // ===== 7. New login session to obtain tokens (bypasses add_phone) =====
    for (let loginAttempt = 0; loginAttempt < 3; loginAttempt++) {
      const s2 = await Session.create({ proxy: proxy || undefined });
      try {
        console.log(
          `[*] Obtaining tokens via login flow...${loginAttempt ? ` (retry ${loginAttempt}/3)` : ""}`,
        );
        const oauth2 = await generateOAuthUrl();
        try {
          await s2.get(oauth2.authUrl);
        } catch {
          // Expected: OAuth redirects to localhost:1455
        }
        const did2 = await s2.getCookie("https://auth.openai.com", "oai-did");
        if (!did2) return "[!] Login session failed to retrieve oai-did";

        // 7a. Login authorize/continue
        const loginResp = await s2.post(
          "https://auth.openai.com/api/accounts/authorize/continue",
          {
            headers: {
              referer: "https://auth.openai.com/log-in",
              accept: "application/json",
              "content-type": "application/json",
              "openai-sentinel-token": await buildSentinel(s2, did2),
            },
            body: JSON.stringify({
              username: { value: email, kind: "email" },
              screen_hint: "login",
            }),
          },
        );
        if (loginResp.status !== 200) {
          return `[!] Login failed: ${await loginResp.text()}`;
        }
        const loginData = (await safeJson(loginResp, "Login authorize")) as { continue_url?: string };
        if (loginData.continue_url) {
          await s2.get(loginData.continue_url);
        }

        // 7b. Password verification
        const pwResp = await s2.post(
          "https://auth.openai.com/api/accounts/password/verify",
          {
            headers: {
              referer: "https://auth.openai.com/log-in/password",
              accept: "application/json",
              "content-type": "application/json",
              "openai-sentinel-token": await buildSentinel(s2, did2),
            },
            json: { password: openaiPwd },
          },
        );
        if (pwResp.status !== 200) {
          return `[!] Password verification failed: ${await pwResp.text()}`;
        }

        // 7c. Trigger login OTP
        await s2.get("https://auth.openai.com/email-verification", {
          headers: { referer: "https://auth.openai.com/log-in/password" },
        });
        console.log("[*] Waiting for login OTP...");
        await Bun.sleep(2000);

        let loginOtp: string | null = null;
        for (let poll = 0; poll < 40; poll++) {
          try {
            const msgs = await inbox.getMessages();
            const allCodes: string[] = [];
            for (const msgData of msgs) {
              const m = new Message(msgData);
              const body = m.body || m.htmlBody || m.subject || "";
              const codes = body.match(/\b\d{6}\b/g);
              if (codes) {
                allCodes.push(codes[codes.length - 1]!);
              }
            }
            const newCodes = allCodes.filter((c) => c !== registrationOtp);
            if (newCodes.length > 0) {
              loginOtp = newCodes[newCodes.length - 1]!;
              break;
            }
          } catch {
            // Polling error, retry
          }
          await Bun.sleep(2000);
        }

        if (!loginOtp) {
          return "[!] Did not receive login OTP";
        }
        console.log(`[+] Extracted login OTP: ${loginOtp}`);

        const valResp = await s2.post(
          "https://auth.openai.com/api/accounts/email-otp/validate",
          {
            headers: {
              referer: "https://auth.openai.com/email-verification",
              accept: "application/json",
              "content-type": "application/json",
            },
            json: { code: loginOtp },
          },
        );
        if (valResp.status !== 200) {
          return `[!] Login OTP verification failed: ${await valResp.text()}`;
        }
        const valData = (await safeJson(valResp, "OTP validate")) as { continue_url?: string };
        console.log("[+] Login OTP verified successfully");

        // 8. Consent + Workspace
        const consentUrl = valData.continue_url ?? "";
        console.log(`[*] Consent URL: ${consentUrl.slice(0, 120)}`);
        if (consentUrl) {
          try {
            await s2.get(consentUrl);
          } catch {
            // Consent page may redirect to an unreachable URL; cookie is still set
          }
        }

        const authCookie = await s2.getCookie(
          "https://auth.openai.com",
          "oai-client-auth-session",
        );
        if (!authCookie) {
          return "[!] Failed to retrieve oai-client-auth-session after login";
        }
        let authJson: { workspaces?: { id: string }[] };
        try {
          const authPayload = Buffer.from(
            authCookie.split(".")[0]!,
            "base64",
          ).toString("utf-8");
          authJson = JSON.parse(authPayload);
        } catch {
          return `[!] Failed to parse auth cookie: ${authCookie.slice(0, 200)}`;
        }

        if (!authJson.workspaces?.length) {
          return `[!] No workspaces in cookie: ${JSON.stringify(authJson).slice(0, 500)}`;
        }
        const workspaceId = authJson.workspaces[0]!.id;
        console.log(`[+] Workspace ID: ${workspaceId}`);

        const selectResp = await s2.post(
          "https://auth.openai.com/api/accounts/workspace/select",
          {
            headers: {
              referer: consentUrl,
              accept: "application/json",
              "content-type": "application/json",
            },
            json: { workspace_id: workspaceId },
          },
        );
        let selData = (await safeJson(selectResp, "Workspace select")) as {
          continue_url?: string;
          page?: { type?: string; payload?: { data?: { orgs?: { id: string; default_project_id?: string }[] } } };
        };
        console.log(`[*] Workspace select response: ${JSON.stringify(selData).slice(0, 500)}`);

        // Handle organization selection if needed
        if (selData.page?.type === "organization_select") {
          const orgs = selData.page?.payload?.data?.orgs ?? [];
          if (orgs.length > 0) {
            const orgResp = await s2.post(
              "https://auth.openai.com/api/accounts/organization/select",
              {
                headers: {
                  accept: "application/json",
                  "content-type": "application/json",
                },
                json: {
                  org_id: orgs[0]!.id,
                  project_id: orgs[0]!.default_project_id ?? "",
                },
              },
            );
            selData = (await safeJson(orgResp, "Org select")) as typeof selData;
          }
        }

        if (!selData.continue_url) {
          return `[!] Failed to get continue_url: ${JSON.stringify(selData).slice(0, 500)}`;
        }

        // 9. Follow redirects to get Callback
        // Let Playwright follow the entire chain natively. The route handler
        // in followRedirectChain intercepts the final localhost request
        // before Chrome tries to connect (which would fail).
        console.log("[*] Following redirect chain to obtain callback URL...");
        const cbk = await s2.followRedirectChain(selData.continue_url);

        if (!cbk) {
          return "[!] Failed to retrieve callback URL";
        }
        console.log(`[+] Captured callback URL: ${cbk.slice(0, 80)}...`);

        // 10. Exchange Token
        console.log("[+] Flow complete; exchanging token...");
        const result = await submitCallbackUrl({
          callbackUrl: cbk,
          codeVerifier: oauth2.codeVerifier,
          redirectUri: oauth2.redirectUri,
          expectedState: oauth2.state,
        });
        return JSON.stringify(result.accountConfig, null, 2);
      } catch (e) {
        if (loginAttempt === 2) {
          return `[!] Login failed after 3 retries: ${e}`;
        }
        console.log(`[!] Login failed, retrying (${loginAttempt + 1}/3): ${e}`);
        await Bun.sleep(5000);
      } finally {
        await s2.close();
      }
    }

    return "[!] Login flow exhausted all retries";
  } finally {
    await s.close();
  }
}

// ====================== Main loop ======================

function getTokensUrl(): string {
  const url = (process.env.TOKENS_URL ?? "").trim();
  if (!url) throw new Error("TOKENS_URL environment variable is not set");
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw new Error("TOKENS_URL must start with http:// or https://");
  return url;
}

const TOKENS_URL = getTokensUrl();

console.log(
  "\n🚀 Starting automated registration for OpenAI Codex accounts...",
);
console.log("🛑 How to stop: Ctrl+C\n");

let successCount = 0;
for (;;) {
  try {
    const config = await run("");
    if (config?.startsWith("{")) {
      successCount++;
      console.log(`[+] Account #${successCount} registered successfully!`);
      try {
        const resp = await fetch(TOKENS_URL, {
          method: "POST",
          body: config,
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.status === 201) {
          console.log("[+] Account sent to server successfully!\n");
        } else {
          console.log(
            `[!] Failed to send account to server, status: ${resp.status}, response: ${await resp.text()}\n`,
          );
        }
      } catch (e) {
        console.log(`[!] Failed to send account to server: ${e}\n`);
      }
    } else {
      console.log(
        `[-] Registration failed: ${config}. Retrying in 3 seconds...`,
      );
      await Bun.sleep(3000);
    }
  } catch (e) {
    console.log(`[-] This attempt failed: ${e}. Retrying in 3 seconds...`);
    await Bun.sleep(3000);
  }
  await Bun.sleep(1000);
}
