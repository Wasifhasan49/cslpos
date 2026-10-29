"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight, BookOpenCheck, Boxes, ChevronDown, Check, ClipboardList, FileText, KeyRound,
  LayoutDashboard, LogOut, MoreHorizontal, Package, Receipt, Settings, ShieldCheck,
  ShoppingCart, Store, Truck, Users, Wallet,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { navFor, overflowFor, tabsFor, type IconName } from "@/lib/nav";
import { cn } from "@/lib/utils";

const ICONS: Record<IconName, React.ComponentType<{ className?: string }>> = {
  counter: ShoppingCart,
  sales: Receipt,
  warranty: ShieldCheck,
  stock: Boxes,
  purchases: Truck,
  transfers: ArrowLeftRight,
  products: Package,
  customers: Users,
  suppliers: Store,
  cash: Wallet,
  dashboard: LayoutDashboard,
  accounts: BookOpenCheck,
  reports: FileText,
  orders: ClipboardList,
  settings: Settings,
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { staff, features, branch, branches, setBranch, backend } = useStaff();
  const path = usePathname();
  // The settings flags that share owner-only sections with managers live alongside the
  // feature switches, so they come from the same map.
  const flags = {
    managersSeeDashboard: features.managers_see_dashboard,
    managersSeeAccounts: features.managers_see_accounts,
    managersSeeSettings: features.managers_see_settings,
  };
  const items = navFor(staff.role, flags, features);
  const tabs = tabsFor(staff.role, flags, features);
  const overflow = overflowFor(staff.role, flags, features);

  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-ink text-white">
        {/* Top row: who and where. Kept to one line on a phone. */}
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold">
              {staff.shopName.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold leading-tight">{staff.shopName}</span>
              <BranchSwitcher branch={branch} branches={branches} onPick={setBranch} />
            </div>
            {backend.mode === "demo" && (
              <span className="hidden rounded-full bg-focus px-2.5 py-0.5 text-xs font-semibold text-ink sm:inline">
                Demo · nothing is saved
              </span>
            )}
          </div>
          <ProfileMenu />
        </div>

        {/* Desktop section bar. The phone gets the tab bar at the bottom instead. */}
        <nav aria-label="Sections" className="hidden border-t border-white/10 sm:block">
          <div className="mx-auto flex w-full max-w-[1480px] gap-1 overflow-x-auto px-4 sm:px-6">
            {items.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active(item.href) ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
                    active(item.href)
                      ? "border-focus text-white"
                      : "border-transparent text-[#c9d2cc] hover:text-white",
                  )}
                >
                  <Icon className="size-4" aria-hidden /> {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      {/* pb-20 leaves room for the phone tab bar, which is fixed. */}
      <div className="flex flex-1 flex-col pb-20 sm:pb-0">{children}</div>

      <nav
        aria-label="Sections"
        className="fixed bottom-0 left-0 right-0 z-30 flex border-t border-line bg-surface sm:hidden"
      >
        {tabs.map((item) => {
          const Icon = ICONS[item.icon];
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active(item.href) ? "page" : undefined}
              className={cn(
                "flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
                active(item.href) ? "text-brand" : "text-muted",
              )}
            >
              <Icon className="size-5" aria-hidden />
              {item.short}
            </Link>
          );
        })}
        {overflow.length > 0 && <MoreTabs items={overflow} active={active} />}
      </nav>
    </div>
  );
}

function BranchSwitcher({
  branch, branches, onPick,
}: {
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  // One branch is the common case (CSL has one), so there is nothing to switch and a
  // dropdown would just be chrome.
  if (branches.length < 2) {
    return <span className="truncate text-[13px] text-[#c9d2cc]">{branch.name}</span>;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-1 rounded text-[13px] text-[#c9d2cc] hover:text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="truncate">{branch.name}</span>
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <ul role="listbox" className="absolute left-0 z-20 mt-1 flex w-56 flex-col overflow-hidden rounded-lg border border-line bg-surface py-1 text-ink shadow-lg">
            {branches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={b.id === branch.id}
                  onClick={() => { onPick(b.id); setOpen(false); }}
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-[15px] hover:bg-subtle"
                >
                  {b.name}
                  {b.id === branch.id && <Check className="size-4 text-brand" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function MoreTabs({
  items, active,
}: {
  items: { href: string; label: string; icon: IconName }[];
  active: (href: string) => boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const anyActive = items.some((i) => active(i.href));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className={cn(
          "flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
          anyActive ? "text-brand" : "text-muted",
        )}
      >
        <MoreHorizontal className="size-5" aria-hidden />
        More
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-end bg-ink/40" onClick={() => setOpen(false)}>
          <div
            className="flex w-full flex-col rounded-t-2xl bg-surface p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-14 items-center gap-3 rounded-lg px-3 text-[15px] hover:bg-subtle"
                >
                  <Icon className="size-5 text-muted" aria-hidden /> {item.label}
                </Link>
              );
            })}
            <Button variant="outline" size="lg" className="mt-2" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      )}
    </>
  );
}

function ProfileMenu() {
  const { staff, backend } = useStaff();
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-white/10 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-[#2c3a34] text-xs font-semibold">
          {staff.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden sm:inline">
          {staff.name} · <span className="capitalize">{staff.role}</span>
        </span>
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-20 mt-1 flex w-60 flex-col overflow-hidden rounded-lg border border-line bg-surface py-1 text-ink shadow-lg">
            <div className="px-3 py-2 text-[13px] text-muted sm:hidden">
              {staff.name} · <span className="capitalize">{staff.role}</span>
            </div>
            {staff.role !== "cashier" && (
              <Link href="/pin" role="menuitem" className="flex min-h-11 items-center gap-2.5 px-3 text-[15px] hover:bg-subtle">
                <KeyRound className="size-4 text-muted" aria-hidden />
                {staff.hasPin ? "Change approval PIN" : "Set approval PIN"}
              </Link>
            )}
            {backend.mode === "supabase" ? (
              <a href="/logout" role="menuitem" className="flex min-h-11 items-center gap-2.5 px-3 text-[15px] hover:bg-subtle">
                <LogOut className="size-4 text-muted" aria-hidden /> Sign out
              </a>
            ) : (
              <span className="px-3 py-2 text-[13px] text-muted">
                Demo mode · no sign-in, nothing is saved
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
