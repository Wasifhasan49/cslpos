import { afterEach, describe, expect, it, vi } from "vitest";

/** env.ts reads process.env once at import, so each case needs a fresh module. */
async function loadEnv(vars: Record<string, string | undefined>, nodeEnv = "development") {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", nodeEnv as "development" | "production" | "test");
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_DEMO_MODE"]) {
    vi.stubEnv(key, vars[key] ?? "");
  }
  return import("./env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const KEYS = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
};

describe("demo mode is opt-in", () => {
  // This is the one that mattered: demo mode used to turn on whenever the keys were
  // MISSING. A production deploy with one forgotten environment variable therefore
  // served an open, sign-in-free counter backed by sample data — and looked like it
  // was working while saving nothing.
  it("a production build with no keys fails loudly instead of serving sample data", async () => {
    const env = await loadEnv({}, "production");
    expect(env.isDemoMode).toBe(false);
    expect(env.configError()).toMatch(/No Supabase keys are set/);
  });

  it("no keys in development still just works, so `pnpm dev` needs no setup", async () => {
    const env = await loadEnv({}, "development");
    expect(env.isDemoMode).toBe(true);
    expect(env.configError()).toBe("");
  });

  it("demo mode can be asked for explicitly, even in production", async () => {
    const env = await loadEnv({ NEXT_PUBLIC_DEMO_MODE: "1" }, "production");
    expect(env.isDemoMode).toBe(true);
    expect(env.configError()).toBe("");
  });

  it("real keys mean the real database, in either environment", async () => {
    for (const mode of ["development", "production"]) {
      const env = await loadEnv(KEYS, mode);
      expect(env.isDemoMode).toBe(false);
      expect(env.hasSupabaseKeys).toBe(true);
      expect(env.configError()).toBe("");
    }
  });

  it("DEMO_MODE=0 forces the real backend, so the actual error is visible", async () => {
    // Without this there was no way to say "don't quietly hand me fake products".
    const env = await loadEnv({ NEXT_PUBLIC_DEMO_MODE: "0" }, "development");
    expect(env.isDemoMode).toBe(false);
  });
});

describe("a half-filled .env.local is an error, not sample data", () => {
  it("names the empty one, because the symptom otherwise looks like success", async () => {
    const urlOnly = await loadEnv({ NEXT_PUBLIC_SUPABASE_URL: KEYS.NEXT_PUBLIC_SUPABASE_URL });
    expect(urlOnly.hasPartialSupabaseKeys).toBe(true);
    expect(urlOnly.isDemoMode).toBe(false);
    expect(urlOnly.configError()).toMatch(/ANON_KEY is empty/);

    const keyOnly = await loadEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" });
    expect(keyOnly.configError()).toMatch(/URL is empty/);
  });

  it("whitespace counts as empty", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: KEYS.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "   ",
    });
    expect(env.hasSupabaseKeys).toBe(false);
    expect(env.configError()).toMatch(/ANON_KEY is empty/);
  });
});
