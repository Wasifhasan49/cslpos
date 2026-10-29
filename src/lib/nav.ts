import type { Role } from "./types";

/**
 * Who sees which section. Kept as data, and as a pure function, so the rules can be
 * tested and so the server guard and the menu can never disagree — a menu that hides
 * a page the server still serves is not security, and a server that blocks a page the
 * menu offers is just confusing.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Short label for the phone tab bar, where there is no room. */
  short: string;
  icon: IconName;
  roles: readonly Role[];
  /** Shown in the phone tab bar (cashiers get at most 3 items there). */
  tab?: boolean;
  /** Hidden until the shop turns this feature on, so a small shop sees a simple app. */
  feature?: string;
}

export type IconName =
  | "counter" | "sales" | "warranty" | "stock" | "purchases" | "transfers"
  | "products" | "customers" | "suppliers" | "cash" | "dashboard" | "accounts"
  | "reports" | "orders" | "settings";

const EVERYONE: readonly Role[] = ["owner", "manager", "cashier"];
const MANAGERS: readonly Role[] = ["owner", "manager"];
const OWNERS: readonly Role[] = ["owner"];

export const NAV: readonly NavItem[] = [
  // Everyone. These three are the cashier's whole app, so they are the phone tabs.
  { href: "/counter",   label: "Counter",   short: "Counter",  icon: "counter",   roles: EVERYONE, tab: true },
  { href: "/sales",     label: "Sales",     short: "Sales",    icon: "sales",     roles: EVERYONE, tab: true },
  { href: "/warranty",  label: "Warranty",  short: "Warranty", icon: "warranty",  roles: EVERYONE, tab: true },
  // Managers and owners.
  { href: "/stock",     label: "Stock",     short: "Stock",    icon: "stock",     roles: MANAGERS },
  { href: "/purchases", label: "Purchases", short: "Buy",      icon: "purchases", roles: MANAGERS, feature: "purchase_orders" },
  { href: "/transfers", label: "Transfers", short: "Moves",    icon: "transfers", roles: MANAGERS, feature: "transfers" },
  // Quote, order, deliver, bill — for shops that sell to companies. Off by default,
  // because a shop that sells over the counter has no use for a quotation.
  { href: "/orders",    label: "Orders",    short: "Orders",  icon: "orders",    roles: MANAGERS, feature: "sales_documents" },
  { href: "/products",  label: "Products",  short: "Items",    icon: "products",  roles: MANAGERS },
  { href: "/customers", label: "Customers", short: "People",   icon: "customers", roles: MANAGERS },
  { href: "/suppliers", label: "Suppliers", short: "Supply",   icon: "suppliers", roles: MANAGERS },
  // The drawer check. Cashiers open and close their own till on the counter screen;
  // what it SHOULD have held is deliberately not theirs to see.
  { href: "/cash",      label: "Cash drawer", short: "Cash",   icon: "cash",      roles: MANAGERS },
  // Owners, and managers only if the owner turns the flag on.
  // Reports are for whoever keeps the books, which in a small shop is the owner and in
  // a bigger one a manager. No feature switch: a shop that cannot see what it sold
  // yesterday has no reason to use any of this.
  { href: "/reports",   label: "Reports",   short: "Reports", icon: "reports",   roles: MANAGERS },
  { href: "/dashboard", label: "Dashboard", short: "Today",    icon: "dashboard", roles: OWNERS },
  { href: "/accounts",  label: "Accounts",  short: "Books",    icon: "accounts",  roles: OWNERS, feature: "accounts" },
  { href: "/settings",  label: "Settings",  short: "Setup",    icon: "settings",  roles: OWNERS },
] as const;

/**
 * Settings flags that let an owner share owner-only sections with their managers.
 * Off by default, so a small shop sees a simple app.
 */
export interface ShopFlags {
  managersSeeDashboard?: boolean;
  managersSeeAccounts?: boolean;
  managersSeeSettings?: boolean;
}

const FLAG_FOR: Partial<Record<string, keyof ShopFlags>> = {
  "/dashboard": "managersSeeDashboard",
  "/accounts": "managersSeeAccounts",
  "/settings": "managersSeeSettings",
};

/**
 * Can this role open this path?
 *
 * `features` is which features the shop has switched on. A section whose feature is off
 * is hidden from everyone, including the owner, because turning the feature on is the
 * way to get it back — the menu is not where that decision lives.
 */
export function canSee(
  path: string, role: Role, flags: ShopFlags = {}, features?: Record<string, boolean>,
): boolean {
  const item = NAV.find((n) => n.href === path || path.startsWith(`${n.href}/`));
  if (!item) return true; // not a nav section (e.g. /pin); other guards apply
  if (item.feature && features && !features[item.feature]) return false;
  if (item.roles.includes(role)) return true;
  if (role === "manager") {
    const flag = FLAG_FOR[item.href];
    if (flag && flags[flag]) return true;
  }
  return false;
}

export function navFor(
  role: Role, flags: ShopFlags = {}, features?: Record<string, boolean>,
): NavItem[] {
  return NAV.filter((n) => canSee(n.href, role, flags, features));
}

/**
 * The phone tab bar. Cashiers get at most 3, so the bar stays thumb-sized; managers
 * and owners get 4 plus a More menu for the rest.
 */
export function tabsFor(
  role: Role, flags: ShopFlags = {}, features?: Record<string, boolean>,
): NavItem[] {
  const allowed = navFor(role, flags, features);
  if (role === "cashier") return allowed.filter((n) => n.tab).slice(0, 3);
  const tabs = allowed.filter((n) => n.tab);
  const extra = allowed.filter((n) => !n.tab);
  return [...tabs, ...extra].slice(0, 4);
}

/** Sections that don't fit in the tab bar, for the More menu. */
export function overflowFor(
  role: Role, flags: ShopFlags = {}, features?: Record<string, boolean>,
): NavItem[] {
  const shown = new Set(tabsFor(role, flags, features).map((n) => n.href));
  return navFor(role, flags, features).filter((n) => !shown.has(n.href));
}

/** A plain-English reason, for the redirect message when someone opens a page they
 *  may not see. The UI hides it and the server repeats it; RLS is the real guard. */
export function noAccessMessage(path: string, role: Role): string {
  const item = NAV.find((n) => n.href === path || path.startsWith(`${n.href}/`));
  const what = item ? item.label.toLowerCase() : "that page";
  if (role === "cashier") return `${what} is for managers and owners. Ask the owner if you need it.`;
  return `${what} is for the owner. Ask the owner if you need it.`;
}
