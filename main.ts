import {
  DEFAULT_REDIRECT_URI,
  generateOAuthUrl,
  submitCallbackUrl,
} from "./oauth.ts";

interface CliOptions {
  callbackUrl?: string;
  state?: string;
  verifier?: string;
  redirectUri?: string;
  scope?: string;
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    if (argument === undefined) {
      break;
    }

    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    if (nextValue === undefined || nextValue.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }

    switch (argument) {
      case "--callback-url":
        options.callbackUrl = nextValue;
        break;
      case "--state":
        options.state = nextValue;
        break;
      case "--verifier":
        options.verifier = nextValue;
        break;
      case "--redirect-uri":
        options.redirectUri = nextValue;
        break;
      case "--scope":
        options.scope = nextValue;
        break;
      default:
        throw new Error(`Unknown flag: ${argument}`);
    }

    index += 1;
  }

  return options;
}

function quoteCliValue(value: string): string {
  return JSON.stringify(value);
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun run main.ts",
      "  bun run main.ts --callback-url <url> --state <state> --verifier <verifier> [--redirect-uri <uri>]",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.callbackUrl === undefined) {
    const oauthStart = await generateOAuthUrl({
      redirectUri: options.redirectUri,
      scope: options.scope,
    });

    console.log(JSON.stringify(oauthStart, null, 2));
    console.log("");
    console.log("Next step:");
    console.log(
      [
        "bun run main.ts",
        `--callback-url ${quoteCliValue(`${oauthStart.redirectUri}?code=YOUR_CODE&state=${oauthStart.state}`)}`,
        `--state ${quoteCliValue(oauthStart.state)}`,
        `--verifier ${quoteCliValue(oauthStart.codeVerifier)}`,
        `--redirect-uri ${quoteCliValue(oauthStart.redirectUri)}`,
      ].join(" "),
    );
    return;
  }

  if (options.state === undefined || options.verifier === undefined) {
    throw new Error(
      "--callback-url requires both --state and --verifier",
    );
  }

  const result = await submitCallbackUrl({
    callbackUrl: options.callbackUrl,
    expectedState: options.state,
    codeVerifier: options.verifier,
    redirectUri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
  });

  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  printUsage();
  process.exitCode = 1;
}
