<!-- /autoplan restore point: /Users/wasif/.gstack/projects/Wasifhasan49-cslpos/main-autoplan-restore-20261017-142908.md -->
# P0 — Supabase + real logins

Status: in review (/autoplan)
Branch: main

## Goal

The app runs against the real Supabase project with real logins. A cashier signs in,
sells, and the sale lands in Postgres with the right total and invoice number. An owner
signs in, sets an approval PIN, and uses it to approve a 10% discount.

## Where we are now (verified against the live project)

| Thing | State |
|---|---|
| `20261017000001_init.sql` | **applied** (tables, functions, RLS all present) |
| `seed.sql` | **not run** — `shops` 0 rows, `products` 0 rows, `categories` 0 rows |
| Auth users | **none** (0 users) |
| `staff` rows | **none** |
| `.env.local` | URL + anon key + `SUPABASE_SERVICE_ROLE_KEY` all set |
| Auth wiring | browser-only `createBrowserClient`; **no server client, no middleware** |
| `/counter` guard | client-side only (`currentStaff()` null → `router.replace("/login")`) |
| `scripts/create-staff.ts` | does not exist |
| "Set my PIN" screen | does not exist |
| "Not linked to a shop" message | does not exist (null staff silently bounces to /login) |

So two things are true at once: the schema is live, but the database is empty and nobody
can log in. P0 has to close both gaps.

## What already exists and will be reused, not rebuilt

- `complete_sale()`, `receive_stock()`, `set_pin()` — all written, tested in
  `supabase/tests/sales_rules_test.sql` (8 groups, 20 checks). **No new migration needed
  for P0.** `set_pin()` already validates 4–6 digits and owner/manager role.
- `friendlyError()` in `src/lib/sale.ts` — already maps `NOT_STAFF` to
  "This login isn't set up as staff for a shop. Ask the owner." Extend, don't replace.
- `Backend` interface + `demo.ts` / `supabase.ts` split — the screens already don't know
  which backend they talk to. New work plugs into the same seam.
- `supabaseBrowser()` in `src/lib/backend/supabase.ts` — already `@supabase/ssr`'s
  `createBrowserClient`, which writes the session to cookies, so middleware can read it.
- `src/app/login/page.tsx` — works; needs only the signed-in redirect and demo guard.

## Work

### 1. Auth: server client + middleware

- `src/lib/env.ts` — single source of truth for `isDemoMode`. Tiny, no imports, so
  middleware can use it without pulling `demo.ts` + `supabase.ts` into the edge bundle.
  `src/lib/backend/index.ts` re-exports it so nothing else changes.
- `src/lib/supabase/server.ts` — `createServerClient` over `cookies()` from
  `next/headers`, for server components and route handlers.
- `src/lib/auth-route.ts` — a **pure** function:
  `routeFor({ path, signedIn, demo }) => { redirect: string } | null`.
  Holds every redirect rule so it is unit-testable without a running Next server.
  Rules: demo mode → never redirect. Signed out on a protected path → `/login`.
  Signed in on `/login` → `/counter`.
- `src/middleware.ts` — the documented `@supabase/ssr` pattern: build one
  `supabaseResponse`, call `getUser()` to refresh the session, pass the answer to
  `routeFor()`, and **copy the refreshed cookies onto any redirect response** (skipping
  this is the standard bug that silently drops sessions). Matcher excludes
  `_next/static`, `_next/image`, favicon, and image/font assets.

### 2. Tell "signed out" apart from "signed in but not staff"

`currentStaff(): Promise<Staff | null>` cannot express the difference, which is why
requirement 4 has nowhere to live today. Replace it with a discriminated result:

```ts
type StaffLookup =
  | { kind: "ok"; staff: Staff }
  | { kind: "signed-out" }
  | { kind: "no-staff" };
```

- `supabase.ts`: no auth user → `signed-out`; auth user but no staff row → `no-staff`.
- `demo.ts`: always `ok`.
- `counter-screen.tsx`: `signed-out` → `/login`; `no-staff` → a plain card reading
  "This login isn't linked to a shop yet. Ask the owner." with a Sign out button, so
  the person is not stranded.

Touches 4 files, no new concepts. Blast radius only.

### 3. `pnpm staff:add` — `scripts/create-staff.ts`

Creates or finds the auth user, sets a password, and upserts the `staff` row.

- Reads `.env.local` itself (Next does not load it for standalone scripts).
- Uses `SUPABASE_SERVICE_ROLE_KEY`; refuses to run if it is missing, and refuses to run
  if it is found in any `NEXT_PUBLIC_*` variable.
- Flags: `--email --name --role --limit --shop --password`. Missing ones are prompted for;
  the password is read without echo, or generated and printed once if left blank, so it
  never has to be typed on a command line and into shell history.
- Shop: if the project has exactly one shop, use it; otherwise require `--shop` and list
  the choices. Never hard-codes CSL's shop id.
- Idempotent: `staff.user_id` is unique, so a second run updates name/role/limit rather
  than erroring or duplicating.
- Prints what it did, including the staff id and role.
- `.env.example` gains `SUPABASE_SERVICE_ROLE_KEY=` with a warning that it is
  server-only, never `NEXT_PUBLIC_`, and never committed.

### 4. "Set my PIN" screen

- `/set-pin` — two fields (4–6 digits, typed twice), owner/manager only.
- New `Backend` method `setPin(pin): Promise<void>`; Supabase calls `set_pin()`, demo
  stores it in memory so the demo manager PIN can be changed too.
- Guarded three ways: the screen redirects a cashier, a server check redirects with a
  message, and `set_pin()` itself raises `NOT_MANAGER`. The database stays the real guard.
- `friendlyError()` gains `BAD_PIN` → "Use 4 to 6 digits." and `NOT_MANAGER` →
  "Only owners and managers can set a PIN." Mismatch is caught on screen:
  "Those two PINs don't match."
- Reachable from the counter header for owners/managers (P1 replaces this with real nav).

### 5. Seed the live project

`seed.sql` has not been run, so there is nothing to sell and the acceptance test cannot
pass. Needs a decision (see Open decisions) on whether I run it or hand it over.

### 6. README

A "Add a staff member" section with the exact `pnpm staff:add` command and the
service-role-key warning, replacing the hand-written SQL in steps 4 and 5.

## Tests

| What | Where | Why |
|---|---|---|
| `routeFor()` redirect rules: signed out, signed in, on `/login`, demo mode, asset paths | `src/lib/auth-route.test.ts` (new) | middleware logic without booting Next |
| `StaffLookup` three states from the demo backend | `src/lib/backend/demo.test.ts` (new) | the `no-staff` card has a real trigger |
| `friendlyError()` for `BAD_PIN`, `NOT_MANAGER` | `src/lib/sale.test.ts` | plain-English rule |
| Cashier cannot read `pin_hash` / costs / audit log | `supabase/tests/sales_rules_test.sql` | already covered (group 2) — re-run, do not rewrite |
| `set_pin()` rejects 3 digits, 7 digits, letters; rejects a cashier | `supabase/tests/sales_rules_test.sql` | `set_pin()` has no negative tests today |
| Manual: cashier sells the splitter; owner sets a PIN and approves 10% | by hand in the browser | the acceptance test from the prompt |

## NOT in scope (deferred)

| Item | Why | Where it goes |
|---|---|---|
| Branches, `branch_id`, branch switcher | P1 owns the migration everything else depends on | P1 |
| Real navigation shell and role-based menus | P1 | P1 |
| Password reset / "forgot password" flow | no email sender configured yet; owner re-runs `staff:add` | TODOS.md |
| Staff management screen (add/edit staff in the UI) | P0 ships the CLI; the screen needs the P1 shell | TODOS.md |
| Rate limiting on sign-in | Supabase Auth has its own limits; revisit at P17 hardening | P17 |
| Session timeout / idle lock at the counter | needs a shop setting | P2 / P17 |
| Sentry, backups, paid plans | P17 / step 10 in CLAUDE.md | P17 |

## Done when

1. `pnpm staff:add` creates a cashier and an owner that can both sign in.
2. Signed in as the cashier, selling 2 Vention audio splitters for ৳1,000 cash writes a
   `sales` row in Supabase with total 1000 and invoice `CSLINV2026001790`.
3. Signed in as the owner, `/set-pin` sets a PIN, and that PIN approves a 10% discount on
   a cashier sale — with the approval in `audit_log`.
4. A signed-in user with no staff row sees the "not linked to a shop" card, not a blank page.
5. Signing out and hitting `/counter` lands on `/login`. Demo mode (no keys) still skips auth.
6. `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:db` all pass.

## Open decisions

- **D1 — TypeScript runner for `pnpm staff:add`.** `tsx` dev dependency vs
  `node --experimental-strip-types` (needs Node 22.6+; this machine is on 24).
- **D2 — Who runs `seed.sql` on the live project.** I can insert it with the service role
  key, or hand over the SQL for the Supabase editor.

---
---

# PHASE 1 — CEO REVIEW (strategy & scope)

Mode: **SELECTIVE EXPANSION** (auto-decided, P1+P2 dominate in the CEO phase).
Outside voices: Codex binary not installed → `[codex-unavailable]`. Claude subagent ran. Tagged `[subagent-only]`.

## 0A. Premise challenge

| # | Premise | Verdict |
|---|---|---|
| 1 | "Auth is the right first step; do it before P1's branch migration." | **Holds.** ~85% of P0 (middleware, server client, staff lookup, PIN screen) is untouched by P1. Only the CLI gains `--branch` and the invoice format changes. Without P0 nothing in P1–P18 is testable against real data. Note: the acceptance invoice `CSLINV2026001790` becomes `CSLINV-MB-2026001790` in P1, so this plan's acceptance test and the SQL test both get edited there. Expected, not waste. |
| 2 | "The Supabase project is ready (migration + seed + 2 users)." | **FALSE.** Probed the live project: schema applied, but `shops`/`categories`/`products` are empty and there are **0 auth users**. The acceptance test cannot pass until the seed runs. This was the plan's biggest hidden assumption. Now stated, and it drives D2. |
| 3 | "Internet at the store is reliable, so online-only is fine." (CLAUDE.md) | **Holds as a product decision, but P0 makes it sharper than intended.** Naive middleware calls `getUser()` on every request; a 20-second internet blip would bounce a signed-in cashier to `/login`, where they also cannot sign in, mid-sale. Online-only must mean "degrades to an error message", not "logs you out". → E3. |
| 4 | "A CLI is the right way to add staff." | **Holds for P0 only.** Correct for CSL (Wasif runs it). Wrong for the 50th shop — no BCS Computer City owner runs `pnpm staff:add`. The plan already defers the staff screen to P1/TODOS.md, which is the honest answer. |
| 5 | "Each cashier signs in with their own email + password." | **Challenged — see Trajectory (Section 10).** Shopify POS, Lightspeed and Square all use device-logs-in-once + per-staff PIN for attribution, because a shared counter PC makes email+password a shift-change tax. The schema already has `pin_hash`. This is P0's only one-way door and is surfaced as a user challenge, not auto-decided. |
| 6 | "Demo mode skipping auth is safe." | **FALSE.** `isDemoMode` is true whenever the Supabase keys are *absent*. A production deploy with one missing env var therefore serves an open, auth-free POS with sample data, and silently drops every sale. Failing loudly beats looking like it works. → E4. |

What if we did nothing? The app only runs in demo mode, no sale is ever saved, and P1–P18 have nothing to build on. Real pain, not hypothetical.

## 0B. What already exists (leverage map — nothing here gets rebuilt)

| Sub-problem | Existing code | Action |
|---|---|---|
| Browser Supabase client | `supabaseBrowser()`, `src/lib/backend/supabase.ts:8` | reuse (already `@supabase/ssr`, already cookie-backed) |
| Sign-in form | `src/app/login/page.tsx` | extend (error granularity, demo guard, signed-in redirect) |
| Sign out | `backend.signOut()` | reuse |
| PIN hashing, 4–6 digit rule, role check | `set_pin()`, migration line ~470 | reuse — **no SQL needed for requirement 3** |
| Error code → plain English | `friendlyError()`, `src/lib/sale.ts:146` | extend with 3 codes |
| "Not linked to a shop" wording | `friendlyError('NOT_STAFF')` already says it | reuse the exact wording |
| Demo/real seam | `Backend` interface, `src/lib/backend/types.ts` | extend (`setPin`, `StaffLookup`) |
| DB rule tests | `supabase/tests/sales_rules_test.sql` (8 groups, 20 checks) | extend; do not rewrite |
| Sample catalogue | `supabase/seed.sql` | run it; do not rewrite |

Verdict: P0 rebuilds nothing. It adds auth plumbing around a foundation that already enforces the business rules.

## 0C. Dream state

```
  CURRENT STATE                    THIS PLAN                      12-MONTH IDEAL
  ─────────────                    ─────────                      ──────────────
  schema live but EMPTY     ──▶    seeded; real logins     ──▶    owner self-signs-up on a
  0 auth users                     session refresh in              website, picks a plan
  nobody can sign in               middleware                     (P18)
  demo mode only                   staff provisioned by CLI        invites staff by phone
  sales go nowhere                 owner sets a PIN and            cashiers tap a PIN on one
  /counter open to anyone          approves a discount             shared counter device
                                   stranger gets a clear           branches + roles self-service
                                   message, not a blank page       nobody touches a CLI or SQL
```

Delta after P0: still CLI-provisioned, still one branch, still email+password per cashier, no self-signup. P0 closes the "nothing is real" gap — the gap that blocks every other prompt from being verifiable. Right place to be.

## 0C-bis. Implementation alternatives

```
APPROACH A: Middleware + server client + CLI + PIN screen   ◀── CHOSEN
  Summary: the documented Next 15 + @supabase/ssr path. Edge middleware refreshes the
           session and redirects; a pure routeFor() holds the rules so they are testable.
  Effort:  M (human ~1.5 days / CC ~35 min)
  Risk:    Low
  Completeness: 9/10
  Pros:    session refresh actually works; route handlers and the extra protected
           sections P1 adds are covered the day they land; redirect rules unit-testable.
  Cons:    one network round trip per matched request; the cookie-copy-on-redirect
           footgun must be got right.
  Reuses:  supabaseBrowser(), login page, friendlyError(), set_pin(), Backend seam.

APPROACH B: Guard in a server layout, no middleware
  Summary: src/app/(app)/layout.tsx is a server component that calls getUser().
  Effort:  S (human ~0.5 day / CC ~15 min)
  Risk:    Med
  Completeness: 6/10
  Pros:    smallest diff; no edge runtime; no cookie-copy footgun.
  Cons:    does NOT refresh an expiring token on navigations that skip the layout;
           leaves route handlers unguarded; Next's own docs point at middleware for
           refresh; P1 adds route handlers and more sections, so this gets redone.
  Verdict: rejected — buys a day now and costs it back in P1.

APPROACH C: Keep everything client-side, add an API route check
  Summary: minimal diff, client guards only.
  Effort:  S (human ~0.25 day / CC ~8 min)
  Risk:    High
  Completeness: 3/10
  Pros:    almost no new code.
  Cons:    does not satisfy P0 item 1; no session refresh; reimplements what
           @supabase/ssr already does (P4 violation); one NEXT_PUBLIC mistake from
           an open app.
  Verdict: rejected.
```

**RECOMMENDATION: A** — highest completeness, and it is the only option that still fits the day P1 lands (P1 completeness, P2 boil-the-lake). B and C are not close, so this is **not** a taste decision.

## 0D. SELECTIVE EXPANSION analysis

**Complexity check.** Base P0 touches 11 files and introduces 0 new classes and 2 new pure modules (`lib/env.ts`, `lib/auth-route.ts`), both leaves. Under the 8-file smell threshold once you discount the 4 files that only gain an import. No complexity challenge raised.

**Minimum set that achieves the goal:** middleware + server client + `StaffLookup` + CLI + `/set-pin` + README. Everything in the cherry-pick list below is additive.

**Cherry-pick ceremony — 11 candidates, auto-decided (7 in, 1 taste, 3 deferred):**

| # | Expansion | Effort | Decision | Principle |
|---|---|---|---|---|
| E1 | `verify_manager_pin()` that logs **failed** PIN attempts, so a cashier guessing a 4-digit PIN shows up in the owner's audit log instead of vanishing | human ~3h / CC ~10 min | **TASTE** | P1 vs "P0 stays migration-free" |
| E2 | Login page tells network failure, rate-limit, unconfirmed email and wrong password apart, instead of blaming the password for all four | human ~2h / CC ~6 min | **IN** | P1 — Prime Directive 1, zero silent failures |
| E3 | Middleware passes the request through when Supabase Auth is *unreachable* (vs genuinely signed out), so an internet blip never logs a cashier out mid-sale | human ~2h / CC ~6 min | **IN** | P1 — correctness of the thing being built |
| E4 | Demo mode can never activate in a production build; missing keys show a configuration error instead of an open POS | human ~1h / CC ~4 min | **IN** | P1 — security-adjacent |
| E5 | Counter shows "No products yet" instead of a blank picker when the catalogue is empty — which is the live database's state **right now**, so this is literally the first screen after sign-in | human ~1h / CC ~4 min | **IN** | P2 — blast radius, first-run experience |
| E6 | Fix `scripts/test-db.sh` + `00_supabase_stub.sql` so they stop assuming they own the whole Postgres instance | human ~1h / CC ~4 min | **IN** | P2 — ground rules require `pnpm test:db` to pass, and it **cannot today** |
| E7 | `pnpm staff:add --list` and `--deactivate`, so "a cashier left" has an answer that isn't a SQL editor | human ~2h / CC ~6 min | **IN** | P2 — same file, week-1 event |
| E8 | An expired session at the counter says "Your session ended. Sign in again." and keeps the half-built sale, instead of "This login isn't set up as staff for a shop" | human ~1h / CC ~5 min | **IN** | P1 — the counter's worst moment |
| E9 | Move `supabaseBrowser()` to `src/lib/supabase/client.ts`, next to the new `server.ts`, so pages stop reaching into the backend adapter for a raw client | human ~1h / CC ~4 min | **IN** | P5 — explicit, symmetric, 3 files |
| E10 | Shared-device login + per-staff PIN (the Shopify POS / Lightspeed model) | human ~1 week / CC ~2h | **DEFER + USER CHALLENGE** | architectural; P0's one-way door |
| E11 | Playwright E2E for sign-in → sell → PIN-approve | human ~2 days / CC ~40 min | **DEFER → P17** | new infra, outside blast radius, >1 day |

**Platform potential:** `routeFor()` becomes the single place every later role/branch redirect rule lands (P1 needs exactly this). `lib/env.ts` becomes the feature-switch home P2 asks for. Both are infrastructure, not one-offs.

## 0E. Temporal interrogation

| When | What happens |
|---|---|
| HOUR 1 | Wasif runs `pnpm staff:add` twice, signs in as both, sells a splitter. Works — **but only if the seed ran** (D2). |
| HOUR 2 | Needs a third cashier, runs the CLI again, forgets `--limit`, gets the default 5%. Fine. |
| DAY 2 | At the store, the internet blips for 20 s mid-sale. Without E3 the cashier is thrown to `/login` with a half-built sale and cannot sign back in. **This is the moment P0 either earns trust or loses it.** |
| WEEK 1 | A cashier leaves. Without E7 there is no way to deactivate them except the SQL editor. |
| WEEK 2 | A Vercel preview deploy misses an env var → without E4, a public URL serves an open demo POS that looks like it works and saves nothing. |
| MONTH 2 | P1 lands branches; the invoice format and the acceptance test change. Expected and cheap. |
| MONTH 6 | If E10 was the right call, changing it after P1 means touching every RLS policy and `complete_sale()`. The cost of this decision rises steeply after P1 — which is why it is a user challenge now, not later. |

HOUR-level interrogation is what produced E3 and E7. Neither was in the original plan.

## 0F. Mode confirmed

**SELECTIVE EXPANSION.** Base scope held and made bulletproof; 7 expansions accepted, 1 surfaced as taste, 3 deferred with destinations.

---

## Section 1 — Architecture Review

### Dependency graph

```
BEFORE
  browser ──▶ /counter (rsc) ──▶ CounterScreen (client) ──▶ getBackend()
                                                              ├─demo──▶ demo.ts
                                                              └─real──▶ supabase.ts ──▶ createBrowserClient
  No server-side auth anywhere. /counter renders for anyone who asks.

AFTER (P0)
  request
     │
     ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ src/middleware.ts                      (edge, matched routes) │
  │   isDemoMode?  ──yes──▶ pass through                          │
  │   createServerClient(req/res cookies)                         │
  │   getUser()   ──▶ refreshes the session cookie                │
  │      │                                                        │
  │      ├─ unreachable / 5xx ──▶ pass through       ◀── E3       │
  │      ▼                                                        │
  │   routeFor({ path, signedIn, demo, authUnreachable })  (pure) │
  │      ├─ null        ──▶ supabaseResponse  (refreshed cookies) │
  │      └─ {redirect}  ──▶ NextResponse.redirect                 │
  │                         + COPY the refreshed cookies  ◀── the │
  │                           classic @supabase/ssr footgun       │
  └───────────────────────────────────────────────────────────────┘
     │
     ├──▶ /login (client)        ──┐
     ├──▶ /counter (rsc→client)  ──┤──▶ getBackend() ──┬─demo──▶ demo.ts
     └──▶ /set-pin (rsc guard)   ──┘                   └─real──▶ supabase.ts
                                                                  │
                      ┌───────────────────────────────────────────┴──┐
                      ▼                                              ▼
            lib/supabase/client.ts  (E9)              lib/supabase/server.ts  (new)
            createBrowserClient                       createServerClient(cookies())
                      │                                              │
                      └──────────────────┬───────────────────────────┘
                                         ▼
                      ┌──────────────────────────────────────────┐
                      │ Postgres — RLS + security definer        │
                      │  complete_sale()  set_pin()              │
                      │  current_shop_id()  is_manager()         │
                      └──────────────────────────────────────────┘

  NEW leaves (zero imports, safe for the edge bundle):
     src/lib/env.ts         → isDemoMode          (single source of truth)
     src/lib/auth-route.ts  → routeFor()          (pure, unit-tested)
```

### Data flow — all four paths, staff lookup

```
  happy  : cookie ─▶ getUser() ─▶ user.id ─▶ select staff ─▶ 1 row ──▶ {kind:"ok", staff}
  nil    : no cookie ─▶ getUser() ─▶ null ────────────────────────────▶ {kind:"signed-out"} ─▶ /login
  empty  : cookie ok ─▶ user.id ─▶ select staff ─▶ 0 rows ───────────▶ {kind:"no-staff"}    ─▶ card + Sign out
  error  : cookie ok ─▶ select staff ─▶ network / 5xx / RLS ─────────▶ throw ──▶ "Couldn't load the shop." + Try again
```

**FINDING 1.1 (high).** Today `currentStaff()` collapses the error path into the nil path: `if (error || !data) return null` (`src/lib/backend/supabase.ts:30`). A transient Postgrest failure therefore reads as "signed out" and bounces a signed-in cashier to `/login`. The `StaffLookup` union must keep *four* outcomes distinct, not three — a query **error** is not 0 rows. Decided: throw on error, return `no-staff` only on a genuine 0-row result.

### State machine — session

```
        ┌────────────┐  sign in ok   ┌───────────┐
        │ signed out │──────────────▶│ signed in │
        └─────┬──────┘               └──┬─────┬──┘
              ▲                          │     │ staff row missing
              │ sign out / refresh       │     ▼
              │ token expired            │   ┌──────────┐
              └──────────────────────────┤   │ no-staff │──sign out──┐
                                         │   └──────────┘            │
                                         │ auth unreachable          │
                                         ▼                           │
                                   ┌──────────────┐                  │
                                   │ degraded     │                  │
                                   │ (pass through│                  │
                                   │  show error) │                  │
                                   └──────┬───────┘                  │
                                          │ network back             │
                                          └──▶ signed in             │
        ◀─────────────────────────────────────────────────────────────┘

  Prevented invalid transition: "auth unreachable" must NEVER fall into
  "signed out" — that is exactly the DAY-2 failure. Enforced by E3 and by a
  routeFor() unit test on the authUnreachable branch.
```

### Coupling

New coupling: `middleware → lib/env.ts` and `middleware → lib/auth-route.ts`. Both are dependency-free leaves, so the edge bundle does not pull in `demo.ts` + `supabase.ts` + `sale.ts`. Importing `lib/backend/index.ts` from middleware would have dragged the whole demo catalogue into the edge runtime — avoided deliberately, and that is the reason `lib/env.ts` exists (comment it, or someone will inline it back).

### Scaling

What breaks first: `getUser()` is one HTTPS round trip Dhaka→Singapore (~40–80 ms) per **matched** request. At 10x (a busy counter, several tabs) it is invisible if the matcher excludes static assets; if it does not, every image pays the round trip and the counter feels slow. At 100x (many shops) this becomes Supabase Auth rate-limit territory → a P18 concern, noted not fixed.

Second: `listProducts()` selects the whole catalogue plus every in-stock serial on each load, unpaginated (`src/lib/backend/supabase.ts:49`). Fine at CSL's scale; a 20k-product shop will feel it. **P3/P4 concern — out of P0's blast radius, recorded in TODOS.md.**

### Single point of failure

Supabase Auth. If it is down, nobody can sign in — unavoidable for an online-only product. E3 bounds the damage so that an *already signed-in* cashier is not locked out too.

### Security architecture

New mutation surface: exactly one, `set_pin()` through `/set-pin`, already role-checked inside the function. No new endpoints. The service-role key never enters the Next build (CLI only) — asserted by a test, see Section 3.

### Production failure scenario per integration point

| Integration | Realistic failure | Plan accounts for it? |
|---|---|---|
| Middleware → Supabase Auth | timeout / DNS | **Yes, after E3** (pass through) |
| Counter → Postgres (staff lookup) | 5xx mid-load | Yes — Finding 1.1 forces a real error path |
| `/set-pin` → `set_pin()` | response lost after the write | Yes — `set_pin()` overwrites the hash, so a retry is idempotent |
| `staff:add` → Auth admin API | auth user created, staff insert then fails | **Yes, after the idempotency requirement** — a second run must find and reuse the orphan user, not error |

### Rollback posture

Base P0 adds **no migration**: rollback is `git revert` + redeploy, under 2 minutes. Reversibility **5/5**. If E1 is accepted, one additive function-only migration joins it — still backward compatible, still 4/5. Worth saying out loud: P0 is a two-way door, so move fast (speed calibration).

---

## Section 2 — Error & Rescue Map

```
  CODEPATH                        | WHAT CAN GO WRONG            | ERROR
  --------------------------------|------------------------------|---------------------------
  middleware getUser()            | network timeout / DNS        | AuthRetryableFetchError
                                  | refresh token expired        | AuthApiError 400 invalid_grant
                                  | Supabase 5xx                 | AuthApiError 5xx
  login signInWithPassword()      | wrong password               | AuthApiError 400 invalid_credentials
                                  | email never confirmed        | AuthApiError 400 email_not_confirmed
                                  | too many attempts            | AuthApiError 429 over_request_rate_limit
                                  | internet down                | AuthRetryableFetchError
  currentStaff() staff select     | 0 rows                       | (not an error → no-staff)
                                  | RLS / permission             | PostgrestError 42501
                                  | network                      | FetchError
  setPin() rpc                    | 3 or 7 digits, letters       | BAD_PIN
                                  | a cashier calls it           | NOT_MANAGER
                                  | network                      | FetchError
  completeSale() rpc              | session expired mid-sale     | 401 / JWT expired → NOT_STAFF
  staff:add                       | service-role key missing     | (explicit exit 1)
                                  | email already registered     | 422 email_exists
                                  | password too weak            | 422 weak_password
                                  | project has 0 shops          | (explicit exit 1 → "run the seed")
                                  | project has >1 shop, no --shop | (explicit exit 1 → list them)
```

```
  ERROR                            | RESCUED? | RESCUE ACTION              | USER SEES
  ---------------------------------|----------|----------------------------|---------------------------------
  AuthRetryableFetchError (mw)     | Y ◀ E3   | pass through, warn-log     | the page, then "Can't reach the
                                   |          |                            |  server. Check the internet."
  AuthApiError invalid_grant (mw)  | Y        | treat as signed out        | the login page
  AuthApiError 5xx (mw)            | Y ◀ E3   | pass through, warn-log     | as above
  invalid_credentials              | Y        | inline message             | "Wrong email or password."
  email_not_confirmed              | N ◀ GAP  | —                          | "Wrong email or password." ← WRONG,
                                   |          |                            |  and the user can never fix it
  over_request_rate_limit (429)    | N ◀ GAP  | —                          | "Wrong email or password." ← WRONG,
                                   |          |                            |  so they keep trying and stay locked
  AuthRetryableFetchError (login)  | N ◀ GAP  | —                          | "Wrong email or password." ← WRONG,
                                   |          |                            |  it is the internet
  PostgrestError on staff select   | N ◀ GAP  | collapses to null          | silent bounce to /login
  401 / JWT expired on completeSale| N ◀ GAP  | friendlyError → NOT_STAFF  | "This login isn't set up as staff
                                   |          |                            |  for a shop" ← WRONG and alarming
                                   |          |                            |  mid-sale
  BAD_PIN                          | Y (new)  | friendlyError              | "Use 4 to 6 digits."
  NOT_MANAGER                      | Y (new)  | friendlyError              | "Only owners and managers can set
                                   |          |                            |  a PIN."
  MANAGER_PIN_INVALID              | Y        | friendlyError              | "Wrong manager PIN."
  email_exists (staff:add)         | Y (new)  | find + reuse the user      | "Found the existing login, linked it."
  0 shops (staff:add)              | Y (new)  | exit 1 with the fix        | "No shop in this project yet. Run
                                   |          |                            |  supabase/seed.sql first."
```

**FINDING 2.1 (critical for trust, cheap to fix).** `src/app/login/page.tsx:26` maps **every** failure to `"Wrong email or password."` That single line turns four different problems — no internet, rate-limited, unconfirmed email, actually-wrong password — into one message, three of which are lies. Two of them the user cannot act on. This is Prime Directive 2 ("every error has a name") and it is 15 lines to fix. → **E2, accepted.**

**FINDING 2.2 (high).** A session that expires while a sale is half-built surfaces as `NOT_STAFF`, whose existing wording is "This login isn't set up as staff for a shop. Ask the owner." At the counter, mid-sale, that reads as "your account is broken" when the truth is "sign in again". Map the 401/JWT-expired case before `friendlyError()` sees it, and keep the Zustand sale lines so nothing is retyped. → **E8, accepted.**

No catch-all handlers are introduced. The one existing broad `catch (e)` in `counter-screen.tsx:58` already re-surfaces a plain-English message and is left as is.

---

## Section 3 — Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| Service-role key reaches the browser | Med | **Critical** — full RLS bypass | Partly. The name carries no `NEXT_PUBLIC_`, but nothing *enforces* that. **Add two guards:** the CLI refuses to run if the key is found under any `NEXT_PUBLIC_*` name, and a unit test greps `src/` for `SUPABASE_SERVICE_ROLE_KEY` and fails if it appears. |
| Service-role key committed | Low | Critical | `.gitignore` has `.env*` with `!.env.example` — verified. Keep `.env.example`'s value empty. |
| Misconfigured production deploy serves an open POS | **Med** | High | **Not mitigated today** → E4. |
| **PIN brute force** — a cashier loops `complete_sale` guessing a 4-digit PIN | **Med** | **High** — defeats the whole owner-protection story | **Not mitigated.** No attempt limiting anywhere, and because `MANAGER_PIN_INVALID` raises, the transaction rolls back, so a failed attempt leaves **no trace at all**. 10,000 guesses at a few per second is minutes. → **E1 (taste).** |
| Cashier sets their own PIN and self-approves | Low | High | **Safe** — `set_pin()` filters `role in ('owner','manager')`. Had no negative test; one is now added. |
| Cashier reads costs / PIN hashes / audit log | Low | Med | DB-enforced and already tested (group 2). |
| Cross-shop read (shop A sees shop B) | Low | High | RLS via `current_shop_id()`, already tested (group 7). |
| Weak staff password from the CLI | Med | Med | Enforce a minimum length; prefer a generated password. |
| Password leaks into shell history via `--password` | Med | Med | Default to a hidden prompt or a generated password; `--password` stays as an escape hatch. |
| Unconfirmed email silently blocks sign-in | **High** | Med | CLI must pass `email_confirm: true`; otherwise every created login fails with a message that E2 is needed to even read. |
| Session fixation / stale cookie | Low | Med | `@supabase/ssr` + middleware refresh. |

Input validation on every new input: PIN is `^[0-9]{4,6}$` on screen **and** in `set_pin()`; email is validated by the Auth API; `--role` is checked against the table's own CHECK constraint; `--limit` is clamped 0–100 to match `discount_limit_pct`'s constraint. No new injection vector — every DB touch is a parameterised rpc or a Postgrest filter, no string-built SQL.

New dependency risk: at most `tsx` (dev-only, D1). No runtime dependency added.

Audit logging: discount approvals and price changes are covered. Sign-ins, PIN sets and failed PIN attempts are **not** — see Section 8 and E1.

---

## Section 4 — Data Flow & Interaction Edge Cases

```
  SIGN-IN DATA FLOW
  INPUT ────▶ VALIDATION ────▶ AUTH API ────▶ COOKIE SET ────▶ STAFF LOOKUP ────▶ COUNTER
    │             │                │              │                 │
    ▼             ▼                ▼              ▼                 ▼
 [empty?]    [not an email?]  [429 rate limit?] [cookie       [0 rows → no-staff card]
 [spaces?]   [handled by      [network down?]    blocked by   [query error → "Couldn't
 [trimmed    [the input type] [unconfirmed?]     the browser?] load the shop." + retry]
  already]                    [5xx?]            [3rd-party    [staff.active = false →
                                                  cookies?]    treated as no-staff ✓]
```

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Sign in | double-click submit | Y | `busy` disables the button (`login/page.tsx:18`) |
| | Enter key | Y | native form submit |
| | internet down | **N → E2** | currently blames the password |
| | rate-limited | **N → E2** | currently blames the password |
| | unconfirmed email | **N → E2** | currently blames the password |
| | already signed in, opens `/login` | **N → new** | `routeFor` sends them to `/counter` |
| | signs in but has no staff row | **N → new** | no-staff card with a Sign out button, so nobody is stranded |
| | `staff.active = false` | Y | the query filters `active`, so it reads as no-staff — correct |
| Set PIN | the two fields differ | **N → new** | "Those two PINs don't match." |
| | 3 digits / 7 digits / letters | **N → new** | inline, plus `BAD_PIN` from the DB |
| | double-submit | **N → new** | disable while saving |
| | a cashier opens `/set-pin` directly | **N → new** | server-side redirect **and** `NOT_MANAGER` from the DB |
| | success | **N → new** | confirmation that also says where the PIN gets used |
| | navigates away mid-save | Y | `set_pin()` is idempotent |
| Counter first paint | catalogue is empty | **N → E5** | **this is the live DB's state right now**; blank picker with no explanation |
| | session expires while the sale is half-built | **N → E8** | wrong, alarming message |
| | internet drops mid-sale | Partial | error shown; confirm the Zustand lines survive |
| Sign out | from the no-staff card | **N → new** | without it the person is stuck on a dead end |
| Middleware | auth unreachable | **N → E3** | would log out a working cashier |
| | redirect loop `/login` → `/login` | **N → new** | `routeFor` returns `null` for `/login` when signed out; covered by a test |

**FINDING 4.1 (high).** The first thing Wasif will see after signing in, today, is an empty product picker with no message — because the seed never ran. The empty state is not hypothetical, it is the current first-run experience of the product. → **E5, accepted.**

---

## Section 5 — Code Quality Review

* **DRY.** `isDemoMode` would be computed in two places (backend index + middleware) without `lib/env.ts`. Centralised. The 4–6 digit regex *is* duplicated between `set_pin()` and the screen — accepted, because it is the documented house pattern (`sale.ts` deliberately mirrors `complete_sale()` for instant feedback, CLAUDE.md "Keep the two in sync"). Noted, not flagged.
* **Organisation.** `login/page.tsx` imports `supabaseBrowser` from `lib/backend/supabase.ts` — a page reaching into a backend *adapter* for a raw client. Moving it to `lib/supabase/client.ts`, beside the new `server.ts`, makes the two clients symmetric and stops pages depending on the adapter. → **E9, accepted.**
* **Naming.** `StaffLookup` with `"ok" | "signed-out" | "no-staff"` names the states instead of overloading `null`. `routeFor` says what it answers. Both pass the "named for what it does" test.
* **Over-engineering check.** Is `routeFor()` a premature abstraction? No — it is ~15 lines and it is the only way to test middleware without booting Next. Justified.
* **Under-engineering check.** `if (error || !data) return null` (Finding 1.1) is the existing fragile spot, and it is exactly the "assumes happy path" smell. Fixed by this plan.
* **Cyclomatic complexity.** `routeFor()` branches 4 times (demo / unreachable / signed-out-on-protected / signed-in-on-login). Under the 5 threshold. `create-staff.ts` is the one place that could sprawl; keep it as small named steps (resolve shop → resolve user → upsert staff → report) rather than one long function.

No other DRY violations found: I checked for an existing middleware, server client, or PIN screen before planning new ones — there are none (`find src -name 'middleware*'` is empty), so nothing here is a rebuild.

---

## Section 6 — Test Review

```
  NEW UX FLOWS
    sign in (now guarded) · signed-out redirect · signed-in-on-/login redirect
    no-staff card + sign out · set PIN (happy / mismatch / too short / cashier blocked)
    empty-catalogue counter state (E5) · session-expired message (E8)

  NEW DATA FLOWS
    cookie ─▶ getUser ─▶ route decision
    auth user ─▶ staff row ─▶ StaffLookup (4 outcomes)
    pin ─▶ set_pin() ─▶ bcrypt hash

  NEW CODEPATHS
    isDemoMode in middleware · routeFor ×4 branches · StaffLookup ×4 outcomes
    middleware auth-unreachable pass-through · setPin error mapping
    production-without-keys config error (E4)

  NEW INTEGRATIONS / EXTERNAL CALLS
    Supabase Auth admin API (CLI) · Supabase Auth from edge middleware

  NEW ERROR/RESCUE PATHS
    every GAP row in Section 2
```

| Item | Test type | Where | Happy | Failure | Edge |
|---|---|---|---|---|---|
| `routeFor()` | unit | `src/lib/auth-route.test.ts` (new) | signed in on `/counter` → no redirect | signed out on `/counter` → `/login` | signed out on `/login` → **no** redirect (loop guard); signed in on `/login` → `/counter`; demo → never; `authUnreachable` → never |
| `StaffLookup` | unit | `src/lib/backend/demo.test.ts` (new) | demo → `ok` | query error → throws, **not** `signed-out` | 0 rows → `no-staff`; `active:false` → `no-staff` |
| `friendlyError()` | unit | `src/lib/sale.test.ts` (extend) | — | `BAD_PIN`, `NOT_MANAGER` | JWT-expired → session message, not `NOT_STAFF` |
| `setPin` in demo | unit | `demo.test.ts` | changes the demo PIN | rejects `123` | rejects `1234567`, `12a4` |
| `set_pin()` negatives | integration | `supabase/tests/sales_rules_test.sql` (extend) | owner sets a PIN (covered) | `'123'`, `'1234567'`, `'abcd'` → `BAD_PIN` | a **cashier** calling `set_pin()` → `NOT_MANAGER` ← closes an untested security boundary |
| failed-PIN audit (if E1) | integration | same file | success still works | 3 wrong PINs → 3 audit rows the owner can read | cashier cannot read them |
| service-role key containment | unit | `src/lib/env.test.ts` (new) | — | fails if `SUPABASE_SERVICE_ROLE_KEY` appears anywhere under `src/` | — |
| sign in → sell → approve | manual | browser, 5 min | the prompt's acceptance test | — | — |

**Test ambition check.**
* *The 2am-Friday test:* "a signed-in cashier loses the internet for 30 seconds and the counter neither bounces to `/login` nor loses the sale lines." This is why `routeFor()` takes an explicit `authUnreachable` flag — it makes the DAY-2 scenario a unit test instead of a hope.
* *The hostile-QA test:* a cashier POSTs straight to the `complete_sale` rpc with 50 guessed PINs. Only E1 makes this visible.
* *The chaos test:* kill the network between `signInWithPassword` succeeding and the staff lookup. Expected: "Couldn't load the shop." + Try again — **not** a bounce to `/login`. Finding 1.1 is what makes this pass.

**Pyramid:** many unit (routeFor, friendlyError, demo, env), a few SQL integration, manual E2E. Correct shape for this stage. No E2E harness exists; adding Playwright is E11, deferred to P17 — recorded rather than pretended.

**Flakiness risk:** none of the new unit tests touch time, randomness, network or ordering. The SQL additions use `dhaka_today()`, the existing stable pattern.

**LLM/prompt changes:** none. CLAUDE.md defines no eval suites. No evals apply to P0 — stated rather than skipped.

**Pre-existing blocker (E6):** `pnpm test:db` **fails on this machine right now**, before any P0 code: `00_supabase_stub.sql:3` runs an unconditional `create role anon`, and `test-db.sh`'s cleanup `drop role` can never succeed because the `anon` role is shared with another database on this Postgres instance (`257 objects in database hrm_preflight`). Every ground-rules check list ends with "pnpm test:db passes", so this must be fixed inside P0 or the gate is unmeetable. Fix: guard both `create role` statements with an existence check and drop the global `drop role` line.

---

## Section 7 — Performance Review

* **N+1 queries:** none introduced. The staff lookup is one indexed row (`staff.user_id` is `unique`, hence indexed).
* **Middleware cost:** one HTTPS round trip to Supabase Auth per matched request, ~40–80 ms Dhaka→Singapore. The matcher must exclude `_next/static`, `_next/image`, `favicon.ico`, and image/font extensions, or every asset pays it and the counter feels sluggish. This is the single most important performance decision in P0.
* **RLS function cost:** `current_shop_id()` and `is_manager()` are called inside every policy. They are `stable`, so Postgres evaluates them once per statement, not per row — acceptable. Worth knowing before P1 adds `current_branch_id()` to the same hot path.
* **Memory:** `listProducts()` holds the whole catalogue plus in-stock serials in browser memory. Hundreds of products is nothing; 20k would be ~several MB and a slow first paint. **Out of P0's blast radius → TODOS.md for P3/P4.**
* **Indexes:** no new query needs a new index.
* **Caching:** nothing worth caching in P0. Deliberately not adding a session cache in middleware — a stale cached session is worse than an 80 ms round trip.
* **Slow paths, p99 estimate:** sign-in ~300–600 ms (Auth round trip + staff lookup + redirect); counter first paint ~400–900 ms (products + serials); `/set-pin` save ~150–300 ms (bcrypt in Postgres is intentionally slow, which is correct).
* **Connection pool:** middleware talks to the Auth REST API, not Postgres. No pool pressure added.

---

## Section 8 — Observability & Debuggability Review

This is the thinnest part of the plan as written, and the honest answer is that P0 is a one-shop deployment where Supabase's own dashboards carry most of the load. What is still worth adding:

* **Logging.** Middleware has none. A cookie bug or a redirect loop would be completely invisible. Add one structured `console.warn` on the `authUnreachable` branch (Vercel captures it) — this is the branch most likely to misbehave and hardest to reproduce.
* **Metrics.** "Is it working?" = a `sales` row appears after a sale. "Is it broken?" = sign-ins failing, visible in Supabase's Auth logs. For one shop that is enough; a real metric story belongs with the owner dashboard (P12). Stated explicitly rather than invented.
* **Debuggability at 3 weeks.** `audit_log` reconstructs discount approvals and price changes. It does **not** record sign-ins, PIN sets, or failed PIN attempts. Failed PIN attempts are the gap that matters, because that is the anti-theft story the whole product is sold on — and today a failed attempt rolls back and leaves nothing. → **E1.**
* **Alerting / dashboards.** None for P0. Sentry is already step 10 of CLAUDE.md's own list and P17's job. Not smuggled in here.
* **Admin tooling.** `pnpm staff:add` *is* the admin tool. `--list` makes the runbook below executable instead of aspirational, and `--deactivate` answers week 1. → **E7.**
* **Runbook — "a cashier can't sign in"** (goes in the README):
  1. `pnpm staff:add --list` — is there an active staff row for that email?
  2. Supabase → Authentication → Users — is the email confirmed?
  3. Does the project have a shop and products at all (did the seed run)?

---

## Section 9 — Deployment & Rollout Review

* **Migration safety.** Base P0: **no migration at all.** With E1: one additive migration that only creates a function — backward compatible, no table lock, zero downtime.
* **Rollout order.** Must be: (1) run `seed.sql`, (2) `pnpm staff:add` for the owner and a cashier, (3) deploy. Deploying middleware before any staff row exists means every sign-in lands on the no-staff card — correct behaviour, confusing first impression.
* **Deploy-time risk window.** Old client + new middleware run together briefly. The cookie format is unchanged (same `@supabase/ssr` version), so an open counter tab keeps working. Low risk.
* **Feature flags.** Not needed. Demo-vs-real *is* the flag, and E4 makes it explicit rather than accidental.
* **Rollback, step by step.** `git revert <sha>` → push → Vercel redeploys the previous build → the app returns to its pre-P0 state. Under 2 minutes. No data migration to undo. If E1 landed, its function can stay (unused and harmless) or be dropped separately.
* **Environment parity.** There is **no staging**, and Vercel preview deploys would share the one Supabase project — so a preview deploy writes to the real shop's data. Acceptable while testing locally against a database that holds only sample rows; **a second Supabase project for previews is required before real money runs through this.** Recorded in TODOS.md for P17, not fixed here.
* **Post-deploy verification, first 5 minutes.** Reuse the acceptance test as the smoke test: sign in as the cashier → sell 2 splitters → confirm the `sales` row and invoice number → sign in as the owner → set a PIN → approve a 10% discount → confirm the `audit_log` row.

---

## Section 10 — Long-Term Trajectory Review

* **Debt introduced, all intentional and written down:** the CLI stands in for a staff screen (P1/TODOS.md); `/set-pin` is a standalone route that P1's nav shell will absorb; the acceptance invoice number changes in P1.
* **Path dependency — the one that matters.** P0 commits to *one auth identity per person*, with `auth.uid()` as the key for every RLS policy and for `complete_sale()`'s staff attribution. The shared-device model (one device login + a per-staff PIN, which is how Shopify POS, Lightspeed and Square all do retail) is a different foundation. The schema already carries `pin_hash`, so the idea is half-built already. **Reversibility of P0 as code: 5/5. Reversibility of the auth model embedded in it: 2/5, and it drops further once P1 rewrites every policy for branches.** This is the single decision in P0 worth the user's attention, which is why it is a user challenge rather than an auto-decision.
* **Knowledge concentration.** `routeFor()` and `StaffLookup` are self-documenting. `lib/env.ts` is the one file whose *reason* is invisible — add a one-line comment about keeping the edge bundle small, or a future reader will helpfully inline it and quietly double the middleware bundle.
* **Ecosystem fit.** Middleware + `@supabase/ssr` + `createServerClient` is exactly the documented Next 15 App Router path. No swimming upstream.
* **The 1-year question.** A new engineer reading P0 in 12 months sees: one place that decides redirects, one place that decides demo mode, one interface with two implementations, and business rules in SQL. That is a legible system.
* **Platform potential.** `routeFor()` is where P1's role and branch redirects land. `lib/env.ts` is where P2's feature switches land. Both become infrastructure rather than one-offs.

---

## Section 11 — Design & UX Review (UI scope detected)

Interaction state coverage:

| Screen | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| `/login` | ✓ "Signing in…" | n/a | ✓ but **one message for four causes** → E2 | ✓ redirect | — |
| `/set-pin` | ✗ unspecified | n/a | ✗ unspecified | ✗ unspecified | ✗ mismatch unspecified |
| no-staff card | n/a | — | n/a | n/a | needs a Sign out, or it is a dead end |
| `/counter` first paint | ✓ `loading` | ✗ **→ E5** (the live state today) | ✓ `loadError` | ✓ | — |

**FINDING 11.1 (high).** `/set-pin` is specified as "two fields, 4–6 digits, typed twice" and nothing else — no loading, no error, no success, no mismatch wording. Four unspecified states on a brand-new screen is exactly the ambiguity that gets filled in with whatever is quickest. Phase 2 pins them down.

**FINDING 11.2 (medium).** The success state needs to say more than "Saved." The owner has just created a number whose only purpose is to be typed by *someone else at the counter* — so the confirmation should say where it gets used: "PIN saved. Type it at the counter when a cashier needs a discount approved."

**AI-slop risk:** low-to-moderate. "Two fields and a button" is generic; the house voice in CLAUDE.md ("say what to do next", "Pick the serial number for …") sets a higher bar that the plan's own wording does not yet meet.

**Responsive intention:** stated (390 px, ≥44 px targets) but not designed — a 4–6 digit PIN entry on a phone should use `inputMode="numeric"` and `autoComplete="off"`, which `sale-panel.tsx:126` already does for the phone field. Reuse that pattern.

**Accessibility basics:** the login form already does `role="alert"` on errors and labelled inputs — carry both to `/set-pin`. PIN fields must be `type="password"` with `inputMode="numeric"`, and the mismatch error must be announced, not just coloured.

User flow:

```
   ┌──────────┐  no session   ┌─────────┐
   │ /counter │──────────────▶│ /login  │
   └────┬─────┘               └────┬────┘
        ▲                          │ correct email + password
        │                          ▼
        │                   ┌──────────────┐
        │                   │ staff row?   │
        │                   └──┬────────┬──┘
        │                   no │        │ yes
        │                      ▼        ▼
        │        ┌────────────────────┐ └──▶ /counter ──┐
        │        │ "This login isn't  │                  │ catalogue empty?
        │        │  linked to a shop  │                  ▼
        │        │  yet. Ask the      │        ┌────────────────────────┐
        │        │  owner."           │        │ "No products yet."  E5 │
        │        │  [Sign out]        │        └────────────────────────┘
        │        └────────────────────┘                  │
        │                                     owner / manager only
        │                                                ▼
        │                                      ┌──────────────────────┐
        └─────────────────────────────────────▶│ /set-pin             │
                                               │ PIN · confirm PIN    │
                                               │ ✓ "PIN saved. Type it│
                                               │   at the counter when│
                                               │   a cashier needs a  │
                                               │   discount approved."│
                                               └──────────────────────┘
```

Recommendation honoured: Phase 2 runs the deep design review on `/set-pin` and the no-staff card.

---

## CEO dual voices — consensus

Codex: `[codex-unavailable]` (binary not installed). Claude subagent: ran.

```
CEO DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                             Claude  Codex  Consensus
  ───────────────────────────────────── ─────── ────── ──────────
  1. Premises valid?                    partly   n/a   FLAGGED
  2. Right problem to solve?            no       n/a   DISAGREE
  3. Scope calibration correct?         no       n/a   DISAGREE
  4. Alternatives explored enough?      no       n/a   DISAGREE
  5. Competitive/market risks covered?  no       n/a   FLAGGED
  6. 6-month trajectory sound?          partly   n/a   FLAGGED
═══════════════════════════════════════════════════════════════════
  Missing voice = n/a, never CONFIRMED. A single critical finding
  from one voice is flagged regardless.
  Confirmed: 0/6.  Disagreements: 3.  Flagged: 3.
```

The subagent's strongest **in-scope** finding, independently matching my own Section 3 analysis: the manager PIN is the feature the product is sold on and it controls nothing (no attempt counter, no lockout, no failure logging, `0000` permitted). Both voices reached that from different directions. **Verified below — it is worse than either of us described.**

Its out-of-scope findings (pricing anchored at "cheaper than BMS"; no written IP/ownership agreement with CSL; no conversation with a second shop; the "sell the owner dashboard on top of BMS's Excel export instead of replacing BMS" reframe) are real business questions, but they are not P0 and not mine to decide. Two are surfaced as one-line flags at the gate; none change this plan's scope.

---

# VERIFICATION PASS (before accepting any voice's claim)

Every load-bearing claim was tested against a throwaway Postgres built from the real migration + seed, or against the installed library types. Results:

| Claim | Verdict | Evidence |
|---|---|---|
| A manager can raise their **own** discount limit 10 → 100 | **CONFIRMED** | `UPDATE 1`, limit now `100.00` |
| A manager can promote **themselves** to owner | **CONFIRMED** | `UPDATE 1`, role now `owner` |
| A manager can **deactivate the owner** | **CONFIRMED** | `UPDATE 1`, owner `active = f` → owner locked out of their own shop |
| Any of the above is audited | **CONFIRMED ABSENT** | `audit_log` = **0 rows** |
| A **cashier** can do the same | **REFUTED** | `UPDATE 0` — the policy requires `is_manager()`. Threat is manager-only. |
| Failed manager-PIN attempts leave a trace | **CONFIRMED ABSENT** | 3 wrong PINs → `audit_log` 0 rows, `sales` 0 rows. Totally invisible. |
| A guessed PIN then works | **CONFIRMED** | 4th call with `1234` returned `CSLINV2026001790` at **50% off** |
| `@supabase/ssr` 0.12.7 `setAll` takes `(cookiesToSet, headers)` | **CONFIRMED** | `types.d.ts:48`; the library's own comment: responses setting auth cookies must not be CDN-cached or "one user's session token can be served to a different user" |
| `select *` on `staff` fails for an authenticated user | **CONFIRMED** | `ERROR: permission denied for table staff`; named columns work |
| SQL raises codes `friendlyError()` never maps | **CONFIRMED** | `BAD_DISCOUNT`, `BAD_PAYMENT_METHOD`, `BAD_QTY` fall through to "Check the internet" |
| A demo-only `StaffLookup` test is vacuous | **CONFIRMED** | `demo.ts:11` hard-codes one cashier and always returns `ok` |
| Demo `/set-pin` is unreachable | **CONFIRMED** | same line — demo staff is a cashier, so the owner/manager screen never renders |
| "PIN approved" is a fake green state | **PARTLY REFUTED** | `sale-panel.tsx:146` already says "PIN entered · checked when the sale is saved". The copy is honest; the problem is that a wrong PIN is only discovered after the customer has waited through the whole sale. |

Two findings came back **worse** than any voice stated, and they change P0's shape — see User Challenge 1.

---

# PHASE 2 — DESIGN REVIEW (UI scope detected)

Outside voices: Codex `[codex-unavailable]`; Claude designer subagent ran. `[subagent-only]`

```
DESIGN DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                             Claude  Codex  Consensus
  ───────────────────────────────────── ─────── ────── ──────────
  1. Information hierarchy right?       no       n/a   DISAGREE
  2. Interaction states covered?        no       n/a   DISAGREE
  3. User journey coherent?             no       n/a   DISAGREE
  4. Specific UI vs generic patterns?   generic  n/a   DISAGREE
  5. Design-system alignment?           partly   n/a   FLAGGED
  6. Responsive intention real?         no       n/a   DISAGREE
  7. Accessibility specified?           no       n/a   DISAGREE
═══════════════════════════════════════════════════════════════════
  Confirmed: 0/7.  The designer voice and my own Section 11 agree:
  the plan is specific about data flow and generic about every screen.
```

Its summary line is the one worth keeping: *the only strings this plan commits to are error strings.* That is accurate and it is the fix list below.

### Accepted design decisions

| # | Decision | Why |
|---|---|---|
| D-1 | **Do not redirect a cashier away from `/set-pin`.** Render a card: "Only owners and managers set an approval PIN. Ask the owner if you need a discount approved." + Back to the counter. | My own plan specified two contradictory guards ("the screen redirects" *and* "a server check redirects with a message") and never said which wins or how the message travels. One rendered state removes the ambiguity and the redirect-loop risk. |
| D-2 | **`/set-pin` gets its own error mapper, not `friendlyError()`.** | Verified: `friendlyError()`'s default is "Couldn't complete the sale. Check the internet and try again." On the PIN screen that tells an owner a *sale* failed. |
| D-3 | **Success stays on the page** and reads "PIN saved. Type it at the counter when a cashier needs a big discount approved." | `setPin` returns `void`; with nothing specified the implementer writes `router.replace("/counter")` and the owner gets no confirmation of a secret they typed blind and must now remember. |
| D-4 | **Add `hasPin()`** so the screen can say "Set your approval PIN" vs "Change your approval PIN". | `pin_hash` is unreadable by design, so the screen otherwise reads "Set my PIN" forever, including to someone who has had one for months. Needs a `has_pin()` SQL function — nearly free now that User Challenge 1 puts a migration in P0 anyway. |
| D-5 | **One plain PIN field, not segmented OTP boxes**, `type="password"` + `inputMode="numeric"` + `autoComplete="new-password"` + `maxLength={6}`, sized like the counter's money fields, with a show/hide toggle. | 4–6 variable length is incompatible with a 6-box pattern — build the boxes and a 4-digit PIN breaks them. `autoComplete="new-password"` stops Chrome offering to save it as a site password. |
| D-6 | **Validate length locally before submitting**; server codes are the backstop. Mismatch is checked on blur of the confirm field, never per keystroke. | Sending "that's 3 digits" to Singapore and back is the wrong trip, and a mismatch error flashing at the second character is punishing. |
| D-7 | **Reuse the counter's `blocker` + disabled-button + `text-warn-ink` pattern** from `sale-panel.tsx`, and its `busy`/"Saving…" convention. | Makes two screens feel like one app; also kills the double-submit path, which the plan had not specified. |
| D-8 | **One shared `NoShopCard`**, used by both `counter-screen.tsx` and `/set-pin`. | Both routes have the identical state; my plan only wired it into the counter, so it would have been duplicated and drifted. |
| D-9 | **The no-staff card names the signed-in email and offers Try again as well as Sign out.** "You're signed in as *razu@csl.com.bd*, but this login isn't set up for a shop yet. Ask the owner to add you, then try again." | "Ask the owner" — ask them *what*? The email is the actionable fact. And the owner may fix it in 30 seconds while the person stands there; Sign out alone throws the session away and forces a password re-type. |
| D-10 | **Reword it to cover deactivated staff too**: "…isn't linked to a shop, or has been turned off." | `current_shop_id()` requires `active`, so a deactivated cashier lands on this exact card. |
| D-11 | **Skip the header link.** Surface `/set-pin` where it is needed: when the manager-PIN box appears at the counter and no PIN is set, that box reads "No approval PIN set yet. Set one." | At 390 px the counter header already wraps to two rows; a third row of chrome holding a once-a-year task, next to the button cashiers press all day, is the wrong trade. |
| D-12 | **Delete the client-side `useEffect` redirects in `login/page.tsx`** once middleware owns redirects. | Otherwise a signed-in owner sees a full login form flash for ~300 ms, which reads as "I got logged out". |
| D-13 | **Login page:** map network / 429 / unconfirmed-email / wrong-password separately; add a password show/hide toggle, `autoFocus` on email, `autoCapitalize="none"` + `spellCheck={false}`. | This matters more than the whole PIN screen — it is the screen every cashier uses every day, on a phone that capitalises their email. |
| D-14 | **Static line under the sign-in button:** "Forgot your password? Ask the owner to set a new one." | Deferring the reset flow is right; shipping a dead end is not. |
| D-15 | **Name it "Approval PIN" and route `/pin`.** | "Set my PIN" is engineer-speak carried over from `select set_pin('…')`, and in Dhaka "PIN" alone competes with bKash, card and SIM PINs. Route strings outlive plans. |
| D-16 | **Weak-PIN guard:** reject all-same-digit and simple runs with "Pick something harder to guess — not 1234 or 0000", plus "Type it where staff can't see." | The entire discount control rests on the cashier not knowing the PIN. Typed-twice protects against typos, not against being watched. Verified: `set_pin()` happily accepts `1234`. |
| D-17 | **Make the demo staff an owner** so demo mode can actually show `/pin`, and label the demo PIN state on screen. | Verified: demo staff is hard-coded `cashier`, so the planned demo `setPin` is unreachable by users *and* by the planned test. Demo mode is also the sales demo for other shops. |
| D-18 | **Remove the now-unreachable `"Not signed in."` fallback** at `counter-screen.tsx:131`. | Otherwise the file carries two conflicting messages for the same situation. |
| D-19 | **Error text above the button, button never fixed, focused field scrolled into view**; add a Done-when item: all screens checked at 390×670 with the keyboard open. | With a numeric keyboard up, ~45% of a 390×670 viewport is gone — the confirm field, the error and the button all end up behind it. |

### Declined

**Focus-ring contrast** (`--color-focus: #e8a33d` on white ≈ 2:1, under the 3:1 minimum for non-text indicators). The finding is correct and worth fixing, but it is a global token in `globals.css` affecting every existing screen — changing it inside P0 silently restyles the whole counter. → **TODOS.md**, with a note that it should be fixed before the store goes live, since these are keyboard-driven forms.

### Information hierarchy for `/pin`

```
  1  "Approval PIN"                                    ← what this is
  2  "Your PIN approves big discounts at the counter.  ← why it exists, before
      Only owners and managers have one."                 they type anything
  3  Signed in as {name} ({email})                     ← WHOSE pin; a shop can
                                                           have three
  4  [ PIN            ] 👁   "4 to 6 digits"           ← the rule BEFORE the
  5  [ Confirm PIN    ] 👁                                error, not after
  6  ( Save PIN )  /  ( Saving… )
  7  error line (above the button, role="alert")
```

---

# PHASE 3 — ENG REVIEW

Outside voices: Codex `[codex-unavailable]`; Claude eng subagent ran. `[subagent-only]`

```
ENG DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                             Claude  Codex  Consensus
  ───────────────────────────────────── ─────── ────── ──────────
  1. Architecture sound?                yes      n/a   FLAGGED (agrees with mine)
  2. Test coverage sufficient?          no       n/a   DISAGREE
  3. Performance risks addressed?       no       n/a   DISAGREE
  4. Security threats covered?          NO       n/a   DISAGREE (critical)
  5. Error paths handled?               no       n/a   DISAGREE
  6. Deployment risk manageable?        partly   n/a   FLAGGED
═══════════════════════════════════════════════════════════════════
  Confirmed: 0/6.  Disagreements: 4 (one critical).  Flagged: 2.
```

This voice earned its keep. It found two holes I had not found, both now verified by experiment, and it was right about the library-version detail that would have shipped a session-leak vector.

### Where it agreed with my own review (independent convergence — treat as high confidence)

Demo mode is fail-open; the PIN is brute-forceable; `getUser()` has no "couldn't tell" state and would log out a cashier mid-sale; `seed.sql` burns invoice 1790 on the store's own project; `friendlyError()` blames the internet for real errors; `test-db.sh` mutates cluster-global roles. Six findings reached twice from different starting points.

### Where it was wrong, and I am not accepting it

* **"The PIN shows a green approved state without verifying."** Verified against `sale-panel.tsx:146`: the copy already reads "PIN entered · checked when the sale is saved". It is honest, not fake. The real (milder) problem is *when* the failure lands — after the customer has waited through the whole sale. Recorded at that severity, not as a lie.
* **"A cashier can escalate privileges."** Tested: `UPDATE 0`. The `staff_write` policy requires `is_manager()`, so this is a manager-only threat. That bounds the blast radius and is why it is a migration fix rather than an emergency.
* **Stub `auth.uid()` "validates a different function than production."** Overstated — real Supabase `auth.uid()` reads `request.jwt.claim.sub` *as well as* the `request.jwt.claims` JSON. The stub is a compatible subset, not a divergent implementation. The underlying suggestion (verify the group-2 guarantees once against the real project in the browser) is still worth 5 minutes, so it is in the acceptance list.

### Accepted engineering decisions

| # | Decision | Severity | Why |
|---|---|---|---|
| E-1 | **`setAll(cookiesToSet, headers)` — set the cookies *and* the headers**, in middleware and in every route handler. `lib/supabase/server.ts` constructs a **fresh client per request**, never a module-level singleton. | **critical** | Verified in the installed 0.12.7 types: the library hands you `Cache-Control: private, no-store`-style headers precisely so a CDN cannot cache an auth response, and its own comment warns that otherwise "one user's session token can be served to a different user". My plan described `setAll` as cookie-copying only. The headers object is non-empty only on the first cookie write per client, so a cached singleton silently drops them on later responses. |
| E-2 | **Drop `role`, `discount_limit_pct` and `active` from the `authenticated` UPDATE grant on `staff`** (keep `name`). Route those three through an owner-only `security definer` function that writes `audit_log`, refuses self-edits of role and limit, and refuses to deactivate the last active owner. | **critical** | Verified: a manager raised their own limit to 100%, promoted themselves to owner, and deactivated the owner — with **zero** audit rows. That defeats the discount-limit mechanism the product is sold on, and P0 is the step that creates the first real manager account. |
| E-3 | **Move PIN verification into `verify_manager_pin(p_approver_id uuid, p_pin text)`** — its own transaction, so it can record attempts; refuses after N failures in a window; logs success *and* failure; returns a short-lived approval the sale consumes. `complete_sale()` keeps its own check as the real guard. | **critical** | Verified: 3 wrong PINs left 0 audit rows and 0 sales rows, then a correct guess went through at 50% off. Because `MANAGER_PIN_INVALID` raises, any audit insert inside `complete_sale()` is rolled back by the same exception — logging failures is **structurally impossible** without a separate transaction. This one change also fixes the late-failure UX, the wrong-approver attribution, and gives `checkManagerPin()` (today a `return null` stub) something real to do. |
| E-4 | **Name the approving manager.** Today `complete_sale()` matches *any* owner/manager hash in the shop with `limit 1` and no `order by`, so with two managers sharing `1234` the audit log names an arbitrary one. The counter picks the approver; `verify_manager_pin` verifies that person. | high | An audit log that can name the wrong person is worse than none — it is the owner's only record of who approved what. |
| E-5 | **`routeFor({ signedIn: true \| false \| "unknown" })`.** `"unknown"` passes through unredirected. Protected-by-default: a tiny explicit public list (`["/login"]`), everything else protected. Thread `?next=` through with an allowlist. | high | A boolean cannot express "Auth was unreachable", so a DNS blip becomes "signed out" and bounces every counter to `/login` — which also cannot reach Auth. The cart lives in an in-memory Zustand store with no persistence, so the bounce **destroys the sale being rung up in front of a customer**. Deny-by-default means P1's new routes are guarded by omission rather than exposed by it. |
| E-6 | **`current_staff()` as one `security definer` RPC** returning `{staff_id, shop_id, name, role, discount_limit_pct, shop_name, has_pin}` as jsonb. | high | Verified: `select *` on `staff` returns `permission denied for table staff`, so any natural `select("*")` — in `/pin`'s role check, or P1's staff screen — fails with `42501`, which `friendlyError()` reports as "check the internet". One RPC removes the column-grant trap, collapses three sequential Dhaka→Singapore round trips (`getUser` → staff → shops) into one, carries `has_pin` for D-4, and gives the three-way lookup one testable home. |
| E-7 | **Extract `classifyStaffLookup({ user, staffRow, error })`** as a pure function and test *that*. Also make `createSupabaseBackend(client?)` accept an injected client. | high | My own test plan was vacuous: it proposed testing three `StaffLookup` states against `demo.ts`, which is hard-coded to always return `ok`. The two states that justify requirement 4 live only in `supabase.ts`, which takes no injectable client and so has no test at all. |
| E-8 | **`email_confirm: true` in `staff:add`.** | high | Supabase projects confirm email by default, so without it the script prints success and the cashier cannot sign in — and the login page reports it as "Wrong email or password." The most likely thing to break on the very first real run. |
| E-9 | **Find the existing auth user by paging `listUsers()` to exhaustion** (no `getUserByEmail` exists in supabase-js v2), and **refuse to change `shop_id`** on an existing staff row without an explicit `--move` flag that prints before/after. | high | `staff.user_id` is globally unique, not per-shop, so a naive upsert silently *moves* a person between shops: their historical `sales.shop_id` stays with shop A while `staff.shop_id` becomes B, so RLS hides their own past sales and shop B's sales point at a foreign staff row. A naive `listUsers()` also misses anyone past page 1, breaking the idempotency the plan claims. |
| E-10 | **Map every code the SQL can raise**, and make the default actionable: "Something went wrong. Tell the owner this code: `<raw>`". Add a test that greps the migration for `raise exception '<CODE>'` and fails if any code has no `friendlyError` branch. | medium | Verified three pre-existing gaps (`BAD_DISCOUNT`, `BAD_PAYMENT_METHOD`, `BAD_QTY`) plus raw Postgres errors, all currently reported as "Check the internet and try again" — so staff reload forever chasing a network problem that does not exist. The grep test keeps the two sides in sync automatically, which is the convention CLAUDE.md already asks for. |
| E-11 | **Wrap RLS helpers in a subselect**: `using (shop_id = (select public.current_shop_id()))`, same for `is_manager()`, in every policy. | medium | Unwrapped, the `security definer` lookup is re-evaluated per candidate row — the standard Supabase performance cliff. Harmless on 11 products, not harmless on the owner dashboard scanning a year of sales. Mechanical now, and much cheaper before P1 adds `branch_id` to all the same policies. |
| E-12 | **Guard the role creation in `00_supabase_stub.sql`** behind an existence check and drop the global `drop role` line from `test-db.sh`. Refuse to run if the target cluster looks like Supabase (`select 1 from pg_roles where rolname='supabase_admin'`). | medium | `pnpm test:db` **fails on this machine right now**, before any P0 code: the `anon` role is shared with another database on this cluster (`257 objects in database hrm_preflight`), so the cleanup `drop role` can never succeed and the stub's unconditional `create role anon` errors. Roles are cluster-scoped, so pointed at a local `supabase start` this script would drop the roles Supabase's own stack depends on — and `\|\| true` hides it. Every ground-rules check list ends with "pnpm test:db passes". |
| E-13 | **RSC cookie writes must be wrapped in try/catch and allowed to no-op**; use `getAll`/`setAll`, never the deprecated `get`/`set`/`remove`; re-create `supabaseResponse` via `NextResponse.next({ request })` after setting request cookies. | medium | Writing cookies during a Server Component render throws in Next 15. And `setAll` is *optional* in the 0.12.7 type, so omitting it compiles cleanly while refreshed tokens are silently discarded — the chunked-cookie breakage mode. My plan's "build one `supabaseResponse`" reads as build-once-then-mutate; done literally, server components in the same request read stale cookies. |
| E-14 | **Sign-out uses `window.location.assign("/login")`**, not `router.replace`. | low | A client nav can be served from the RSC cache; with middleware present that flickers or loops. |
| E-15 | **Reject empty serials in `receive_stock`**, and fix `friendlyError`'s `split(":")` dropping everything after a second colon. | low | A trailing comma in a pasted serial list currently creates a serial of `''`; a product name containing `:` renders truncated in "out of stock" messages. |

### Deferred, with destinations (recorded, not silently dropped)

| Item | Why not now | Where |
|---|---|---|
| `complete_sale()` holds the shop-row lock across `crypt()` (~100 ms), serializing every sale in a shop | One counter at CSL — invisible. Real for a chain with several terminals on one `shop_id`. Note: this lock also accidentally prevents product-lock-ordering deadlocks, since `p_items` order is browser-controlled, so do not remove it without sorting the item loop by `product_id`. | TODOS.md → P1 |
| Owner-only `reset_pin(p_staff_id)` | `set_pin()` is self-only and `pin_hash` is ungranted, so nobody can clear a departed manager's hash except the service-role key | TODOS.md |
| `revoke all ... from anon` only covers tables existing at that moment; P1's new tables get default `anon` grants back | RLS is the real guard; this is belt-and-braces | P1 migration checklist |
| `listProducts()` loads the whole catalogue unpaginated | Fine at hundreds of products; a problem at 20k | TODOS.md → P3/P4 |
| Split `Backend` into `CounterBackend` / `AdminBackend` | It is becoming a god object and every addition must be mirrored in `demo.ts`, but splitting mid-P0 churns files P1 will touch anyway | TODOS.md → P1 |
| Record sale duration + click count in `sales` | Genuinely valuable — it is the only way to prove the "faster than BMS" claim — but it needs client instrumentation and a column, and the number is only meaningful against the real catalogue (P4) | TODOS.md → P4 |
| Playwright E2E + CI | Would be the real 2am-Friday test; new infra, outside P0's blast radius | TODOS.md → P17 |
| Second Supabase project for Vercel previews | Preview deploys currently share the one project, so a preview writes to the store's data | TODOS.md → P17 |
| Focus-ring contrast token | Global token; changing it inside P0 restyles every existing screen | TODOS.md |

### Architecture delta from this phase

```
  BEFORE (my Phase-1 plan)              AFTER (verified eng review)
  ────────────────────────              ───────────────────────────
  routeFor(signedIn: boolean)     ──▶   routeFor(signedIn: true|false|"unknown")
                                        + explicit public list, deny by default
                                        + ?next= passthrough

  setAll(cookiesToSet)            ──▶   setAll(cookiesToSet, headers)
                                        cookies AND headers, per-request client

  currentStaff(): 3 round trips   ──▶   current_staff() RPC: 1 round trip
  + select("*") would 42501               + has_pin, + no column-grant trap

  StaffLookup tested via demo.ts  ──▶   classifyStaffLookup() pure fn
  (vacuous)                               + injectable client in supabase.ts

  PIN checked only inside           ──▶ verify_manager_pin() own transaction
  complete_sale(), failures             logs success AND failure, rate-limits,
  rolled back and invisible             names the approver

  staff UPDATE grant includes       ──▶ grant name only; role/limit/active via
  role, discount_limit_pct, active      owner-only audited function

  NO MIGRATION IN P0              ──▶   ONE additive migration  ← User Challenge 1
```

---

# PHASE 3.5 — DX REVIEW (developer-facing scope detected)

Product type: a self-hosted-per-shop web app with a CLI setup path. The "developer" is Wasif today, and whoever sets up shop #2 tomorrow — plausibly a shop owner, not an engineer.
Outside voices: Codex `[codex-unavailable]`; Claude DX subagent ran. `[subagent-only]`

```
DX DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════════
  Dimension                             Claude  Codex  Consensus
  ───────────────────────────────────── ─────── ────── ──────────
  1. Getting started < 5 min?           no       n/a   DISAGREE
  2. API/CLI naming guessable?          no       n/a   DISAGREE
  3. Error messages actionable?         no       n/a   DISAGREE
  4. Docs findable & complete?          no       n/a   DISAGREE
  5. Upgrade/recovery path safe?        no       n/a   DISAGREE
  6. Dev environment friction-free?     no       n/a   DISAGREE
═══════════════════════════════════════════════════════════════════
  Confirmed: 0/6.  Disagreements: 6.
```

### Developer journey, as it stands after the original P0

| Stage | Today | After P0 as originally planned | Friction |
|---|---|---|---|
| 1. Discover | README | README | fine |
| 2. Demo run | `pnpm install && pnpm dev` | unchanged | **~2 min, genuinely good** |
| 3. Create Supabase project | manual | manual | unavoidable |
| 4. Apply migration | paste SQL in the dashboard | paste SQL | 1 paste |
| 5. Seed | paste SQL | paste SQL | 1 paste, **and it plants CSL's identity** |
| 6. Get 3 keys | 3 dashboard copy-pastes | 3 copy-pastes | the key-naming trap below |
| 7. Create a shop | **impossible** | **still impossible** | **blocking for shop #2** |
| 8. Create staff | hand-written SQL | `pnpm staff:add` | **the main win** |
| 9. Set a PIN | hand-written SQL | `/pin` screen | **win** |
| 10. Verify it worked | guess | guess | no verifier |
| 11. Recover from a mistake | nothing documented | nothing documented | "start over" undocumented |

**TTHW (real database): ~12 steps, 2 SQL pastes, 3 dashboard copy-pastes → target ≤ 2 commands.** Demo-mode TTHW is already ~2 minutes and is the product's best DX asset.

### Accepted DX decisions

| # | Decision | Why |
|---|---|---|
| X-1 | **Split `seed.sql` into `seed-samples.sql` (catalogue only, no shop row) and stop shipping CSL's shop row in the repo.** | Verified: `seed.sql:4` hard-codes CSL's real name, address, phone, `invoice_prefix 'CSLINV'` and `next_invoice 1790`. The plan's rule "if the project has exactly one shop, use it" therefore binds *every* future shop to CSL's identity and invoice sequence. It also breaks the ground rule "Never hard-code anything about CSL". |
| X-2 | **Add `pnpm shop:init`** (prompts name, address, phone, invoice prefix, starting number; `--with-samples` opt-in for the sample catalogue). | P0 shipped a staff CLI with nothing to attach staff to. This is the missing half, and it is what makes shop #2 possible without a phone call. |
| X-3 | **Add `pnpm doctor`.** Checks: both public env vars present and well-formed; URL reachable; anon key accepted; service-role key present and **not** under a `NEXT_PUBLIC_` name; migration applied (probe that `complete_sale` exists); ≥1 shop; ≥1 owner with a PIN; ≥1 product. One line per check, each failure carrying its fix. | Lines 15–27 of this plan are a hand-built diagnosis of exactly this, done by hand against the live project and unrepeatable by anyone else. `supabase status`, `prisma validate` and `vercel env pull` all exist for this reason. |
| X-4 | **Distinguish setup-time failures in the Supabase backend.** 401/403 → "The Supabase keys in .env.local were rejected. Check Project Settings → API." `42P01`/`PGRST` → "The database tables aren't there yet. Run supabase/migrations/… first." Keep the raw code in the default branch. | Verified: every failure currently collapses into "Couldn't load products. Check the internet." — and misconfiguration is the *normal* state during P0, so this is the one error message that matters most and is the least informative. |
| X-5 | **Treat a half-filled `.env.local` as a configuration error, not demo mode**, and add `NEXT_PUBLIC_DEMO_MODE=0` as a force-real override. | URL set + key blank currently drops a real setup silently into demo mode, where the login screen redirects away and the counter shows fake products. It looks like it works and wastes an afternoon. There is no way to force real mode and see the actual error. |
| X-6 | **Decide the password-reset story and write it in both places.** A second `staff:add` run with `--password` (or a generated one) resets the auth password and prints it once. State that the manager PIN does **not** reset with it. | My own plan contradicted itself: "not in scope — owner re-runs `staff:add`" versus "a second run updates name/role/limit" (password pointedly absent). A 4-staff shop hits this in week one. |
| X-7 | **CLI naming and modes.** `--discount-limit` (accept `5` and `5%`) instead of the ambiguous `--limit`; `--password-stdin` instead of `--password`; `--shop` accepts a case-insensitive name *or* a UUID, plus `--list-shops`; validate `--role` against `owner\|manager\|cashier` with a did-you-mean; add `--yes`, `--dry-run`, `--json`. Print the project host and shop name and require confirmation before writing. | `--limit` matches neither the column (`discount_limit_pct`) nor the UI ("discount limit (%)"). `--password` on argv directly contradicts the plan's own goal of keeping passwords out of shell history. A shop owner will not paste a UUID. And nothing currently guards against pointing a service-role key at the wrong shop's project. |
| X-8 | **Make the sample data idempotent** (`on conflict do nothing`) and document "start over". | `seed.sql` says "safe to run once"; run it twice and you get a raw duplicate-key error. "How do I reset a botched setup" is the single most common newcomer need and is undocumented. |
| X-9 | **Fix `.env.example` and the README to match string-for-string.** Redacted example shapes for all three vars, the exact dashboard location **including the legacy-key tab**, and a one-line reason the service-role key never takes a `NEXT_PUBLIC_` prefix. | Current Supabase dashboards lead with publishable/secret keys (`sb_publishable_…` / `sb_secret_…`) alongside the legacy anon/service_role JWTs, so a reader hunting for "anon key" on a 2026-vintage project may not find that label. Every later step depends on getting these three strings right. **Confirm against the live dashboard while writing this.** |
| X-10 | **Resolve the README's dead Supabase-CLI branch.** Either `supabase init` + commit `config.toml` + add the CLI as a devDependency and make `supabase db push` the documented path, or delete the sentence. Make the real-database section standalone (numbered, includes `pnpm install`). | `README.md:39` offers `supabase link` / `supabase db push`; there is no `config.toml` and no `supabase` devDependency, so that path fails for anyone who picks it. The original P0 only added a staff section, leaving the broken branch in place. |
| X-11 | **Add `engines.node`, `packageManager`, `.nvmrc`**, and state how the CLI loads `.env.local`. | D1 contemplated a runner whose availability depends on an unstated local Node version. This machine is Node 24.18.0 / pnpm 12.14.0 and nothing records that. |
| X-12 | **Write the exact terminal transcript** (command + its real output) into the README, plus a Troubleshooting section covering "signed in but see 'not linked to a shop'", "products won't load", and "it went into demo mode and I didn't want it". Add `/pin` to the feature list. | The plan said the script "prints what it did" without specifying the shape, so the README could not show it. Troubleshooting is where X-4 and X-5 get paid off. |
| X-13 | **Script naming consistency:** `db:test` + `staff:add` + `shop:init` + `doctor`. Note the convention in CLAUDE.md. | Existing `test:db` is verb:noun while `staff:add` is noun:verb. Pick one before there are twelve of them. |

### Declined

**One `pnpm setup` wizard that does everything** (writes `.env.local`, applies the migration, creates the shop and first owner). Attractive, and the right end state — but it needs the Supabase CLI or Management API to apply a migration programmatically, which is a new dependency and a new auth story. `shop:init` + `doctor` + a numbered README get TTHW most of the way down for a fraction of the risk. → **TODOS.md → P18**, where self-signup lives anyway.

**Docker Compose Postgres for `pnpm test:db`.** Right answer long-term; today E-12's guard makes the existing script safe, and `psql` is already present. → **TODOS.md → P17.**

### DX scorecard

| Dimension | Before P0 | After P0 as planned | After P0 + accepted |
|---|---|---|---|
| 1. Getting started / TTHW | 3 | 5 | **8** |
| 2. CLI/API ergonomics | 1 (no CLI) | 6 | **8** |
| 3. Error messages | 2 | 3 | **8** |
| 4. Documentation | 4 | 5 | **8** |
| 5. Recovery / upgrade path | 1 | 2 | **7** |
| 6. Dev environment | 3 (`test:db` broken) | 3 | **8** |
| 7. Observability for the setter-upper | 1 | 1 | **8** (`doctor`) |
| 8. Escape hatches | 3 | 4 | **7** |
| **Overall** | **2.3** | **3.6** | **7.8** |

TTHW: ~12 steps → **~4 steps and 2 commands** (`pnpm shop:init --with-samples`, `pnpm staff:add`, `pnpm doctor`, plus the unavoidable project creation and key copy).

### Developer empathy narrative (first person, shop #2, after the accepted changes)

> I create a Supabase project, paste one migration, copy three keys into `.env.local`. I run `pnpm doctor` and it tells me the anon key is fine but there is no shop yet — and tells me the command. `pnpm shop:init --with-samples` asks me my shop's name and what invoice number to start at, and makes it mine, not some other shop in Dhaka. `pnpm staff:add` creates my manager and prints their password once. `pnpm doctor` goes all green except "no owner has set an approval PIN", so I sign in, set one, and the screen tells me where I will use it. Total: four commands, and at every point something told me what was wrong and what to type next.

That is the version that survives being handed to someone who is not Wasif.

---

# CROSS-PHASE THEMES

Concerns that surfaced independently in two or more phases. Independent convergence is the strongest signal in this review.

**Theme 1 — Demo mode is fail-open, and P0 was about to harden the hole into middleware.**
Flagged in Phase 1 (premise 6), Phase 3 (critical), and Phase 3.5 (X-5). Three voices from three angles. `isDemoMode` is true whenever the Supabase keys are *absent*, `NEXT_PUBLIC_*` is inlined at **build** time, and the first `routeFor()` rule was "demo mode → never redirect". A Vercel build that does not expose those vars to the build step therefore ships a bundle that serves `/counter` to the open internet. Nothing fails loudly. **→ E4 + X-5: demo requires explicit opt-in; production without keys is a hard error.**

**Theme 2 — The manager PIN is the feature the product is sold on, and it controls almost nothing.**
Flagged in Phase 1 (Section 3), Phase 2 (D-16, weak PINs), Phase 3 (E-3, E-4), and by the CEO voice independently. Verified by experiment: brute-forceable with **zero trace**, `1234` permitted, the approving manager recorded arbitrarily, and failures structurally impossible to log where the check currently lives. **→ E-3 + E-4 + D-16.** Four phases converging on one mechanism is why this is no longer a cherry-pick.

**Theme 3 — Every error says the wrong thing, and P0 is when real people first meet them.**
Flagged in Phase 1 (Section 2, four GAPs), Phase 2 (D-13), Phase 3 (E-10), Phase 3.5 (X-4). One string covers four causes on the login page; `friendlyError()`'s default blames the internet for three unmapped codes; the Supabase backend blames the internet for a wrong key. **→ D-13 + E-10 + X-4.**

**Theme 4 — `seed.sql` plants CSL's identity in every install and burns invoice 1790.**
Flagged by the CEO voice, the eng voice and the DX voice, independently — and it is the real answer to open decision D2. **→ X-1 + User Challenge 2.**

**Theme 5 — An internet blip must not look like a sign-out.**
Phase 1 (premise 3, E3, the DAY-2 scenario) and Phase 3 (E-5) reached this separately, with the eng voice adding the detail that makes it worse: the cart is in an unpersisted Zustand store, so the bounce destroys a sale in front of a customer. **→ E-5.**

---

# Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected alternative |
|---|---|---|---|---|---|---|
| 1 | CEO | Mode = SELECTIVE EXPANSION | Mechanical | P1+P2 | autoplan's CEO-phase default | HOLD, REDUCTION |
| 2 | CEO | Approach A (middleware + server client) | Mechanical | P1 | 9/10 vs 6/10 vs 3/10 — not close | B (server-layout guard), C (client-only) |
| 3 | CEO | Accept premises 1 and 4; reject 2 and 6; flag 3 and 5 | Mechanical | P6 | 2 and 6 falsified by probing the live project and reading the code | blanket acceptance |
| 4 | CEO | E2 login error granularity → IN | Mechanical | P1 | Prime Directive 1, zero silent failures | defer |
| 5 | CEO | E3 middleware auth-unreachable pass-through → IN | Mechanical | P1 | correctness of the thing being built | defer |
| 6 | CEO | E4 demo mode fail-closed → IN | Mechanical | P1 | security-adjacent, ~10 lines | defer |
| 7 | CEO | E5 empty-catalogue state → IN | Mechanical | P2 | it is the live DB's state right now | defer |
| 8 | CEO | E6 fix `test:db` role collision → IN | Mechanical | P2 | ground rules require it to pass; it cannot today | defer |
| 9 | CEO | E7 `staff:add --list/--deactivate` → IN | Mechanical | P2 | same file, week-1 event | defer |
| 10 | CEO | E8 session-expired message → IN | Mechanical | P1 | the counter's worst moment | defer |
| 11 | CEO | E9 move `supabaseBrowser()` → IN | Mechanical | P5 | symmetry with the new `server.ts`, 3 files | leave in the adapter |
| 12 | CEO | E11 Playwright E2E → DEFER (P17) | Mechanical | P2 | new infra, outside blast radius, >1 day | include now |
| 13 | CEO | CEO voice's business findings (pricing, IP, validation, BMS-overlay reframe) → OUT of scope, 2 flagged at the gate | Mechanical | scope | the user asked for P0; these are theirs to decide, not mine to impose | fold into P0 |
| 14 | Verify | Test every load-bearing claim before accepting it | Mechanical | P5 | 3 of 13 claims were wrong or overstated | accept all voices verbatim |
| 15 | Design | D-1 render a card, do not redirect cashiers | Mechanical | P5 | my plan had two contradictory guards | pick one redirect |
| 16 | Design | D-2 `/pin` gets its own error mapper | Mechanical | P1 | verified: `friendlyError` default says a *sale* failed | reuse `friendlyError` |
| 17 | Design | D-3..D-7, D-19 PIN screen states and mechanics | Mechanical | P1 | four unspecified states on a new screen | leave to the implementer |
| 18 | Design | D-4 add `hasPin()` | Mechanical | P1 | screen otherwise reads "Set my PIN" forever | ship write-only |
| 19 | Design | D-8..D-10 shared `NoShopCard`, email shown, Try again | Mechanical | P4 | two routes, identical state, would drift | counter only |
| 20 | Design | D-11 skip the header link, surface at the point of need | **Taste** | P5 | header already wraps at 390px; but reasonable people differ | header text link |
| 21 | Design | D-15 rename to "Approval PIN", route `/pin` | **Taste** | P5 | route strings outlive plans; "PIN" is ambiguous in Dhaka | keep `/set-pin` |
| 22 | Design | D-16 weak-PIN guard | Mechanical | P1 | verified `set_pin()` accepts `1234` | length only |
| 23 | Design | D-17 demo staff becomes an owner | Mechanical | P1 | verified: demo `/pin` is otherwise unreachable, and demo is the sales demo | leave as cashier |
| 24 | Design | Focus-ring contrast → DEFER | Mechanical | P2 | global token; would restyle every existing screen | fix in P0 |
| 25 | Eng | E-1 `setAll(cookies, headers)`, per-request client | Mechanical | P1 | verified in 0.12.7 types; CDN cross-user session leak | cookies only |
| 26 | Eng | E-2 drop role/limit/active from the staff UPDATE grant | Mechanical | P1 | **verified by experiment**; defeats the product's core control | leave as is |
| 27 | Eng | E-3 `verify_manager_pin()` in its own transaction | Mechanical | P1 | **verified**: failures are structurally unloggable where the check lives | accept the risk to P17 |
| 28 | Eng | E-4 name the approving manager | Mechanical | P1 | `limit 1` with no `order by` can name the wrong person | keep as is |
| 29 | Eng | E-5 `signedIn: true\|false\|"unknown"`, deny-by-default | Mechanical | P1 | a boolean cannot say "couldn't tell" | boolean + allowlist |
| 30 | Eng | E-6 one `current_staff()` RPC | Mechanical | P3 | verified `select *` → 42501; also 3 round trips → 1 | patch the column list |
| 31 | Eng | E-7 extract `classifyStaffLookup()` | Mechanical | P1 | my own test plan was vacuous | test via demo only |
| 32 | Eng | E-8 `email_confirm: true` | Mechanical | P1 | otherwise every created login silently cannot sign in | rely on the default |
| 33 | Eng | E-9 page `listUsers()`; `--move` guard | Mechanical | P1 | silent cross-shop move corrupts sales attribution | naive upsert |
| 34 | Eng | E-10 map all codes + grep test | Mechanical | P1 | verified 3 pre-existing gaps | add 2 codes only |
| 35 | Eng | E-11 wrap RLS helpers in a subselect | Mechanical | P2 | mechanical now, much cheaper before P1 | leave to P12 |
| 36 | Eng | E-12 guard the stub roles + Supabase-cluster refusal | Mechanical | P2 | `test:db` is broken on this machine today | leave broken |
| 37 | Eng | E-13..E-15 RSC try/catch, `getAll`/`setAll`, sign-out nav, empty serials | Mechanical | P1 | named failure modes, each a few lines | skip |
| 38 | Eng | shop-row lock, `reset_pin`, Backend split, pagination, sale-duration → DEFER | Mechanical | P2 | outside blast radius or P1 churns the same files | include now |
| 39 | DX | X-1 split `seed.sql`, stop shipping CSL's shop row | Mechanical | P4 | verified; also breaks the ground rule about CSL | keep one seed |
| 40 | DX | X-2 `pnpm shop:init` | Mechanical | P1 | P0 shipped a staff CLI with nothing to attach staff to | leave to P18 |
| 41 | DX | X-3 `pnpm doctor` | **Taste** | P1 | turns an unrepeatable hand diagnosis into a command; but it is a new surface beyond P0's 6 items | defer to P17 |
| 42 | DX | X-4..X-5 setup-time error granularity, half-filled env is an error | Mechanical | P1 | misconfiguration is the *normal* state during P0 | generic messages |
| 43 | DX | X-6 decide the password-reset story | Mechanical | P1 | my plan contradicted itself | leave contradictory |
| 44 | DX | X-7 CLI naming and non-interactive modes | Mechanical | P5 | `--password` on argv contradicted the plan's own goal | ship as drafted |
| 45 | DX | X-8..X-13 idempotent samples, reset docs, `.env.example`, README dead branch, engines, transcript, naming | Mechanical | P1 | each is a named, small, documented gap | partial |
| 46 | DX | One `pnpm setup` wizard → DEFER (P18) | Mechanical | P3 | needs the Supabase CLI/Management API — new dependency and auth story | build now |
| 47 | DX | Docker Postgres for `test:db` → DEFER (P17) | Mechanical | P3 | E-12's guard makes the current script safe; psql is present | build now |
| 48 | All | D1 runner = `tsx` | Mechanical | P3 | all three technical voices converged; `node --experimental-strip-types` resolves no `@/` aliases, so the script could not import `src/lib` | strip-types |

**48 decisions: 45 auto-decided, 3 taste (#20, #21, #41), 2 user challenges (below).**

---

# REVISED SCOPE

### Work (final)

1. **Auth plumbing** — `lib/env.ts` (fail-closed demo), `lib/supabase/client.ts` + `server.ts` (per-request, `setAll(cookies, headers)`, RSC try/catch), `lib/auth-route.ts` (`routeFor` with `"unknown"`, deny-by-default, `?next=`), `src/middleware.ts`.
2. **One additive migration** — `verify_manager_pin()`, `has_pin()`, `current_staff()`, owner-only audited `set_staff_role_and_limit()`, tighten the `staff` UPDATE grant, weak-PIN rejection in `set_pin()`, RLS helpers wrapped in subselects, empty-serial rejection.
3. **Staff lookup** — `classifyStaffLookup()` pure fn, injectable client, shared `NoShopCard`.
4. **`/pin` screen** — all states per D-1..D-7, D-15..D-19.
5. **CLI** — `pnpm shop:init`, `pnpm staff:add` (per X-7, E-8, E-9), `pnpm doctor` (pending taste #41).
6. **Errors** — login granularity, all SQL codes mapped + grep test, setup-time error granularity.
7. **Seed split** — `seed-samples.sql`, no CSL shop row, idempotent.
8. **Toolchain** — fix `test:db`, add `tsx`, `engines`, `packageManager`, `.nvmrc`.
9. **Docs** — README real-database section, troubleshooting, terminal transcript, `.env.example`.

### Done when (revised)

1. `pnpm doctor` reports every check green on a fresh project set up from the README alone.
2. `pnpm shop:init` creates a shop that is **not** CSL's, with its own prefix and starting number.
3. `pnpm staff:add` creates an owner and a cashier who can **both actually sign in** (email confirmed).
4. Cashier sells 2 Vention splitters for ৳1,000 cash; the `sales` row shows total 1000 and an invoice of `<prefix><year><the shop's next_invoice before the sale>` — **not** a hard-coded string, so a correct system cannot fail its own test.
5. Owner sets a PIN at `/pin`, and that PIN approves a 10% discount, with the approval **and the approver's identity** in `audit_log`.
6. **Three wrong PIN attempts appear in `audit_log`** and the fourth is refused.
7. **A manager cannot** raise their own discount limit, promote themselves, or deactivate the owner — and each attempt is logged.
8. A signed-in user with no staff row sees the `NoShopCard` naming their email, with Try again and Sign out.
9. Pulling the network for 30 s with a half-built sale does **not** bounce to `/login` and does **not** lose the lines.
10. A production build with missing keys fails loudly; it does not serve an open demo POS.
11. Checked by hand at 390×670 with the keyboard open: `/login`, `/pin`, `NoShopCard`.
12. Signed in as the real cashier in the browser console: `select pin_hash from staff` → permission denied; `product_costs` → 0 rows; `audit_log` → 0 rows.
13. `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:db` all pass.

### Effort

| | Human | CC |
|---|---|---|
| Base P0 as originally written | ~1.5 days | ~35 min |
| + 7 CEO expansions | ~1 day | ~20 min |
| + 19 design decisions | ~1.5 days | ~25 min |
| + 15 eng decisions (incl. migration) | ~2.5 days | ~45 min |
| + 13 DX decisions | ~1.5 days | ~30 min |
| **Total** | **~8 days** | **~2.5 hours** |

---

# APPROVAL GATE

## User Challenge 1 — RESOLVED

**You said:** P0 is auth + CLI + PIN screen. "No new migration needed for P0."

**Both voices and my own verification said:** P0 must ship a migration.

**Your decision: all of it — one additive migration in P0.** Approved 2026-10-17.
Scope is the "REVISED SCOPE" section above. The two holes that forced this:
- a manager can raise their own discount limit to 100%, promote themselves to owner, and
  deactivate the owner, with zero audit rows (tested);
- failed manager-PIN attempts leave no trace at all and cannot be logged where the check
  currently lives, because the exception rolls the audit insert back (tested).

P0's rollback posture therefore moves from 5/5 to 4/5 — the migration is additive
(functions + grant changes, no table changes), so it is still zero-downtime.

## User Challenge 2 — RESOLVED

**Approved:** the current Supabase project is **test-only**; a fresh production project
gets created for the store later. `seed.sql` becomes a generic **"Demo Shop"** with no CSL
details, no `CSLINV` prefix and `next_invoice 1`. Invoice 1790 is never burned, and the
repo stops hard-coding CSL (ground rule honoured).

## Taste decisions — RESOLVED

- **#20** — `/pin` is surfaced **at the point of need** (the counter's manager-PIN box when
  no PIN is set) **plus a link in the profile menu**. Not in the header.
- **#21** — renamed **"Approval PIN"**, route **`/pin`**.
- **#41** — `pnpm doctor` is **in P0**.

## Security fixes — SCOPE CONFIRMED

- Staff role/limit/active changes are **owner-only**, **cannot touch your own row**, and are
  **all logged**.
- Failed manager-PIN attempts are **logged**, and an approver is **locked out after 5 wrong
  tries within 10 minutes**.

## Flagged, outside P0, yours to decide

- No written IP/ownership agreement with CSL management.
- Nobody has validated that a second shop wants this, yet multi-branch scope assumes it.
