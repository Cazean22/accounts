import { z } from "zod";

const requiredStringSchema = z.string().trim().min(1);

const emailServiceConfigSchema = z.object({
  workerDomain: requiredStringSchema,
  emailDomain: requiredStringSchema,
  adminPassword: requiredStringSchema,
});

const createEmailResponseSchema = z.object({
  jwt: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

const mailEntrySchema = z.object({
  raw: z.string().nullable().optional(),
});

const fetchMailsResponseSchema = z.object({
  results: z.array(mailEntrySchema).optional(),
});

export interface EmailServiceConfig {
  workerDomain: string;
  emailDomain: string;
  adminPassword: string;
}

export interface CreateEmailResult {
  jwt: string | null;
  address: string | null;
}

type EnvSource = Record<string, string | undefined>;

const RANDOM_LOWERCASE_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const RANDOM_DIGITS = "0123456789";
const DEFAULT_CREATE_EMAIL_TIMEOUT_MS = 10_000;

function randomInteger(minInclusive: number, maxInclusive: number): number {
  const range = maxInclusive - minInclusive + 1;
  return Math.floor(Math.random() * range) + minInclusive;
}

function generateRandomCharacters(characterSet: string, length: number): string {
  let generatedValue = "";

  for (let index = 0; index < length; index += 1) {
    const randomIndex = randomInteger(0, characterSet.length - 1);
    generatedValue += characterSet[randomIndex] ?? "";
  }

  return generatedValue;
}

function emptyCreateEmailResult(): CreateEmailResult {
  return { jwt: null, address: null };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWorkerBaseUrl(workerDomain: string): URL {
  const trimmedWorkerDomain = workerDomain.trim();
  const baseUrl = trimmedWorkerDomain.includes("://")
    ? trimmedWorkerDomain
    : `https://${trimmedWorkerDomain}`;

  const parsedUrl = new URL(baseUrl);

  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new Error(
      "WORKER_DOMAIN must be a bare host or origin without a path, query, or hash",
    );
  }

  return parsedUrl;
}

async function parseJsonWithSchema<T>(
  response: Response,
  schema: z.ZodSchema<T>,
): Promise<T | null> {
  const responseText = await response.text();

  try {
    const parsedJson: unknown = JSON.parse(responseText);
    const result = schema.safeParse(parsedJson);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function toTimeoutMs(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds)) {
    return 10_000;
  }

  return Math.max(0, Math.trunc(timeoutSeconds * 1000));
}

export function readEmailServiceConfig(env: EnvSource = Bun.env): EmailServiceConfig {
  return emailServiceConfigSchema.parse({
    workerDomain: env.WORKER_DOMAIN,
    emailDomain: env.EMAIL_DOMAIN,
    adminPassword: env.ADMIN_PASSWORD,
  });
}

export class EmailService {
  private readonly workerBaseUrl: URL;
  private readonly emailDomain: string;
  private readonly adminPassword: string;

  constructor(config: EmailServiceConfig = readEmailServiceConfig()) {
    this.workerBaseUrl = normalizeWorkerBaseUrl(config.workerDomain);
    this.emailDomain = config.emailDomain;
    this.adminPassword = config.adminPassword;
  }

  private generateRandomName(): string {
    const firstLetters = generateRandomCharacters(
      RANDOM_LOWERCASE_LETTERS,
      randomInteger(4, 6),
    );
    const numbers = generateRandomCharacters(RANDOM_DIGITS, randomInteger(1, 3));
    const secondLetters = generateRandomCharacters(
      RANDOM_LOWERCASE_LETTERS,
      randomInteger(0, 5),
    );

    return `${firstLetters}${numbers}${secondLetters}`;
  }

  async createEmail(): Promise<CreateEmailResult> {
    const requestUrl = new URL("/admin/new_address", this.workerBaseUrl);

    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "x-admin-auth": this.adminPassword,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enablePrefix: true,
          name: this.generateRandomName(),
          domain: this.emailDomain,
        }),
        signal: AbortSignal.timeout(DEFAULT_CREATE_EMAIL_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.error(
          `[-] Failed to create email: ${response.status} - ${await response.text()}`,
        );
        return emptyCreateEmailResult();
      }

      const responseData = await parseJsonWithSchema(response, createEmailResponseSchema);
      if (!responseData) {
        return emptyCreateEmailResult();
      }

      return {
        jwt: responseData.jwt ?? null,
        address: responseData.address ?? null,
      };
    } catch (error) {
      console.error(
        `[-] Email creation request failed (${requestUrl.href}): ${formatErrorMessage(error)}`,
      );
      return emptyCreateEmailResult();
    }
  }

  async fetchFirstEmail(jwt: string, timeout = 10): Promise<string | null> {
    const requestUrl = new URL("/api/mails", this.workerBaseUrl);
    requestUrl.searchParams.set("limit", "10");
    requestUrl.searchParams.set("offset", "0");

    try {
      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(toTimeoutMs(timeout)),
      });

      if (!response.ok) {
        return null;
      }

      const responseData = await parseJsonWithSchema(response, fetchMailsResponseSchema);
      const firstMail = responseData?.results?.[0];

      return typeof firstMail?.raw === "string" ? firstMail.raw : null;
    } catch (error) {
      console.error(`获取邮件失败: ${formatErrorMessage(error)}`);
      return null;
    }
  }
}

const server = new EmailService();
const result = await server.fetchFirstEmail("e94eeb91c4594244a65db55ddc149425.9a96ab786c42128f0e271077c8e4e7cd62c0fd741a170cfa");
console.log(result);
