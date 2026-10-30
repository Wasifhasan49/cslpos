// Shared bits for the setup commands (doctor, shop:init, staff:add).
//
// These run as plain Node scripts, so Next does not load .env.local for them and there
// is no React, no bundler and no browser. Everything here is deliberately dependency
// free apart from the Supabase client.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ENV_FILE = ".env.local";

/** Read .env.local ourselves: `next dev` loads it, a standalone script does not. */
export function loadEnvLocal(dir = process.cwd()): Record<string, string> {
  const file = path.join(dir, ENV_FILE);
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return out;
}

export interface Env {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/**
 * The three strings everything else depends on.
 *
 * Refuses to run if the service-role key has been given a NEXT_PUBLIC_ name. That key
 * bypasses row-level security completely, so anything NEXT_PUBLIC_ ships it to every
 * browser — the one mistake in this whole setup that cannot be undone by fixing a
 * config file, because the key is then public and must be rotated.
 */
export function readEnv(): Env {
  const env = { ...loadEnvLocal(), ...process.env } as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value && value === env.SUPABASE_SERVICE_ROLE_KEY) {
      fail(
        `${key} holds the service-role key.`,
        "Anything named NEXT_PUBLIC_ is sent to every browser, and that key ignores row-level security.",
        `Rename it to SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}, then rotate the key in Supabase → Project Settings → API.`,
      );
    }
  }
  if (/service_role|SUPABASE_SERVICE_ROLE_KEY/i.test(process.argv.slice(2).join(" "))) {
    fail(
      "Don't pass the service-role key as a command argument.",
      "It would be stored in your shell history.",
      `Put it in ${ENV_FILE} as SUPABASE_SERVICE_ROLE_KEY instead.`,
    );
  }

  const url = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const anonKey = (env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return { url, anonKey, serviceKey };
}

export function requireAdminEnv(): Env {
  const env = readEnv();
  if (!env.url || !env.serviceKey) {
    fail(
      `${ENV_FILE} is missing ${!env.url ? "NEXT_PUBLIC_SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY"}.`,
      "This command writes to the database as an administrator, so it needs both.",
      "Copy them from Supabase → Project Settings → API. See README → Connect a real database.",
    );
  }
  return env;
}

/** An admin client. Never used in the app itself — only in these scripts. */
export function adminClient(env: Env): SupabaseClient {
  return createClient(env.url, env.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The project host, so you can see WHICH project you are about to write to. */
export function projectHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface Shop {
  id: string;
  name: string;
  invoice_prefix: string;
  /** Invoice numbering moved to the branch in P1: a shop with two branches cannot have
   *  one sequence. Null when a shop has no branch yet, which `pnpm check` reports. */
  next_invoice: number | null;
}

export async function listShops(sb: SupabaseClient): Promise<Shop[]> {
  const { data, error } = await sb
    .from("shops")
    .select("id, name, invoice_prefix")
    .order("name");
  if (error) {
    if (error.code === "42P01") {
      fail(
        "The database tables aren't set up yet.",
        "The `shops` table does not exist.",
        "Run the files in supabase/migrations/ in the Supabase SQL editor, oldest first.",
      );
    }
    fail("Couldn't read the shops.", error.message, "Check the keys in .env.local.");
  }
  const shops = (data ?? []) as { id: string; name: string; invoice_prefix: string }[];
  if (shops.length === 0) return [];

  // A second query rather than an embedded one: several tables carry both shop_id and
  // branch_id, so PostgREST cannot tell which path from shops to branches is meant.
  const { data: branches } = await sb
    .from("branches")
    .select("shop_id, next_invoice")
    .order("created_at");
  const first = new Map<string, number>();
  for (const b of (branches ?? []) as { shop_id: string; next_invoice: number }[]) {
    if (!first.has(b.shop_id)) first.set(b.shop_id, b.next_invoice);
  }
  return shops.map((s) => ({ ...s, next_invoice: first.get(s.id) ?? null }));
}

/** Find the shop to work in: the only one, or the one named by `--shop`. */
export async function resolveShop(sb: SupabaseClient, wanted: string | undefined): Promise<Shop> {
  const shops = await listShops(sb);
  if (shops.length === 0) {
    fail(
      "This project has no shop yet.",
      "Staff belong to a shop, so one has to exist first.",
      "Run: pnpm shop:init",
    );
  }
  if (!wanted) {
    if (shops.length === 1) return shops[0];
    fail(
      "This project has more than one shop, so --shop is needed.",
      `Found: ${shops.map((s) => s.name).join(", ")}`,
      'Run again with --shop "Shop name", or --list-shops to see them with their ids.',
    );
  }
  const needle = wanted.trim().toLowerCase();
  const match = shops.filter((s) => s.id === wanted || s.name.toLowerCase() === needle);
  if (match.length === 1) return match[0];
  if (match.length > 1) {
    fail(
      `More than one shop is called "${wanted}".`,
      "Names are not unique.",
      `Use the id instead: ${match.map((s) => s.id).join(", ")}`,
    );
  }
  fail(
    `No shop called "${wanted}".`,
    `This project has: ${shops.map((s) => s.name).join(", ")}`,
    "Check the spelling, or run pnpm shop:init to create it.",
  );
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type Args = Record<string, string | boolean>;

/** --key value, --key=value and bare --flag. */
export function parseArgs(argv = process.argv.slice(2)): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq > 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

export function str(args: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

export function flag(args: Args, ...names: string[]): boolean {
  return names.some((n) => args[n] === true || args[n] === "true");
}

// ---------------------------------------------------------------------------
// Talking to the person running this
// ---------------------------------------------------------------------------

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

export async function ask(question: string, fallback?: string): Promise<string> {
  if (!interactive) {
    if (fallback !== undefined) return fallback;
    fail(
      `Need a value for "${question}" but there is no terminal to ask on.`,
      "This looks like a script or CI run.",
      "Pass every value as a flag, e.g. --name, --email, --role.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, auto: boolean): Promise<boolean> {
  if (auto) return true;
  if (!interactive) {
    fail(
      "This command changes data and needs confirmation.",
      "There is no terminal to ask on.",
      "Pass --yes to go ahead without being asked.",
    );
  }
  const answer = (await ask(`${question} (y/n)`, "n")).toLowerCase();
  return answer === "y" || answer === "yes";
}

/** A password you can read out once. No ambiguous characters (0/O, 1/l/I). */
export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Stop, saying what went wrong, why, and what to do about it. */
export function fail(problem: string, cause?: string, fix?: string): never {
  console.error(`\n✗ ${problem}`);
  if (cause) console.error(`  ${cause}`);
  if (fix) console.error(`\n  Fix: ${fix}`);
  console.error("");
  process.exit(1);
}

export function ok(message: string) {
  console.log(`✓ ${message}`);
}

export function info(message: string) {
  console.log(`  ${message}`);
}
