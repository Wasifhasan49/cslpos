# Build progress

One line per prompt from docs/BUILD_PROMPTS.md, newest at the bottom.

| Prompt | Status | Summary | What to test |
|---|---|---|---|
| P0 | done (not yet committed) | Real logins, staff/shop setup commands, Approval PIN with lockout, owner-only staff changes, 48 tests. Plan: docs/plans/P0-supabase-logins.md | Live sign-in once a Supabase project is connected (`pnpm check`) |

## Waiting on Wasif

- Supabase: the test project is paused. Create a new one (or restore), update
  .env.local, apply all migrations, then run `pnpm check`.
- Commit P0 (keep `reports_samples/` out of git).
- Before P14: Claude (chat) reviews reports_samples/ (~100 BMS report PDFs + 5 images)
  and writes docs/BMS_REPORTS.md. P14 and P16 should use that file, not the PDFs.
