import puppeteer, { type Browser } from "puppeteer-core";

const CHROME_PATH =
  process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome-stable");
const FRAME_URL =
  "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  return browser;
}

export async function buildSentinel(did: string): Promise<string> {
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  try {
    const page = await ctx.newPage();
    await page.setCookie({
      name: "oai-did",
      value: did,
      domain: "sentinel.openai.com",
      path: "/",
      secure: true,
    });
    await page.goto(FRAME_URL, { waitUntil: "networkidle2" });
    await page.waitForFunction("!!window.SentinelSDK", {
      timeout: 15_000,
    });
    await page.evaluate("SentinelSDK.init('authorize_continue')");
    const token = (await page.evaluate(
      "SentinelSDK.token('authorize_continue')",
    )) as string;
    return token;
  } finally {
    await ctx.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser?.connected) {
    await browser.close();
  }
  browser = null;
}
