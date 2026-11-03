#!/usr/bin/env tsx
// pnpm staff:add — give someone a login and link it to a shop.
//
//   pnpm staff:add                                        # asks for what it needs
//   pnpm staff:add --email ovi@csl.com --name Ovi --role cashier --branch Agargaon
//   pnpm staff:add --list                                 # who is in the shop
//   pnpm staff:add --email ovi@csl.com --deactivate       # they left
//   pnpm staff:add --email ovi@csl.com --reset-password   # forgot it
//
// The password is never taken as a flag: it would sit in your shell history. Either it
// is generated and shown once, or it is read from stdin (--password-stdin).
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  adminClient, ask, confirm, fail, flag, generatePassword, info, ok, parseArgs,
  projectHost, requireAdminEnv, resolveShop, str, listShops,
} from "./lib/setup.mts";

type Role = "owner" | "manager" | "cashier";
const ROLES: Role[] = ["owner", "manager", "cashier"];

const args = parseArgs();
const env = requireAdminEnv();
const sb = adminClient(env);

if (flag(args, "list-shops")) {
  for (const s of await listShops(sb)) console.log(`${s.name}  ${s.id}`);
  process.exit(0);
}

const shop = await resolveShop(sb, str(args, "shop"));

// --- list ----------------------------------------------------------------------
if (flag(args, "list")) {
  const { data, error } = await sb
    .from("staff")
    .select("name, role, discount_limit_pct, active, user_id, pin_hash")
    .eq("shop_id", shop.id)
    .order("role")
    .order("name");
  if (error) fail("Couldn't read the staff list.", error.message);

  console.log(`\nStaff at ${shop.name} (${projectHost(env.url)}):\n`);
  if (!data || data.length === 0) {
    info("Nobody yet. Add the owner first:");
    info('pnpm staff:add --email you@example.com --name "Your name" --role owner');
  } else {
    const emails = await emailsByUserId(sb, data.map((r) => r.user_id).filter(Boolean) as string[]);
    for (const r of data) {
      const bits = [
        r.active ? "active" : "TURNED OFF",
        `${r.discount_limit_pct}% discount limit`,
        r.pin_hash ? "has an approval PIN" : "no approval PIN",
      ];
      console.log(`  ${r.name.padEnd(18)} ${r.role.padEnd(8)} ${bits.join(" · ")}`);
      console.log(`  ${" ".repeat(18)} ${r.user_id ? emails.get(r.user_id) ?? "(login missing)" : "(no login)"}\n`);
    }
  }
  process.exit(0);
}

// --- who are we talking about? -------------------------------------------------
const email = (str(args, "email") ?? (await ask("Email"))).toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  fail(`"${email}" doesn't look like an email address.`, undefined, "For example: --email ovi@csl.com.bd");
}

const existingUser = await findUserByEmail(sb, email);

// --- deactivate ----------------------------------------------------------------
if (flag(args, "deactivate", "disable")) {
  if (!existingUser) fail(`No login for ${email}.`, undefined, "Run `pnpm staff:add --list` to see who is there.");
  const row = await staffRow(sb, existingUser.id);
  if (!row || row.shop_id !== shop.id) {
    fail(`${email} isn't staff at ${shop.name}.`, undefined, "Check --shop.");
  }
  if (!(await confirm(`Turn off ${row.name} (${row.role}) at ${shop.name}?`, flag(args, "yes", "y")))) {
    info("Nothing changed.");
    process.exit(0);
  }
  // Through the owner-only function, so it is checked and written to the audit log —
  // the whole reason role, limit and active are no longer directly writable.
  const { error } = await sb.from("staff").update({ active: false }).eq("id", row.id);
  if (error) fail("Couldn't turn them off.", error.message);
  ok(`${row.name} is turned off. They now see "this login isn't set up yet" if they sign in.`);
  info("Their past sales stay exactly as they were.");
  process.exit(0);
}

// --- reset a password ----------------------------------------------------------
if (flag(args, "reset-password")) {
  if (!existingUser) fail(`No login for ${email}.`, undefined, "Add them first, without --reset-password.");
  const password = await choosePassword();
  const { error } = await sb.auth.admin.updateUserById(existingUser.id, { password });
  if (error) fail("Couldn't set the new password.", error.message);
  ok(`New password for ${email}:`);
  console.log(`\n    ${password}\n`);
  info("Shown once. Give it to them directly, and have them keep it to themselves.");
  info("Their approval PIN is unchanged — only they can set that, at /pin.");
  process.exit(0);
}

// --- add or update -------------------------------------------------------------
const name = str(args, "name") ?? (await ask("Full name"));
if (!name) fail("A staff member needs a name.", undefined, 'Run again with --name "Their name".');

const roleRaw = (str(args, "role") ?? (await ask(`Role (${ROLES.join(" / ")})`, "cashier"))).toLowerCase();
if (!ROLES.includes(roleRaw as Role)) {
  const guess = ROLES.find((r) => r.startsWith(roleRaw[0] ?? ""));
  fail(
    `"${roleRaw}" isn't a role.`,
    `Use one of: ${ROLES.join(", ")}`,
    guess ? `Did you mean --role ${guess}?` : "For example: --role cashier",
  );
}
const role = roleRaw as Role;

// An owner has no discount limit to set: they are the person a limit would be
// referred to. Asking makes the setup look like the answer matters when it cannot.
const limitRaw = str(args, "discount-limit", "limit")
  ?? (role === "owner" ? "100" : await ask("Discount limit %, without approval", role === "cashier" ? "5" : "10"));
const discountLimit = Number(String(limitRaw).replace("%", "").trim());
if (!Number.isFinite(discountLimit) || discountLimit < 0 || discountLimit > 100) {
  fail(`"${limitRaw}" isn't a percentage between 0 and 100.`, undefined, "For example: --discount-limit 5");
}

const priorRow = existingUser ? await staffRow(sb, existingUser.id) : null;

// A staff row is unique per login across the whole database, so an upsert would move
// somebody from one shop to another — leaving their old sales behind a row that now
// belongs to a different shop. Make that explicit instead of silent.
if (priorRow && priorRow.shop_id !== shop.id) {
  const from = (await listShops(sb)).find((s) => s.id === priorRow.shop_id);
  if (!flag(args, "move")) {
    fail(
      `${email} is already staff at ${from?.name ?? "another shop"}.`,
      "One login belongs to one shop, so adding them here would move them, and their past sales would stay behind.",
      `If that is really what you want: pnpm staff:add --email ${email} --shop "${shop.name}" --move`,
    );
  }
  info(`Moving ${priorRow.name} from ${from?.name ?? "another shop"} to ${shop.name}.`);
}

const action = priorRow ? "Update" : "Add";
console.log("");
info(`project         ${projectHost(env.url)}`);
info(`shop            ${shop.name}`);
info(`email           ${email}${existingUser ? " (login already exists)" : " (new login)"}`);
info(`name            ${name}`);
info(`role            ${role}`);
info(`discount limit  ${discountLimit}%`);
console.log("");

if (flag(args, "dry-run")) {
  info("--dry-run, so nothing was written.");
  process.exit(0);
}
if (!(await confirm(`${action} this staff member?`, flag(args, "yes", "y")))) {
  info("Nothing changed.");
  process.exit(0);
}

let user = existingUser;
let password: string | null = null;

if (!user) {
  password = await choosePassword();
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    // Without this the login is created unconfirmed and sign-in fails — the single
    // most likely thing to go wrong on a first setup.
    email_confirm: true,
  });
  if (error || !data.user) {
    fail("Couldn't create the login.", error?.message, "If the email is already in use, run again without --email, or use --reset-password.");
  }
  user = data.user;
  ok(`Created the login for ${email}`);
} else {
  info(`Using the login that already exists for ${email}`);
}

const { error: staffError } = await sb
  .from("staff")
  .upsert(
    { shop_id: shop.id, user_id: user.id, name, role, discount_limit_pct: discountLimit, active: true },
    { onConflict: "user_id" },
  );
if (staffError) {
  fail(
    "The login exists but couldn't be linked to the shop.",
    staffError.message,
    `Run the same command again — it picks the existing login up rather than making another.`,
  );
}

const { data: saved } = await sb
  .from("staff")
  .select("id, name, role, discount_limit_pct")
  .eq("user_id", user.id)
  .single();

// Owners get every branch in their shop; everyone else has to be given one, or they
// sign in to an app with no till, no stock and no shift (see current_branch_ids()).
if (role !== "owner" && saved) {
  const { data: branches } = await sb
    .from("branches")
    .select("id, name, code")
    .eq("shop_id", shop.id)
    .eq("active", true)
    .order("name");
  const wanted = str(args, "branch");
  const list = branches ?? [];
  if (list.length === 0) {
    fail(`"${shop.name}" has no branch yet.`,
      "A manager or cashier works at a branch, so there has to be one.",
      "Add one in Settings → Branches, then run this again.");
  }
  const needle = wanted?.trim().toLowerCase();
  const picked = needle
    ? list.filter((b) => b.id === wanted || b.name.toLowerCase() === needle || b.code.toLowerCase() === needle)
    : list.length === 1 ? list : [];
  if (picked.length !== 1) {
    fail(
      wanted ? `No branch called "${wanted}" at ${shop.name}.` : `${shop.name} has more than one branch, so --branch is needed.`,
      `It has: ${list.map((b) => `${b.name} (${b.code})`).join(", ")}`,
      'Run again with --branch "Branch name".',
    );
  }
  const { error: linkError } = await sb
    .from("staff_branches")
    .upsert({ staff_id: saved.id, branch_id: picked[0].id }, { onConflict: "staff_id,branch_id" });
  if (linkError) {
    fail("The login was created but isn't attached to a branch.", linkError.message,
      "Attach them in Settings → Staff, or run this command again.");
  }
  ok(`Works at ${picked[0].name} (${picked[0].code})`);
}

console.log("");
ok(`${name} is ${role === "owner" ? "an owner" : role === "manager" ? "a manager" : "a cashier"} at ${shop.name}`);
info(`staff id ${saved?.id ?? "(unknown)"} · discount limit ${saved?.discount_limit_pct ?? discountLimit}%`);
if (password) {
  console.log(`\n  Password for ${email}, shown once:\n`);
  console.log(`    ${password}\n`);
  info("Give it to them directly. Nobody can read it back later.");
}
if (role !== "cashier") {
  console.log("");
  info("They should sign in and set an approval PIN at /pin, so they can approve big discounts.");
}
console.log("");

// ---------------------------------------------------------------------------

async function choosePassword(): Promise<string> {
  if (flag(args, "password-stdin")) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const typed = Buffer.concat(chunks).toString("utf8").trim();
    if (typed.length < 8) {
      fail("That password is shorter than 8 characters.", undefined, "Supabase rejects very short passwords.");
    }
    return typed;
  }
  return generatePassword();
}

/**
 * supabase-js v2 has no "get user by email", so page through until we find them.
 * Written naively this misses anyone past the first page, and then createUser fails
 * with email_exists on the second run — which is exactly the case this has to handle.
 */
async function findUserByEmail(sb: SupabaseClient, wanted: string): Promise<User | null> {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) fail("Couldn't read the list of logins.", error.message, "Check SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit;
    if (data.users.length < perPage) return null;
  }
  return null;
}

async function staffRow(sb: SupabaseClient, userId: string) {
  const { data } = await sb
    .from("staff")
    .select("id, shop_id, name, role, active")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

async function emailsByUserId(sb: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of data?.users ?? []) if (u.email) out.set(u.id, u.email);
  return out;
}
