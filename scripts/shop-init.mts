#!/usr/bin/env tsx
// pnpm shop:init — create a shop in this Supabase project.
//
// Without this, the only way to get a shop was to paste a seed file whose shop row was
// one particular shop, with that shop's address, invoice prefix and invoice sequence.
// Every new install inherited it. A shop gets its own identity here.
//
//   pnpm shop:init
//   pnpm shop:init --name "Computer Services" --prefix CSLINV --next-invoice 1790
//   pnpm shop:init --branch "Agargaon" --branch-code AGR
//   pnpm shop:init --with-samples      # also load the sample catalogue
//   pnpm shop:init --list              # show the shops that already exist
//
// A shop also gets its FIRST BRANCH here. Since P1, everything that happens at a place
// (stock, sales, shifts, cash) belongs to a branch, and invoices are numbered per branch
// — so a shop with no branch cannot sell anything at all.
import fs from "node:fs";
import path from "node:path";
import {
  adminClient, ask, confirm, fail, flag, info, listShops, ok, parseArgs, projectHost,
  requireAdminEnv, str,
} from "./lib/setup.mts";

const args = parseArgs();
const env = requireAdminEnv();
const sb = adminClient(env);

const existing = await listShops(sb);

if (flag(args, "list", "list-shops")) {
  if (existing.length === 0) {
    info("No shops yet. Run `pnpm shop:init` to create one.");
  } else {
    console.log(`Shops in ${projectHost(env.url)}:\n`);
    for (const s of existing) {
      console.log(`  ${s.name}`);
      console.log(`    id              ${s.id}`);
      console.log(`    invoice prefix  ${s.invoice_prefix}`);
        console.log(`    next invoice    ${s.next_invoice ?? "(no branch yet)"}\n`);
    }
  }
  process.exit(0);
}

console.log(`\nCreating a shop in ${projectHost(env.url)}`);
if (existing.length > 0) {
  info(`This project already has: ${existing.map((s) => s.name).join(", ")}`);
}
console.log("");

const name = str(args, "name") ?? (await ask("Shop name"));
if (!name) fail("A shop needs a name.", undefined, 'Run again with --name "Your shop".');

if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
  fail(
    `This project already has a shop called "${name}".`,
    "Two shops with the same name are confusing to pick between later.",
    "Use a different name, or `pnpm shop:init --list` to see what is there.",
  );
}

const address = str(args, "address") ?? (await ask("Address (optional)", ""));
const phone = str(args, "phone") ?? (await ask("Phone (optional)", ""));

// The prefix goes on every invoice the shop ever prints, so it is worth getting right.
const suggested = name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() || "INV";
const prefix = (str(args, "prefix", "invoice-prefix") ?? (await ask("Invoice prefix", suggested))).toUpperCase();
if (!/^[A-Z0-9-]{2,12}$/.test(prefix)) {
  fail(
    `"${prefix}" won't work as an invoice prefix.`,
    "Use 2 to 12 letters, digits or hyphens.",
    'For example: --prefix CSLINV',
  );
}

// A shop replacing another system usually wants its numbering to carry on from where
// that system stopped, so the books do not appear to restart.
const branchName = str(args, "branch", "branch-name") ?? (await ask("First branch name", "Main branch"));
const branchCode = (str(args, "branch-code") ?? (await ask("Branch code (goes in every document number)", "MB"))).toUpperCase();
if (!/^[A-Z0-9]{1,6}$/.test(branchCode)) {
  fail(`"${branchCode}" won't work as a branch code.`, "Use 1 to 6 letters or digits.",
       "For example: --branch-code MB");
}

const nextRaw = str(args, "next-invoice") ?? (await ask("Start invoice numbers at", "1"));
const nextInvoice = Number(nextRaw);
if (!Number.isInteger(nextInvoice) || nextInvoice < 1) {
  fail(`"${nextRaw}" isn't a whole number of 1 or more.`, undefined, "For example: --next-invoice 1790");
}

const withSamples = flag(args, "with-samples", "samples");

console.log("\nAbout to create:\n");
info(`project         ${projectHost(env.url)}`);
info(`name            ${name}`);
info(`address         ${address || "(none)"}`);
info(`phone           ${phone || "(none)"}`);
info(`first branch    ${branchName} (${branchCode})`);
info(`invoice prefix  ${prefix}`);
info(`next invoice    ${nextInvoice}  → first invoice ${prefix}${new Date().getFullYear()}${String(nextInvoice).padStart(6, "0")}`);
info(`sample products ${withSamples ? "yes" : "no"}`);
console.log("");

if (!(await confirm("Create this shop?", flag(args, "yes", "y")))) {
  info("Nothing was created.");
  process.exit(0);
}

const { data: shop, error } = await sb
  .from("shops")
  .insert({
    name,
    address: address || null,
    phone: phone || null,
    invoice_prefix: prefix,
  })
  .select("id, name, invoice_prefix")
  .single();

if (error || !shop) {
  fail("Couldn't create the shop.", error?.message, "Check the keys in .env.local and that the migrations have been run.");
}

ok(`Created "${shop.name}"`);
info(`id ${shop.id}`);

// The first branch. Invoice numbers live here, not on the shop: two branches cannot
// share one sequence without handing out the same invoice number twice.
const { data: branch, error: branchError } = await sb
  .from("branches")
  .insert({
    shop_id: shop.id,
    name: branchName,
    code: branchCode,
    address: address || null,
    phone: phone || null,
    next_invoice: nextInvoice,
  })
  .select("id, name, code")
  .single();

if (branchError || !branch) {
  fail("The shop was created but its first branch wasn't.", branchError?.message,
       "Check every migration in supabase/migrations/ has been run, then run `pnpm check`.");
}

// A branch with no location cannot hold stock, so it gets one immediately — the same
// thing save_branch() does for every branch added later.
const { error: locError } = await sb
  .from("stock_locations")
  .insert({ shop_id: shop.id, branch_id: branch.id, name: "Main store", is_default: true });
if (locError) {
  fail("The branch was created but it has nowhere to keep stock.", locError.message,
       "Check every migration has been run, then run `pnpm check`.");
}
ok(`Created the "${branch.name}" branch (${branch.code}) with a Main store`);

// Units, payment methods, warranty terms, discount reasons, role permissions, document
// sequences and a Retail price list. Without this a brand-new shop has no payment
// method the till will accept and no price list, so it cannot sell anything.
for (const fn of ["seed_shop_defaults", "seed_price_defaults"]) {
  const { error: seedError } = await sb.rpc(fn, { p_shop_id: shop.id });
  if (seedError) {
    fail(
      `The shop was created but its defaults could not be set up (${fn}).`,
      seedError.message,
      "Check every migration in supabase/migrations/ has been run, then run `pnpm check`.",
    );
  }
}
ok("Set up units, payment methods, warranty terms, permissions and a Retail price list");

if (withSamples) {
  await loadSamples(shop.id);
}

console.log("\nNext: add the first owner.\n");
info(`pnpm staff:add --email you@example.com --name "Your name" --role owner${existing.length > 0 ? ` --shop "${shop.name}"` : ""}`);
console.log("");

/**
 * The sample catalogue, pointed at THIS shop. seed.sql is still there for the SQL
 * editor, but it carries its own demo shop id — using it for a real shop is how a
 * second shop ends up with another shop's products.
 */
async function loadSamples(shopId: string) {
  const file = path.join(process.cwd(), "supabase", "seed.sql");
  if (!fs.existsSync(file)) {
    info("No supabase/seed.sql found, so no sample products were loaded.");
    return;
  }
  const sql = fs.readFileSync(file, "utf8");
  const demoShopId = /insert into public\.shops[\s\S]*?values \('([0-9a-f-]+)'/i.exec(sql)?.[1];
  if (!demoShopId) {
    info("Couldn't read the sample catalogue, so no sample products were loaded.");
    return;
  }

  const categories = [...sql.matchAll(/\('([0-9a-f-]+)', '[0-9a-f-]+', '([^']+)', (\d+)\)/g)].map((m) => ({
    id: m[1],
    shop_id: shopId,
    name: m[2],
    sort: Number(m[3]),
  }));

  // Products and serials are many columns of fixed sample data; rather than parse the
  // whole file, copy the demo shop's rows if they are present, otherwise say so.
  const { data: demoProducts } = await sb
    .from("products")
    // `stock` is not on products any more (P1): stock belongs to a branch.
    .select("code, name, brand, price, warranty_months, is_serial, reorder_level, category_id")
    .eq("shop_id", demoShopId);

  if (!demoProducts || demoProducts.length === 0) {
    info("");
    info("No sample products loaded: this project doesn't have the demo catalogue yet.");
    info("Run supabase/seed.sql in the Supabase SQL editor first, then re-run with --with-samples.");
    return;
  }

  if (categories.length > 0) {
    // New ids for this shop, keyed by the demo id so products can be re-pointed.
    const idMap = new Map<string, string>();
    for (const c of categories) {
      const { data } = await sb
        .from("categories")
        .insert({ shop_id: shopId, name: c.name, sort: c.sort })
        .select("id")
        .single();
      if (data) idMap.set(c.id, data.id);
    }
    const rows = demoProducts.map((p) => ({
      ...p,
      shop_id: shopId,
      category_id: p.category_id ? idMap.get(p.category_id) ?? null : null,
    }));
    const { error: pErr } = await sb.from("products").insert(rows);
    if (pErr) {
      info(`Sample products couldn't be copied: ${pErr.message}`);
      return;
    }
    ok(`Loaded ${rows.length} sample products`);
    info("Serial numbers aren't copied — add them with stock-in once that screen exists.");
  }
}
