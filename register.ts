import { appendFile } from "node:fs/promises";

import { Session } from "./session.ts";
import { EMail, type Message } from "./tempmail.ts";
import { generateOAuthUrl, submitCallbackUrl } from "./oauth.ts";

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

// ====================== Core logic (steps 1–11) ======================

async function run(proxy: string): Promise<string> {
  const s = await Session.create({ proxy: proxy || undefined });

  try {
    // 1. IP check
    try {
      const trace = await s.get("https://cloudflare.com/cdn-cgi/trace", {
        timeout: 10_000,
      });
      const traceText = await trace.text();
      const ipMatch = traceText.match(/^ip=(.+)$/m);
      const locMatch = traceText.match(/^loc=(.+)$/m);
      const ip = ipMatch?.[1] ?? "Unknown";
      const loc = locMatch?.[1] ?? "Unknown";
      console.log(`[*] Current node info -> Location: ${loc}, IP: ${ip}`);
      if (["CN", "HK", "RU"].includes(loc)) {
        throw new Error("The current IP is in a restricted region. Please switch proxy nodes.");
      }
    } catch (e) {
      console.log(`[!] IP check failed: ${e}`);
    }

    // 2. Generate email (TempMail.lol, via proxy)
    console.log("[*] Generating a random private-domain email address...");
    const inbox = await EMail.create(proxy || undefined);
    const email = inbox.address;
    console.log(`[+] Email generated successfully: ${email}`);

    // 3. OAuth init
    console.log("[*] Initializing OAuth flow...");
    const oauth = await generateOAuthUrl();
    try {
      await s.get(oauth.authUrl);
    } catch {
      // Expected: OAuth redirects to localhost:1455 which isn't running
    }
    const did = await s.getCookie("https://auth.openai.com", "oai-did");
    if (!did) return "[!] Error: failed to retrieve oai-did cookie";
    console.log(`[+] Retrieved oai-did: ${did}`);

    // 4. Sentinel
    console.log("[*] Handling Sentinel verification...");
    const signupBody = JSON.stringify({
      username: { value: email, kind: "email" },
      screen_hint: "signup",
    });
    const senReqBody = JSON.stringify({
      p: "",
      id: did,
      flow: "authorize_continue",
    });
    const senResp = await s.post(
      "https://sentinel.openai.com/backend-api/sentinel/req",
      {
        headers: {
          origin: "https://sentinel.openai.com",
          referer:
            "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6",
          "content-type": "text/plain;charset=UTF-8",
        },
        body: senReqBody,
      },
    );
    console.log(`[*] Sentinel status code: ${senResp.status}`);
    if (senResp.status !== 200) {
      return `[!] Sentinel verification failed.\nResponse: ${await senResp.text()}`;
    }
    const senData = (await senResp.json()) as { token?: string };
    const senToken = senData.token ?? "";
    const sentinel = JSON.stringify({
      p: "",
      t: "",
      c: senToken,
      id: did,
      flow: "authorize_continue",
    });

    // 5. SignUp
    console.log("[*] Submitting signup request...");
    const signupResp = await s.post(
      "https://auth.openai.com/api/accounts/authorize/continue",
      {
        headers: {
          referer: "https://auth.openai.com/create-account",
          accept: "application/json",
          "content-type": "application/json",
          "openai-sentinel-token": sentinel,
        },
        body: signupBody,
      },
    );
    console.log(`[*] SignUp status code: ${signupResp.status}`);
    if (signupResp.status !== 200) {
      return `[!] SignUp failed. Details: ${await signupResp.text()}`;
    }

    // 6. Set password + trigger OTP
    console.log("[*] Passwordless is disabled; setting password and triggering OTP...");
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
    console.log(`[*] Password registration status code: ${regResp.status}`);
    if (regResp.status !== 200) {
      return `[!] Password registration failed: ${await regResp.text()}`;
    }
    console.log(`[+] Password set successfully (${openaiPwd})`);

    await Bun.sleep(1000);
    await s.get("https://auth.openai.com/create-account/password", {
      headers: { referer: "https://auth.openai.com/create-account" },
    });

    console.log("[*] Sending OTP verification code...");
    const otpSend = await s.get(
      "https://auth.openai.com/api/accounts/email-otp/send",
      {
        headers: {
          referer: "https://auth.openai.com/create-account/password",
          accept: "application/json",
        },
      },
    );
    const otpSendText = await otpSend.text();
    console.log(
      `[*] OTP send status code: ${otpSend.status} | Response: ${otpSendText.slice(0, 300)}`,
    );
    if (otpSend.status !== 200) {
      return `[!] Failed to send OTP: ${otpSendText}`;
    }

    // Wait for OTP
    console.log("[*] Waiting for OTP email...");
    const otpFilter = (msg: Message) => {
      const subj = (msg.subject ?? "").toLowerCase();
      return ["openai", "验证码", "verification", "code", "otp"].some((kw) =>
        subj.includes(kw),
      );
    };
    const msg = await inbox.waitForMessage(300_000, otpFilter);
    const codeMatch = (msg.body || msg.htmlBody || msg.subject || "").match(
      /\b(\d{6})\b/,
    );
    if (!codeMatch?.[1]) {
      return "[!] Could not find a 6-digit verification code in the email";
    }
    const otpCode = codeMatch[1];
    console.log(`[+] Extracted OTP: ${otpCode}`);

    // Validate OTP
    const validateResp = await s.post(
      "https://auth.openai.com/api/accounts/email-otp/validate",
      {
        headers: {
          referer: "https://auth.openai.com/email-verification",
          accept: "application/json",
          "content-type": "application/json",
        },
        json: { code: otpCode },
      },
    );
    console.log(`[*] OTP verification status code: ${validateResp.status}`);
    if (validateResp.status !== 200) {
      return `[!] OTP verification failed: ${await validateResp.text()}`;
    }
    console.log("[+] OTP verified successfully; continuing to create account profile...");

    // 7. Create account info
    console.log("[*] Requesting new Sentinel token for account creation...");
    const createSenReqBody = JSON.stringify({
      p: "",
      id: did,
      flow: "authorize_continue",
    });
    const createSenResp = await s.post(
      "https://sentinel.openai.com/backend-api/sentinel/req",
      {
        headers: {
          origin: "https://sentinel.openai.com",
          referer:
            "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6",
          "content-type": "text/plain;charset=UTF-8",
        },
        body: createSenReqBody,
      },
    );
    if (createSenResp.status !== 200) {
      return `[!] Sentinel for create_account failed: ${await createSenResp.text()}`;
    }
    const createSenData = (await createSenResp.json()) as { token?: string };
    const createSenToken = createSenData.token ?? "";
    const createSentinel = JSON.stringify({
      p: "",
      t: "",
      c: createSenToken,
      id: did,
      flow: "authorize_continue",
    });
    console.log("[+] Sentinel token obtained for create_account");

    console.log("[*] Creating account profile...");
    const createAccountResp = await s.post(
      "https://auth.openai.com/api/accounts/create_account",
      {
        headers: {
          referer: "https://auth.openai.com/about-you",
          accept: "application/json",
          "content-type": "application/json",
          "openai-sentinel-token": createSentinel,
        },
        json: { name: "gali", birthdate: "2000-02-20" },
      },
    );
    const createAccountData = await createAccountResp.json();
    console.log(`[*] Account creation status code: ${createAccountResp.status}`);
    console.log(`[*] Account creation response: ${JSON.stringify(createAccountData).slice(0, 500)}`);
    if (createAccountResp.status !== 200) {
      return `[!] Create-account step failed: ${JSON.stringify(createAccountData)}`;
    }
    console.log("[+] Account profile created successfully!");

    // 8. Check if phone verification was bypassed
    const createData = createAccountData as { continue_url?: string; page?: { type?: string } };
    if (createData.page?.type === "add_phone") {
      console.log("[!] Phone verification still required despite sentinel token");
      return `[!] Phone verification required. Response: ${JSON.stringify(createAccountData).slice(0, 500)}`;
    } else if (createData.continue_url) {
      console.log(`[*] Following continue_url: ${createData.continue_url}`);
      await s.get(createData.continue_url, { followRedirects: true });
    }

    // 9. Get Workspace ID
    const authCookie = await s.getCookie(
      "https://auth.openai.com",
      "oai-client-auth-session",
    );
    if (!authCookie) {
      return "[!] Error: failed to retrieve oai-client-auth-session";
    }
    const authPayload = Buffer.from(authCookie.split(".")[0]!, "base64").toString("utf-8");
    let authData: { workspaces?: { id: string }[] };
    try {
      authData = JSON.parse(authPayload);
    } catch {
      return `[!] Failed to parse auth cookie payload: ${authPayload.slice(0, 500)}`;
    }
    if (!authData.workspaces?.length) {
      console.log(`[!] Warning: no workspaces found in auth cookie. Full parsed data: ${JSON.stringify(authData).slice(0, 500)}`);
      return `[!] No workspaces found in auth cookie. Parsed data: ${JSON.stringify(authData).slice(0, 500)}`;
    }
    console.log(`[+] Parsed auth cookie successfully; found ${authData.workspaces.length} workspace(s)`);
    const workspaceId = authData.workspaces[0]!.id;
    console.log(`[+] Extracted Workspace ID: ${workspaceId}`);

    // 9. Select Workspace
    const selectResp = await s.post(
      "https://auth.openai.com/api/accounts/workspace/select",
      {
        headers: {
          referer:
            "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
          "content-type": "application/json",
        },
        json: { workspace_id: workspaceId },
      },
    );
    console.log(`[*] Workspace selection status code: ${selectResp.status}`);
    const selectData = (await selectResp.json()) as { continue_url?: string };
    if (!selectData.continue_url) {
      return `[!] Failed to retrieve continue_url. Response: ${JSON.stringify(selectData)}`;
    }

    // 10. Follow redirects to get Callback
    console.log("[*] Following redirects to obtain token...");
    let resp = await s.get(selectData.continue_url, {
      followRedirects: false,
    });
    resp = await s.get(resp.headers.get("location")!, {
      followRedirects: false,
    });
    resp = await s.get(resp.headers.get("location")!, {
      followRedirects: false,
    });
    const cbk = resp.headers.get("location");
    if (!cbk) return "[!] Error: failed to retrieve the final callback URL";

    // 11. Exchange Token
    console.log("[+] Flow complete; exchanging token...");
    const result = await submitCallbackUrl({
      callbackUrl: cbk,
      codeVerifier: oauth.codeVerifier,
      redirectUri: oauth.redirectUri,
      expectedState: oauth.state,
    });
    return JSON.stringify(result.accountConfig, null, 2);
  } finally {
    await s.close();
  }
}

// ====================== Main loop ======================

const PROXY_URL = "http://127.0.0.1:7890";
const OUTPUT_FILE = "accounts.json";

console.log(
  "\n🚀 Starting automated endless-loop registration for OpenAI Codex accounts (2026 TempMail.lol proxy-fix final version)...",
);
console.log("🛑 How to stop: Ctrl+C\n");

let successCount = 0;
for (;;) {
  try {
    const config = await run("");
    if (config?.startsWith("{")) {
      successCount++;
      console.log(`[+] Account #${successCount} registered successfully!`);
      await appendFile(OUTPUT_FILE, config + "\n", "utf-8");
    } else {
      console.log(`[-] Registration attempt failed with message: ${config}. Retrying in 3 seconds...`);
      await Bun.sleep(3000);
    }
  } catch (e) {
    console.log(`[-] This attempt failed: ${e}. Retrying in 3 seconds...`);
    await Bun.sleep(3000);
  }
  await Bun.sleep(1000);
}
