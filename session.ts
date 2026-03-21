export interface SessionOptions {
  proxy?: string;
  headless?: boolean;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/**
 * HTTP session using native fetch with a simple cookie jar.
 */
export class Session {
  /** domain -> (name -> value) */
  private cookies = new Map<string, Map<string, string>>();
  private proxy?: string;

  private constructor() {}

  static async create(opts: SessionOptions = {}): Promise<Session> {
    const s = new Session();
    s.proxy = opts.proxy;
    return s;
  }

  async close(): Promise<void> {}

  async getCookie(url: string, name: string): Promise<string | undefined> {
    const domain = new URL(url).hostname;
    return this.cookies.get(domain)?.get(name);
  }

  private getCookieHeader(url: string): string {
    const domain = new URL(url).hostname;
    const jar = this.cookies.get(domain);
    if (!jar || jar.size === 0) return "";
    return Array.from(jar.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }

  private storeCookies(url: string, response: Response): void {
    const domain = new URL(url).hostname;
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const nameValue = sc.split(";")[0] ?? "";
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0) {
        let jar = this.cookies.get(domain);
        if (!jar) {
          jar = new Map();
          this.cookies.set(domain, jar);
        }
        jar.set(
          nameValue.slice(0, eqIdx).trim(),
          nameValue.slice(eqIdx + 1).trim(),
        );
      }
    }
  }

  private getAllCookiesFlat(): Map<string, string> {
    const flat = new Map<string, string>();
    for (const jar of this.cookies.values()) {
      for (const [n, v] of jar) {
        flat.set(n, v);
      }
    }
    return flat;
  }

  async followRedirectChain(startUrl: string): Promise<string | null> {
    const cookieMap = this.getAllCookiesFlat();

    let currentUrl = startUrl;
    for (let i = 0; i < 20; i++) {
      const cookieHeader = Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      const resp = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Cookie: cookieHeader,
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      // Update cookies from Set-Cookie headers
      const setCookies = resp.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const nameValue = sc.split(";")[0] ?? "";
        const eqIdx = nameValue.indexOf("=");
        if (eqIdx > 0) {
          cookieMap.set(
            nameValue.slice(0, eqIdx).trim(),
            nameValue.slice(eqIdx + 1).trim(),
          );
        }
      }

      const location = resp.headers.get("location");
      if (!location) return null;

      const resolved = new URL(location, currentUrl).href;
      if (resolved.startsWith("http://localhost")) return resolved;

      currentUrl = resolved;
    }

    return null;
  }

  async get(
    url: string,
    opts?: {
      headers?: Record<string, string>;
      followRedirects?: boolean;
      timeout?: number;
    },
  ): Promise<SimpleResponse> {
    return this.request(url, {
      method: "GET",
      headers: opts?.headers,
      followRedirects: opts?.followRedirects,
      timeout: opts?.timeout,
    });
  }

  async post(
    url: string,
    opts?: {
      headers?: Record<string, string>;
      body?: string;
      json?: unknown;
      followRedirects?: boolean;
      timeout?: number;
    },
  ): Promise<SimpleResponse> {
    const headers = { ...opts?.headers };
    let body: string | undefined = opts?.body;
    if (opts?.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    return this.request(url, {
      method: "POST",
      headers,
      body,
      followRedirects: opts?.followRedirects,
      timeout: opts?.timeout,
    });
  }

  private async request(
    url: string,
    opts: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      followRedirects?: boolean;
      timeout?: number;
    },
  ): Promise<SimpleResponse> {
    const follow = opts.followRedirects ?? true;
    const timeout = opts.timeout ?? 30_000;

    let currentUrl = url;
    for (let i = 0; i < (follow ? 20 : 1); i++) {
      const cookieHeader = this.getCookieHeader(currentUrl);
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...opts.headers,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(currentUrl, {
        method: i === 0 ? opts.method : "GET",
        headers,
        body: i === 0 ? opts.body : undefined,
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timer);
      this.storeCookies(currentUrl, resp);

      const status = resp.status;
      if (follow && status >= 300 && status < 400) {
        const location = resp.headers.get("location");
        if (location) {
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
      }

      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });

      return new SimpleResponse(
        {
          status,
          headers: respHeaders,
          body: await resp.text().catch(() => ""),
        },
        currentUrl,
      );
    }

    throw new Error("Too many redirects");
  }
}

export class SimpleResponse {
  private data: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  private requestUrl: string;

  constructor(
    data: { status: number; headers: Record<string, string>; body: string },
    requestUrl: string,
  ) {
    this.data = data;
    this.requestUrl = requestUrl;
  }

  get status(): number {
    return this.data.status;
  }

  get ok(): boolean {
    return this.data.status >= 200 && this.data.status < 300;
  }

  get headers(): { get(name: string): string | null } {
    const h = this.data.headers;
    const reqUrl = this.requestUrl;
    return {
      get(name: string) {
        const val = h[name.toLowerCase()] ?? null;
        if (name.toLowerCase() === "location" && val && !val.includes("://")) {
          return new URL(val, reqUrl).href;
        }
        return val;
      },
    };
  }

  async text(): Promise<string> {
    return this.data.body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.data.body);
  }
}
