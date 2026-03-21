import {
  chromium,
  type BrowserContext,
  type Browser,
  type Page,
  type Response as PWResponse,
  type Route,
} from "playwright";

export interface SessionOptions {
  proxy?: string;
  headless?: boolean;
}

/**
 * HTTP session backed by a real Chromium browser via Playwright.
 *
 * All requests go through Chrome's network stack (page.goto + route.continue),
 * giving us real TLS fingerprints and cookie management. We avoid Playwright's
 * context.request.fetch() entirely because it crashes on servers that return
 * redirects with relative URLs.
 */
export class Session {
  private context!: BrowserContext;
  private browser!: Browser;
  private page!: Page;

  private constructor() {}

  static async create(opts: SessionOptions = {}): Promise<Session> {
    const s = new Session();
    s.browser = await chromium.launch({
      headless: opts.headless ?? true,
      ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}),
    });
    s.context = await s.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    });
    s.page = await s.context.newPage();
    return s;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  getCookie(url: string, name: string): Promise<string | undefined> {
    return this.context.cookies(url).then((cookies) =>
      cookies.find((c) => c.name === name)?.value,
    );
  }

  /**
   * Follow a URL through its redirect chain and capture the final
   * redirect to localhost. Uses native fetch (not the browser page)
   * to avoid Cloudflare bot detection. Cookies are extracted from the
   * browser context and updated from Set-Cookie headers on each hop.
   *
   * We cannot use context.request because it crashes on servers that
   * return relative URLs in Set-Cookie/Location headers.
   */
  async followRedirectChain(
    startUrl: string,
  ): Promise<string | null> {
    // Extract ALL cookies from the browser context
    const allCookies = await this.context.cookies();
    const cookieMap = new Map<string, string>();
    for (const c of allCookies) {
      cookieMap.set(c.name, c.value);
    }

    let currentUrl = startUrl;
    for (let i = 0; i < 20; i++) {
      const cookieHeader = Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      const resp = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Cookie: cookieHeader,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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
      if (!location) {
        return null;
      }

      const resolved = new URL(location, currentUrl).href;
      if (resolved.startsWith("http://localhost")) {
        return resolved;
      }

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

    // Intercept the outgoing request to modify method/headers/body.
    // route.continue() sends the modified request through Chrome's real
    // network stack (proper TLS, cookie jar, redirect handling).
    const needsIntercept =
      opts.method !== "GET" || opts.headers || opts.body;

    let routeHandler: ((route: Route) => Promise<void>) | undefined;

    if (needsIntercept) {
      routeHandler = async (route: Route) => {
        await route.continue({
          method: opts.method,
          headers: opts.headers
            ? { ...route.request().headers(), ...opts.headers }
            : undefined,
          postData: opts.body,
        });
      };
      await this.page.route("**/*", routeHandler, { times: 1 });
    }

    try {
      if (!follow) {
        // Capture the FIRST response (the redirect) without waiting for
        // Chrome to finish following the entire redirect chain.
        return await this.requestNoFollow(url, timeout);
      }

      // Let Chrome follow all redirects; return the final response.
      const response = await this.page.goto(url, {
        waitUntil: "commit",
        timeout,
      });

      if (!response) throw new Error("No response received");

      return new SimpleResponse(
        {
          status: response.status(),
          headers: response.headers(),
          body: await response.text().catch(() => ""),
        },
        url,
      );
    } catch (e) {
      // page.goto can fail if redirect chain ends at an unreachable URL
      // (e.g. localhost when no server is running). Re-throw as-is.
      throw e;
    } finally {
      if (routeHandler) {
        await this.page.unroute("**/*", routeHandler).catch(() => {});
      }
    }
  }

  /**
   * Make a request and capture the immediate response (even if it's a 3xx).
   * Chrome will still try to follow the redirect in the background but we
   * don't wait for that.
   */
  private requestNoFollow(
    url: string,
    timeout: number,
  ): Promise<SimpleResponse> {
    return new Promise<SimpleResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.page.off("response", onResponse);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      const onResponse = async (response: PWResponse) => {
        // Match on the request URL we initiated
        if (response.request().url() !== url) return;

        this.page.off("response", onResponse);
        clearTimeout(timer);

        try {
          const body = await response.text().catch(() => "");
          resolve(
            new SimpleResponse(
              {
                status: response.status(),
                headers: response.headers(),
                body,
              },
              url,
            ),
          );
        } catch (e) {
          reject(e);
        }
      };

      this.page.on("response", onResponse);

      // Fire-and-forget the navigation; we capture the response above
      this.page.goto(url, { timeout }).catch(() => {});
    });
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
        // Resolve relative Location headers to absolute URLs
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
