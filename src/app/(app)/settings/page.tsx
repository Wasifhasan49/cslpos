import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import { guardSection } from "@/lib/guard";

const SECTIONS = [
  {
    href: "/settings/branches",
    title: "Branches and staff",
    what: "Add a branch, name its stock locations, and choose who works where.",
    ready: true,
  },
  { href: "/settings", title: "Shop details", what: "Name, address, logo, receipt footer, invoice prefix.", ready: false, comingIn: "P2" },
  { href: "/settings", title: "Units, tax and charges", what: "Units of measure, VAT rates, extra charges, discount reasons.", ready: false, comingIn: "P2" },
  { href: "/settings", title: "Payments", what: "Which payment methods this shop takes, card types, bank accounts.", ready: false, comingIn: "P2" },
  { href: "/settings", title: "Features", word: "", what: "Turn on only what this shop needs, so a small shop sees a simple app.", ready: false, comingIn: "P2" },
];

export default async function SettingsPage() {
  await guardSection("/settings");
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ul className="flex flex-col gap-2">
        {SECTIONS.map((s, i) => (
          <li key={i}>
            {s.ready ? (
              <Link
                href={s.href}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-surface px-4 hover:bg-subtle"
              >
                <Building2 className="size-5 shrink-0 text-muted" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{s.title}</span>
                  <span className="text-[13px] text-muted">{s.what}</span>
                </span>
                <ChevronRight className="ml-auto size-5 shrink-0 text-muted" aria-hidden />
              </Link>
            ) : (
              <div className="flex min-h-16 items-center gap-3 rounded-xl border border-dashed border-line-strong bg-subtle px-4">
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold text-ink-soft">{s.title}</span>
                  <span className="text-[13px] text-muted">{s.what} Being built in {s.comingIn}.</span>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
