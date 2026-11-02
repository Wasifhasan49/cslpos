"use client";

import * as React from "react";
import { useStaff } from "@/components/staff-provider";
import { formatDay } from "@/lib/sale";
import { cn } from "@/lib/utils";

/**
 * The paper every printable lands on: one header, one footer, one set of table rules.
 *
 * Shops in this market judge a printout by whether it looks like the one they already
 * file, so the shape is copied from what BMS prints (docs/BMS_REPORTS.md section 2):
 * logo and shop name top left, the title bold and centred under it, bordered tables,
 * bold subtotals, and when it was printed at the foot. What is NOT copied is BMS's
 * mixed paper sizes, its US dates, its missing headers and the line naming the software
 * house — a shop's printout carries the shop's name, nobody else's.
 *
 * The header comes from the shop's own settings through `current_staff()`, which the
 * app has already asked for: a print button that needed a round trip of its own would
 * make every one of them slow. Nothing here is hard-coded to one shop.
 *
 * On screen it doubles as the preview, which is why `letterhead` can be turned off for
 * reports: they already name themselves in the panel above.
 */
export function PrintSheet({
  title, subtitle, aside, landscape, onScreen = true, footNote, by, children, className,
}: {
  /** Bold, underlined, centred — what this piece of paper is. */
  title: string;
  /** Under the title: the date range, the "as on" date, the branch. */
  subtitle?: React.ReactNode;
  /** Top right: the document number and its date, where there is one. */
  aside?: React.ReactNode;
  /** A wide report needs the long edge of the paper. */
  landscape?: boolean;
  /** Whether the letterhead shows on screen as well as on paper. A report panel and a
   *  document panel name themselves already, so theirs is print-only. */
  onScreen?: boolean;
  /** Anything that belongs under the content: terms, a signature line. */
  footNote?: React.ReactNode;
  /** Who this is printed by, when that is not simply whoever is at the screen — a
   *  report carries the name of whoever ran it. */
  by?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { staff, branch } = useStaff();
  const head = staff.letterhead;
  // The branch being worked in is the one whose address goes on the paper; the shop's
  // own address is the fallback for a shop that has not filled the branch in.
  const address = branch.address || head.address;
  const contact = [head.phone, head.email].filter(Boolean).join("  ·  ");

  return (
    <div className={cn("print-root text-ink", className)}>
      {landscape && <style>{"@page { size: A4 landscape; }"}</style>}

      <div className={cn("print-head", !onScreen && "hidden print:block")}>
        <div className="flex items-start justify-between gap-4 border-b-2 border-ink pb-2">
          <div className="flex items-start gap-3">
            {/* A data URL out of the shop's own settings, of a size nobody knows ahead
                of time: next/image would want a loader and a width. */}
            {head.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={head.logoUrl} alt="" className="print-logo h-12 w-auto object-contain" />
            )}
            <div>
              <p className="text-[17px] font-bold leading-tight">{head.shopName}</p>
              {address && <p className="text-[13px] leading-tight">{address}</p>}
              {contact && <p className="num text-[13px] leading-tight">{contact}</p>}
              {head.binVat && <p className="code text-[12px] leading-tight">BIN {head.binVat}</p>}
            </div>
          </div>
          {aside && <div className="shrink-0 text-right text-[13px]">{aside}</div>}
        </div>
        <div className="py-2 text-center">
          <h2 className="text-[15px] font-bold underline">{title}</h2>
          {subtitle && <p className="text-[13px]">{subtitle}</p>}
        </div>
      </div>

      {children}

      {footNote && <div className="pt-3 text-[13px]">{footNote}</div>}

      {/* Who printed it and when. Dhaka time and dd/mm/yyyy, like every other date on
          screen; the page number sits in the paper's bottom margin (globals.css). */}
      <div className="print-foot hidden pt-3 text-[9pt] print:block">
        Print Date &amp; Time: {printedAt()} · {by ?? staff.name}
      </div>
    </div>
  );
}

/** "02/11/2026 14:11" — the day as Dhaka has it, and the time of day with it. */
export function printedAt(at: Date = new Date()): string {
  const clock = at.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${formatDay(at)} ${clock}`;
}

/**
 * A printable table. Same markup on screen and on paper; the grid lines and the
 * repeated column headings are the print stylesheet's doing.
 */
export function PrintTable({ children, className }: {
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-[14px]", className)}>{children}</table>
    </div>
  );
}
