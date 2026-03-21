import os
import json
import re
import time
import random
import string
import base64
import hashlib
import secrets
import urllib.parse
import urllib.request
import urllib.error
from typing import Any, Dict
from dataclasses import dataclass

from curl_cffi import requests


# ====================== 强密码生成 ======================
def get_password() -> str:
    chars = string.ascii_letters + string.digits
    base_pwd = "".join(random.choices(chars, k=10))
    return base_pwd + "Aa1@!"


# ====================== 【TempMail.lol 2026 完整版】邮箱模块（已修复代理） ======================
class Message:
    def __init__(self, data: dict):
        self.from_addr = data.get("from", "")
        self.subject = data.get("subject", "")
        self.body = data.get("body", "") or ""
        self.html_body = data.get("html", "") or ""


class EMail:
    def __init__(self, proxies: dict = None):
        self.s = requests.Session(
            proxies=proxies, impersonate="chrome"
        )  # ← 关键修复：走代理 + chrome指纹
        self.s.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
                "Accept": "application/json",
                "Content-Type": "application/json",
            }
        )
        # 创建随机邮箱（官方 2026 API）
        r = self.s.post("https://api.tempmail.lol/v2/inbox/create", json={})
        r.raise_for_status()
        data = r.json()
        self.address = data["address"]
        self.token = data["token"]
        # print(f"[+] 生成邮箱: {self.address} (TempMail.lol)")
        # print(f"[*] 自动轮询已启动（token 已保存）")

    def _get_messages(self):
        r = self.s.get(f"https://api.tempmail.lol/v2/inbox?token={self.token}")
        r.raise_for_status()
        return r.json().get("emails", [])

    def wait_for_message(self, timeout=600, filter_func=None):
        # print("[*] 等待 OpenAI 验证码（TempMail.lol 轮询，最多 10 分钟）")
        start = time.time()
        while time.time() - start < timeout:
            msgs = self._get_messages()
            # print(
                # f"[*] 已轮询 {int(time.time() - start)} 秒，收到 {len(msgs)} 封邮件..."
            # )
            for msg_data in msgs:
                msg = Message(msg_data)
                if not filter_func or filter_func(msg):
                    # print(f"[+] 收到匹配邮件: {msg.subject}")
                    return msg
            time.sleep(5)
        raise TimeoutError("[-] 10 分钟内未收到 OpenAI 验证码")


def get_email(proxies=None):
    inbox = EMail(proxies=proxies)
    return inbox.address, inbox


# ====================== OAuth 模块（完整保留） ======================
AUTH_URL = "https://auth.openai.com/oauth/authorize"
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
DEFAULT_REDIRECT_URI = f"http://localhost:1455/auth/callback"
DEFAULT_SCOPE = "openid email profile offline_access"


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _sha256_b64url_no_pad(s: str) -> str:
    return _b64url_no_pad(hashlib.sha256(s.encode("ascii")).digest())


def _random_state(nbytes: int = 16) -> str:
    return secrets.token_urlsafe(nbytes)


def _pkce_verifier() -> str:
    return secrets.token_urlsafe(64)


def _parse_callback_url(callback_url: str) -> Dict[str, str]:
    candidate = callback_url.strip()
    if not candidate:
        return {"code": "", "state": "", "error": "", "error_description": ""}
    if "://" not in candidate:
        if candidate.startswith("?"):
            candidate = f"http://localhost{candidate}"
        elif any(ch in candidate for ch in "/?#") or ":" in candidate:
            candidate = f"http://{candidate}"
        elif "=" in candidate:
            candidate = f"http://localhost/?{candidate}"
    parsed = urllib.parse.urlparse(candidate)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    fragment = urllib.parse.parse_qs(parsed.fragment, keep_blank_values=True)
    for key, values in fragment.items():
        if key not in query or not query[key] or not (query[key][0] or "").strip():
            query[key] = values

    def get1(k: str) -> str:
        v = query.get(k, [""])
        return (v[0] or "").strip()

    code = get1("code")
    state = get1("state")
    error = get1("error")
    error_description = get1("error_description")
    if code and not state and "#" in code:
        code, state = code.split("#", 1)
    if not error and error_description:
        error, error_description = error_description, ""
    return {
        "code": code,
        "state": state,
        "error": error,
        "error_description": error_description,
    }


def _jwt_claims_no_verify(id_token: str) -> Dict[str, Any]:
    if not id_token or id_token.count(".") < 2:
        return {}
    payload_b64 = id_token.split(".")[1]
    pad = "=" * ((4 - (len(payload_b64) % 4)) % 4)
    try:
        payload = base64.urlsafe_b64decode((payload_b64 + pad).encode("ascii"))
        return json.loads(payload.decode("utf-8"))
    except Exception:
        return {}


def _to_int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _post_form(url: str, data: Dict[str, str], timeout: int = 30) -> Dict[str, Any]:
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if resp.status != 200:
                raise RuntimeError(
                    f"Token 交换失败: {resp.status}: {raw.decode('utf-8', 'replace')}"
                )
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        raise RuntimeError(
            f"Token 交换失败: {exc.code}: {raw.decode('utf-8', 'replace')}"
        ) from exc


@dataclass(frozen=True)
class OAuthStart:
    auth_url: str
    state: str
    code_verifier: str
    redirect_uri: str


def generate_oauth_url(
    *, redirect_uri: str = DEFAULT_REDIRECT_URI, scope: str = DEFAULT_SCOPE
) -> OAuthStart:
    state = _random_state()
    code_verifier = _pkce_verifier()
    code_challenge = _sha256_b64url_no_pad(code_verifier)
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "prompt": "login",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
    }
    auth_url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
    return OAuthStart(
        auth_url=auth_url,
        state=state,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
    )


def submit_callback_url(
    *,
    callback_url: str,
    expected_state: str,
    code_verifier: str,
    redirect_uri: str = DEFAULT_REDIRECT_URI,
    session=None,
) -> str:
    cb = _parse_callback_url(callback_url)
    if cb["error"]:
        desc = cb["error_description"]
        raise RuntimeError(f"OAuth 错误: {cb['error']}: {desc}".strip())
    if not cb["code"]:
        raise ValueError("Callback URL 缺少 ?code=")
    if not cb["state"]:
        raise ValueError("Callback URL 缺少 ?state=")
    if cb["state"] != expected_state:
        raise ValueError("State 校验不匹配")
    token_data = {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": cb["code"],
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    if session is not None:
        r = session.post(
            TOKEN_URL,
            data=token_data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
        )
        if r.status_code != 200:
            raise RuntimeError(f"Token 交换失败: {r.status_code}: {r.text}")
        token_resp = r.json()
    else:
        token_resp = _post_form(TOKEN_URL, token_data)
    access_token = (token_resp.get("access_token") or "").strip()
    refresh_token = (token_resp.get("refresh_token") or "").strip()
    id_token = (token_resp.get("id_token") or "").strip()
    expires_in = _to_int(token_resp.get("expires_in"))
    claims = _jwt_claims_no_verify(id_token)
    email = str(claims.get("email") or "").strip()
    auth_claims = claims.get("https://api.openai.com/auth") or {}
    account_id = str(auth_claims.get("chatgpt_account_id") or "").strip()
    now = int(time.time())
    expired_rfc3339 = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + max(expires_in, 0))
    )
    now_rfc3339 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    config = {
        "id_token": id_token,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "account_id": account_id,
        "last_refresh": now_rfc3339,
        "email": email,
        "type": "codex",
        "expired": expired_rfc3339,
    }
    return json.dumps(config, ensure_ascii=False, indent=2)


def get_tokens_url() -> str:
    tokens_url = (os.getenv("TOKENS_URL") or "").strip()
    if not tokens_url:
        raise RuntimeError("TOKENS_URL environment variable is not set")
    if not tokens_url.startswith(("http://", "https://")):
        raise ValueError("TOKENS_URL must start with http:// or https://")
    return tokens_url


def _build_sentinel(s: requests.Session, did: str) -> str:
    """Request a sentinel token and return the serialized sentinel header value."""
    sen_resp = s.post(
        "https://sentinel.openai.com/backend-api/sentinel/req",
        headers={
            "origin": "https://sentinel.openai.com",
            "referer": "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6",
            "content-type": "text/plain;charset=UTF-8",
        },
        data=json.dumps({"p": "", "id": did, "flow": "authorize_continue"}),
    )
    if sen_resp.status_code != 200:
        raise RuntimeError(f"Sentinel 验证失败: {sen_resp.text}")
    sen_token = sen_resp.json().get("token", "")
    return json.dumps({"p": "", "t": "", "c": sen_token, "id": did, "flow": "authorize_continue"})


# ====================== 核心主逻辑（注册 + 登录换 Token） ======================
FIRST_NAMES = ["James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Sophia", "Mason", "Lucas", "Mia"]
LAST_NAMES = ["Smith", "Johnson", "Brown", "Davis", "Wilson", "Moore", "Taylor", "Clark", "Lee", "Hall"]


def run(proxy: str) -> str:
    proxies = {"http": proxy, "https": proxy} if proxy else None
    s = requests.Session(proxies=proxies, impersonate="chrome")

    # 1. 生成邮箱（TempMail.lol，走代理）
    # print("[*] 正在生成随机私有域名邮箱...")
    email, inbox = get_email(proxies=proxies)

    # 2. OAuth 初始化（注册用）
    # print("[*] 正在初始化 OAuth 流程...")
    oauth = generate_oauth_url()
    s.get(oauth.auth_url)
    did = s.cookies.get("oai-did")
    if not did:
        return "[!] 错误：未能获取 oai-did Cookie"

    # 3. Sentinel + SignUp
    signup_resp = s.post(
        "https://auth.openai.com/api/accounts/authorize/continue",
        headers={
            "referer": "https://auth.openai.com/create-account",
            "accept": "application/json",
            "content-type": "application/json",
            "openai-sentinel-token": _build_sentinel(s, did),
        },
        json={"username": {"value": email, "kind": "email"}, "screen_hint": "signup"},
    )
    if signup_resp.status_code != 200:
        return f"[!] SignUp 失败: {signup_resp.text}"

    # 4. 设置密码 + 触发注册 OTP
    openai_pwd = get_password()
    reg_resp = s.post(
        "https://auth.openai.com/api/accounts/user/register",
        headers={
            "referer": "https://auth.openai.com/create-account/password",
            "accept": "application/json",
            "content-type": "application/json",
        },
        json={"password": openai_pwd, "username": email},
    )
    if reg_resp.status_code != 200:
        return f"[!] 密码注册失败: {reg_resp.text}"

    s.get("https://auth.openai.com/create-account/password")
    otp_send = s.get(
        "https://auth.openai.com/api/accounts/email-otp/send",
        headers={
            "referer": "https://auth.openai.com/create-account/password",
            "accept": "application/json",
        },
    )
    if otp_send.status_code != 200:
        return f"[!] OTP 发送失败: {otp_send.text}"

    # 5. 等待并验证注册 OTP
    def otp_filter(obj):
        subj = getattr(obj, "subject", "") or ""
        return any(
            kw in subj.lower()
            for kw in ["openai", "验证码", "verification", "code", "otp"]
        )

    msg = inbox.wait_for_message(timeout=300, filter_func=otp_filter)
    code_match = re.search(
        r"\b(\d{6})\b", msg.body or msg.html_body or msg.subject or ""
    )
    if not code_match:
        return "[!] 未在邮件中找到 6 位验证码"
    registration_otp = code_match.group(1)

    validate_resp = s.post(
        "https://auth.openai.com/api/accounts/email-otp/validate",
        headers={
            "referer": "https://auth.openai.com/email-verification",
            "accept": "application/json",
            "content-type": "application/json",
        },
        json={"code": registration_otp},
    )
    if validate_resp.status_code != 200:
        return f"[!] OTP 验证失败: {validate_resp.text}"
    print("[+] 注册 OTP 验证成功")

    # 6. 创建账号信息（带 Sentinel token，随机姓名和生日）
    rand_name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
    rand_birthdate = f"{random.randint(1985, 2003)}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}"
    create_account_resp = s.post(
        "https://auth.openai.com/api/accounts/create_account",
        headers={
            "referer": "https://auth.openai.com/about-you",
            "accept": "application/json",
            "content-type": "application/json",
            "openai-sentinel-token": _build_sentinel(s, did),
        },
        json={"name": rand_name, "birthdate": rand_birthdate},
    )
    if create_account_resp.status_code != 200:
        return f"[!] 创建账号失败: {create_account_resp.text}"
    print("[+] 账号创建成功")

    # ===== 7. 新建登录会话获取 Token（绕过 add_phone） =====
    for login_attempt in range(3):
      try:
        print(f"[*] 正在通过登录流程获取 Token...{f' (重试 {login_attempt}/3)' if login_attempt else ''}")
        s2 = requests.Session(proxies=proxies, impersonate="chrome")
        oauth2 = generate_oauth_url()
        s2.get(oauth2.auth_url)
        did2 = s2.cookies.get("oai-did")
        if not did2:
            return "[!] 登录会话未能获取 oai-did"

        # 7a. 登录 authorize/continue
        login_resp = s2.post(
            "https://auth.openai.com/api/accounts/authorize/continue",
            headers={
                "referer": "https://auth.openai.com/log-in",
                "accept": "application/json",
                "content-type": "application/json",
                "openai-sentinel-token": _build_sentinel(s2, did2),
            },
            data=json.dumps({"username": {"value": email, "kind": "email"}, "screen_hint": "login"}),
        )
        if login_resp.status_code != 200:
            return f"[!] 登录失败: {login_resp.text}"
        s2.get(login_resp.json().get("continue_url", ""))

        # 7b. 密码验证
        pw_resp = s2.post(
            "https://auth.openai.com/api/accounts/password/verify",
            headers={
                "referer": "https://auth.openai.com/log-in/password",
                "accept": "application/json",
                "content-type": "application/json",
                "openai-sentinel-token": _build_sentinel(s2, did2),
            },
            json={"password": openai_pwd},
        )
        if pw_resp.status_code != 200:
            return f"[!] 密码验证失败: {pw_resp.text}"

        # 7c. 触发登录 OTP
        s2.get(
            "https://auth.openai.com/email-verification",
            headers={"referer": "https://auth.openai.com/log-in/password"},
        )
        # print("[*] 正在等待登录 OTP...")
        time.sleep(2)

        login_otp = None
        for _ in range(40):
            try:
                msgs = inbox._get_messages()
            except Exception:
                time.sleep(2)
                continue
            all_codes = []
            for msg_data in msgs:
                m = Message(msg_data)
                body = m.body or m.html_body or m.subject or ""
                codes = re.findall(r"\b(\d{6})\b", body)
                if codes:
                    all_codes.append(codes[-1])
            new_codes = [c for c in all_codes if c != registration_otp]
            if new_codes:
                login_otp = new_codes[-1]
                break
            time.sleep(2)

        if not login_otp:
            return "[!] 未收到登录 OTP"
        # print(f"[+] 提取到登录 OTP: {login_otp}")

        val_resp = s2.post(
            "https://auth.openai.com/api/accounts/email-otp/validate",
            headers={
                "referer": "https://auth.openai.com/email-verification",
                "accept": "application/json",
                "content-type": "application/json",
            },
            json={"code": login_otp},
        )
        if val_resp.status_code != 200:
            return f"[!] 登录 OTP 验证失败: {val_resp.text}"
        val_data = val_resp.json()
        print("[+] 登录 OTP 验证成功")

        # 8. Consent + Workspace
        consent_url = val_data.get("continue_url", "")
        s2.get(consent_url)

        auth_cookie = s2.cookies.get("oai-client-auth-session", domain=".auth.openai.com")
        if not auth_cookie:
            return "[!] 登录后未能获取 oai-client-auth-session"
        try:
            auth_json = json.loads(base64.b64decode(auth_cookie.split(".")[0]))
        except Exception:
            return f"[!] 无法解析 auth cookie: {auth_cookie[:200]}"

        workspaces = auth_json.get("workspaces", [])
        if not workspaces:
            return f"[!] Cookie 中无 workspaces: {json.dumps(auth_json)[:500]}"
        workspace_id = workspaces[0]["id"]

        select_resp = s2.post(
            "https://auth.openai.com/api/accounts/workspace/select",
            headers={
                "referer": consent_url,
                "accept": "application/json",
                "content-type": "application/json",
            },
            json={"workspace_id": workspace_id},
        )
        sel_data = select_resp.json()

        # 处理 organization 选择（如需要）
        if sel_data.get("page", {}).get("type", "") == "organization_select":
            orgs = sel_data.get("page", {}).get("payload", {}).get("data", {}).get("orgs", [])
            if orgs:
                org_sel = s2.post(
                    "https://auth.openai.com/api/accounts/organization/select",
                    headers={
                        "accept": "application/json",
                        "content-type": "application/json",
                    },
                    json={
                        "org_id": orgs[0].get("id", ""),
                        "project_id": orgs[0].get("default_project_id", ""),
                    },
                )
                sel_data = org_sel.json()

        if "continue_url" not in sel_data:
            return f"[!] 未能获取 continue_url: {json.dumps(sel_data, ensure_ascii=False)[:500]}"

        # 9. 跟踪重定向获取 Callback
        r = s2.get(sel_data["continue_url"], allow_redirects=False)
        cbk = None
        for _ in range(20):
            loc = r.headers.get("Location", "")
            if loc.startswith("http://localhost"):
                cbk = loc
                break
            if r.status_code not in (301, 302, 303) or not loc:
                break
            r = s2.get(loc, allow_redirects=False)

        if not cbk:
            return "[!] 未能获取到 Callback URL"

        # 10. 交换 Token
        return submit_callback_url(
            callback_url=cbk,
            code_verifier=oauth2.code_verifier,
            redirect_uri=oauth2.redirect_uri,
            expected_state=oauth2.state,
            session=s2,
        )

      except Exception as e:
        if login_attempt == 2:
            return f"[!] 登录重试 3 次均失败: {e}"
        print(f"[!] 登录失败，重试 ({login_attempt + 1}/3): {e}")
        time.sleep(2)


# ====================== 无限循环 ======================
if __name__ == "__main__":
    PROXY_URL = "http://127.0.0.1:7897"  # ← 改成你的 US/JP 住宅代理
    TOKENS_URL = get_tokens_url()  # 从环境变量获取服务器 URL

    print(
        "\n🚀 开始自动化无限循环注册 OpenAI Codex 账号（2026 TempMail.lol 修复代理终极版）..."
    )
    print("🛑 停止方法: Ctrl+C\n")

    success_count = 0
    while True:
        try:
            config = run("")
            if config and config.startswith("{"):
                success_count += 1
                print(f"[+] 第 {success_count} 个账号注册成功！")
                config_text = json.dumps(
                    json.loads(config), ensure_ascii=False, indent=2
                )
                req = requests.post(
                    TOKENS_URL,
                    data=config_text,
                    headers={"content-type": "application/json"},
                    timeout=10,
                )
                if req.status_code == 201:
                    print("[+] 已成功发送账号信息到服务器！\n")
                else:
                    print(
                        f"[!] 发送账号信息失败，状态码: {req.status_code}, 响应: {req.text}\n"
                    )
            else:
                print(f"[-] 注册流程返回异常结果: {config}\n")
        except Exception as e:
            print(f"[-] 本次失败: {e}，3秒后重试...")
            time.sleep(3)
        time.sleep(1)
