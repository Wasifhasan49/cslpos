#!/usr/bin/env tsx
// pnpm doctor — check this install and say what to fix.
//
// Every check prints one line, and a failing one says exactly what to run next. This
// is the difference between setting up shop #2 yourself and setting it up on the phone
// with whoever bought it.
import { createClient } from "@supabase/supabase-js";
import {
  ENV_FILE, adminClient, info, parseArgs, projectHost, readEnv, flag,
} from "./lib/setup.mts";

const args = parseArgs();
const env = readEnv();

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}
const checks: Check[] = [];
const add = (name: string, status: Status, detail: string, fix?: string) =>
  checks.push({ name, status, detail, fix });

// --- environment ---------------------------------------------------------------
const demoFlag = process.env.NEXT_PUBLIC_DEMO_MODE?.trim();

if (demoFlag === "1") {
  add("Mode", "warn", "demo mode (NEXT_PUBLIC_DEMO_MODE=1)",
    `Sample data only, nothing is saved. Remove NEXT_PUBLIC_DEMO_MODE from ${ENV_FILE} to use the database.`);
}

if (!env.url && !env.anonKey) {
  // In deliberate demo mode this is the chosen setup, not a fault.
  add("Supabase keys", demoFlag === "1" ? "ok" : "fail",
    demoFlag === "1" ? "not needed in demo mode" : `none set in ${ENV_FILE}`,
    demoFlag === "1" ? undefined
      : "Copy NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from Supabase → Project Settings → API.");
} else if (!env.url || !env.anonKey) {
  // Half-filled used to fall back to demo mode silently, which looks like it works.
  add("Supabase keys", "fail",
    env.url ? "the URL is set but the anon key is empty" : "the anon key is set but the URL is empty",
    `Fill in both in ${ENV_FILE}, or clear both and set NEXT_PUBLIC_DEMO_MODE=1 for sample data.`);
} else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(env.url) && !env.url.includes("localhost")) {
  add("Supabase keys", "warn", `the URL looks unusual: ${env.url}`,
    "It normally looks like https://abcdefgh.supabase.co");
} else {
  add("Supabase keys", "ok", `${projectHost(env.url)}`);
}

if (!env.serviceKey) {
  add("Service-role key", demoFlag === "1" ? "ok" : "warn",
    demoFlag === "1" ? "not needed in demo mode" : "not set",
    `Only the setup commands need it. Add SUPABASE_SERVICE_ROLE_KEY to ${ENV_FILE} to use pnpm shop:init and pnpm staff:add.`);
} else if (env.serviceKey === env.anonKey) {
  add("Service-role key", "fail", "it is the same string as the anon key",
    "Copy the service_role key (not anon) from Supabase → Project Settings → API.");
} else {
  add("Service-role key", "ok", "set, and not under a NEXT_PUBLIC_ name");
}

const canReach = env.url !== "" && env.anonKey !== "";

// --- can we talk to it? --------------------------------------------------------
if (canReach) {
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { error } = await anon.from("shops").select("id").limit(1);

  if (!error) {
    add("Anon key accepted", "ok", "the database answered");
  } else if (error.code === "42P01") {
    add("Database tables", "fail", "the `shops` table does not exist",
      "Run the files in supabase/migrations/ in the Supabase SQL editor, oldest first.");
  } else if (/JWT|api key|Invalid/i.test(error.message)) {
    add("Anon key accepted", "fail", "the key was rejected",
      "Re-copy NEXT_PUBLIC_SUPABASE_ANON_KEY from Supabase → Project Settings → API, then restart the dev server.");
  } else if (unreachable(error.message)) {
    add("Anon key accepted", "fail", `couldn't reach ${projectHost(env.url)}`,
      "If the internet is fine, this project may have been paused or deleted. Check it still exists in the Supabase dashboard, and that NEXT_PUBLIC_SUPABASE_URL matches it.");
  } else {
    // RLS returning no rows for an anonymous caller is correct, not a problem.
    add("Anon key accepted", "ok", "the database answered");
  }
}

// --- the things that need the admin key ----------------------------------------
if (canReach && env.serviceKey && env.serviceKey !== env.anonKey) {
  const sb = adminClient(env);

  const { error: fnError } = await sb.rpc("current_staff");
  if (fnError && unreachable(fnError.message)) {
    // Never report a check as passing just because the question never arrived.
    add("Migrations applied", "fail", "couldn't ask — the project is unreachable",
      "Fix the connection above first, then run this again.");
  } else if (fnError && (fnError.code === "42883" || /does not exist/i.test(fnError.message))) {
    add("Migrations applied", "fail", "current_staff() is missing",
      "The second migration hasn't been run. Apply supabase/migrations/ in order in the SQL editor.");
  } else {
    add("Migrations applied", "ok", "the sale and PIN functions are there");
  }

  const { data: shops, error: shopError } = await sb
    .from("shops")
    .select("id, name, invoice_prefix, next_invoice")
    .order("name");

  if (shopError && unreachable(shopError.message)) {
    add("Shop", "fail", "couldn't ask — the project is unreachable",
      "Fix the connection above first, then run this again.");
  } else if (shopError) {
    add("Shop", "fail", shopError.message, "Check the migrations have been run.");
  } else if (!shops || shops.length === 0) {
    add("Shop", "fail", "this project has no shop",
      "Run: pnpm shop:init");
  } else {
    add("Shop", "ok", shops.map((s) => `${s.name} (${s.invoice_prefix}, next ${s.next_invoice})`).join(", "));

    for (const shop of shops) {
      const { data: staff } = await sb
        .from("staff")
        .select("name, role, active, pin_hash")
        .eq("shop_id", shop.id);

      const active = (staff ?? []).filter((s) => s.active);
      const owners = active.filter((s) => s.role === "owner");
      const withPin = active.filter((s) => s.pin_hash && s.role !== "cashier");

      if (active.length === 0) {
        add(`Staff · ${shop.name}`, "fail", "nobody can sign in",
          `pnpm staff:add --email you@example.com --name "Your name" --role owner --shop "${shop.name}"`);
      } else if (owners.length === 0) {
        add(`Staff · ${shop.name}`, "fail", `${active.length} staff, but no active owner`,
          `An owner administers the shop. pnpm staff:add --role owner --shop "${shop.name}"`);
      } else {
        add(`Staff · ${shop.name}`, "ok",
          `${active.length} active (${owners.length} owner${owners.length === 1 ? "" : "s"})`);
      }

      if (active.length > 0 && withPin.length === 0) {
        add(`Approval PIN · ${shop.name}`, "warn", "no owner or manager has set one",
          "Big discounts can't be approved until someone sets one. Sign in and go to /pin.");
      } else if (withPin.length > 0) {
        add(`Approval PIN · ${shop.name}`, "ok", `${withPin.length} can approve discounts`);
      }

      const { count } = await sb
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop.id)
        .eq("active", true);

      if (!count) {
        add(`Products · ${shop.name}`, "fail", "the catalogue is empty, so there is nothing to sell",
          `Load the samples with: pnpm shop:init --with-samples --shop "${shop.name}", or run supabase/seed.sql in the SQL editor.`);
      } else {
        add(`Products · ${shop.name}`, "ok", `${count} products`);
      }
    }
  }
}

/** A connection problem rather than an answer from the database. */
function unreachable(message: string | undefined): boolean {
  return /fetch failed|network|ENOTFOUND|getaddrinfo|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message ?? "");
}

// --- report --------------------------------------------------------------------
const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
const failed = checks.filter((c) => c.status === "fail");
const warned = checks.filter((c) => c.status === "warn");

if (flag(args, "json")) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

console.log("");
for (const c of checks) {
  console.log(`${mark[c.status]} ${c.name.padEnd(24)} ${c.detail}`);
}
console.log("");

if (failed.length === 0 && warned.length === 0) {
  console.log("Everything checks out. `pnpm dev`, then sign in.\n");
  process.exit(0);
}

for (const c of [...failed, ...warned]) {
  if (!c.fix) continue;
  console.log(`${c.name}: ${c.fix}`);
}
console.log("");
info(failed.length > 0
  ? `${failed.length} thing${failed.length === 1 ? "" : "s"} to fix before this works.`
  : "Nothing is broken, but see the notes above.");
console.log("");
process.exit(failed.length === 0 ? 0 : 1);
