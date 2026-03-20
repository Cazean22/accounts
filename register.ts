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
      console.log(`[*] 当前节点信息 -> Location: ${loc}, IP: ${ip}`);
      if (["CN", "HK", "RU"].includes(loc)) {
        throw new Error("当前 IP 位于受限地区，请切换代理节点。");
      }
    } catch (e) {
      console.log(`[!] IP 检测失败: ${e}`);
    }

    // 2. Generate email (TempMail.lol, via proxy)
    console.log("[*] 正在生成随机私有域名邮箱...");
    const inbox = await EMail.create(proxy || undefined);
    const email = inbox.address;
    console.log(`[+] 成功生成邮箱: ${email}`);

    // 3. OAuth init
    console.log("[*] 正在初始化 OAuth 流程...");
    const oauth = await generateOAuthUrl();
    try {
      await s.get(oauth.authUrl);
    } catch {
      // Expected: OAuth redirects to localhost:1455 which isn't running
    }
    const did = await s.getCookie("https://auth.openai.com", "oai-did");
    if (!did) return "[!] 错误：未能获取 oai-did Cookie";
    console.log(`[+] 获取到 oai-did: ${did}`);

    // 4. Sentinel
    console.log("[*] 正在绕过 Sentinel 验证...");
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
    console.log(`[*] Sentinel 状态码: ${senResp.status}`);
    if (senResp.status !== 200) {
      return `[!] Sentinel 验证失败。\n响应内容: ${await senResp.text()}`;
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
    console.log("[*] 正在提交注册...");
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
    console.log(`[*] SignUp 状态码: ${signupResp.status}`);
    if (signupResp.status !== 200) {
      return `[!] SignUp 失败详细信息: ${await signupResp.text()}`;
    }

    // 6. Set password + trigger OTP
    console.log("[*] Passwordless 已禁用，正在设置密码 + 触发 OTP...");
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
    console.log(`[*] 密码注册状态码: ${regResp.status}`);
    if (regResp.status !== 200) {
      return `[!] 密码注册失败: ${await regResp.text()}`;
    }
    console.log(`[+] 密码设置成功（${openaiPwd}）`);

    await Bun.sleep(1000);
    await s.get("https://auth.openai.com/create-account/password", {
      headers: { referer: "https://auth.openai.com/create-account" },
    });

    console.log("[*] 发送 OTP 验证码...");
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
      `[*] OTP 发送状态码: ${otpSend.status} | 响应: ${otpSendText.slice(0, 300)}`,
    );
    if (otpSend.status !== 200) {
      return `[!] OTP 发送失败: ${otpSendText}`;
    }

    // Wait for OTP
    console.log("[*] 正在等待邮箱 OTP 验证码...");
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
    if (!codeMatch?.[1]) return "[!] 未在邮件中找到 6 位验证码";
    const otpCode = codeMatch[1];
    console.log(`[+] 提取到 OTP: ${otpCode}`);

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
    console.log(`[*] OTP 验证状态码: ${validateResp.status}`);
    if (validateResp.status !== 200) {
      return `[!] OTP 验证失败: ${await validateResp.text()}`;
    }
    console.log("[+] OTP 验证成功，继续创建账号信息...");

    // 7. Create account info
    console.log("[*] 正在创建账号信息...");
    const createAccountResp = await s.post(
      "https://auth.openai.com/api/accounts/create_account",
      {
        headers: {
          referer: "https://auth.openai.com/about-you",
          accept: "application/json",
          "content-type": "application/json",
        },
        json: { name: "gali", birthdate: "2000-02-20" },
      },
    );
    console.log(`[*] 账号创建状态码: ${createAccountResp.status}`);
    if (createAccountResp.status !== 200) {
      return `[!] 创建账号步骤失败: ${await createAccountResp.text()}`;
    }

    // 8. Get Workspace ID
    const authCookie = await s.getCookie(
      "https://auth.openai.com",
      "oai-client-auth-session",
    );
    if (!authCookie) return "[!] 错误：未能获取到 oai-client-auth-session";
    const authData = JSON.parse(
      Buffer.from(authCookie.split(".")[0]!, "base64").toString("utf-8"),
    ) as { workspaces: { id: string }[] };
    const workspaceId = authData.workspaces[0]!.id;
    console.log(`[+] 提取 Workspace ID: ${workspaceId}`);

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
    console.log(`[*] 选择 Workspace 状态码: ${selectResp.status}`);
    const selectData = (await selectResp.json()) as { continue_url?: string };
    if (!selectData.continue_url) {
      return `[!] 未能获取 continue_url，响应: ${JSON.stringify(selectData)}`;
    }

    // 10. Follow redirects to get Callback
    console.log("[*] 正在跟踪重定向获取 Token...");
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
    if (!cbk) return "[!] 错误：未能获取到最终的 Callback URL";

    // 11. Exchange Token
    console.log("[+] 流程完成，正在交换 Token...");
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

const PROXY_URL = "http://127.0.0.1:7890"; // ← 改成你的 US/JP 住宅代理
const OUTPUT_FILE = "accounts.json";

console.log(
  "\n🚀 开始自动化无限循环注册 OpenAI Codex 账号（2026 TempMail.lol 修复代理终极版）...",
);
console.log("🛑 停止方法: Ctrl+C\n");

let successCount = 0;
for (;;) {
  try {
    const config = await run("");
    if (config?.startsWith("{")) {
      successCount++;
      console.log(`[+] 第 ${successCount} 个账号注册成功！`);
      await appendFile(OUTPUT_FILE, config + "\n", "utf-8");
    }
  } catch (e) {
    console.log(`[-] 本次失败: ${e}，3秒后重试...`);
    await Bun.sleep(3000);
  }
  await Bun.sleep(1000);
}
