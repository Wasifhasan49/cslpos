import type { Branch, Letterhead, Role, Staff, StaffLookup } from "../types";

/** The shape current_staff() returns, or null when the login has no staff row. */
export interface CurrentStaffRow {
  staff_id: string;
  shop_id: string;
  name: string;
  role: string;
  discount_limit_pct: number | string;
  shop_name: string;
  has_pin: boolean;
  /** Added with the shared print layout. Absent on a login from before that
   *  migration ran, so the shop name alone has to be enough. */
  letterhead?: {
    shop_name?: string | null;
    logo_url?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    bin_vat?: string | null;
  } | null;
  branches: {
    id: string;
    name: string;
    code: string;
    address?: string | null;
    phone?: string | null;
    locations: { id: string; name: string; is_default: boolean }[];
  }[];
}

export interface LookupInput {
  /** The signed-in auth user, or null when there is no session. */
  user: { email?: string | null } | null;
  /** What current_staff() returned. */
  row: CurrentStaffRow | null;
}

/**
 * Turn an auth user plus a staff row into one of three outcomes.
 *
 * Pure on purpose: the two cases that matter — signed out, and signed in with no staff
 * row — only ever happen against a real database, so testing them through the demo
 * backend (which always has a staff member) would prove nothing.
 *
 * A failed query is NOT one of the outcomes. Callers throw instead, because collapsing
 * "the database is unreachable" into "signed out" bounces a signed-in cashier to the
 * login page over a network blip.
 */
export function classifyStaffLookup({ user, row }: LookupInput): StaffLookup {
  if (!user) return { kind: "signed-out" };
  if (!row) return { kind: "no-staff", email: user.email ?? null };

  const branches: Branch[] = (row.branches ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    code: b.code,
    address: b.address ?? null,
    phone: b.phone ?? null,
    locations: (b.locations ?? []).map((l) => ({ id: l.id, name: l.name, isDefault: l.is_default })),
  }));

  const head = row.letterhead ?? {};
  const letterhead: Letterhead = {
    shopName: head.shop_name ?? row.shop_name,
    logoUrl: head.logo_url ?? null,
    address: head.address ?? null,
    phone: head.phone ?? null,
    email: head.email ?? null,
    binVat: head.bin_vat ?? null,
  };

  const staff: Staff = {
    id: row.staff_id,
    name: row.name,
    role: row.role as Role,
    discountLimitPct: Number(row.discount_limit_pct),
    shopName: row.shop_name,
    letterhead,
    hasPin: Boolean(row.has_pin),
    branches,
  };
  return { kind: "ok", staff };
}
