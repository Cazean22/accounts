import { mkdir } from "node:fs/promises";
import { accountsSchema, type AccountConfig } from "./oauth.ts";
const dataDirectory = "asserts/data";

const rawAccounts = await Bun.file("asserts/accounts.json").json();
const accounts = accountsSchema.parse(rawAccounts);

await mkdir(dataDirectory, { recursive: true });

await Promise.all(
  accounts.map((account: AccountConfig) =>
    Bun.write(
      `${dataDirectory}/${account.account_id}.json`,
      `${JSON.stringify(account, null, 2)}\n`,
    ),
  ),
);

console.log(`Wrote ${accounts.length} accounts to ${dataDirectory}`);
