"use client";

import * as React from "react";
import { Printer, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { formatTaka } from "@/lib/sale";
import type { ChequePrint } from "@/lib/types";

/**
 * A cheque, laid out to print onto the bank's own leaf.
 *
 * Everything is positioned in millimetres from the top-left of the leaf, because that is
 * how a printed cheque has to work: the boxes are already on the paper. The positions
 * come from the shop's measurement of that bank's leaf; until somebody measures one, the
 * defaults are used and the screen says so.
 */
export function ChequePrintView({ chequeId, onClose, onFail }: {
  chequeId: string;
  onClose: () => void;
  onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [c, setC] = React.useState<ChequePrint | null>(null);

  React.useEffect(() => {
    let off = false;
    backend.chequePrint(chequeId)
      .then((r) => { if (!off) setC(r); })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, chequeId, onFail]);

  if (!c) return <p className="text-muted">Loading the cheque…</p>;

  const l = c.layout;
  // The words can be long enough to need a second line; the leaf has a second line for
  // exactly that reason, so it is split at a space rather than squeezed.
  const [words1, words2] = splitWords(c.amountWords);
  const at = (x: number, y: number): React.CSSProperties => ({
    position: "absolute", left: `${x}mm`, top: `${y}mm`, fontSize: `${l.fontPt}pt`,
  });

  return (
    <section className="rounded-xl border border-line bg-white p-3 print:border-0 print:p-0">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <h2 className="font-semibold">Cheque {c.chequeNo}</h2>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print
          </Button>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {!c.measured && (
        <p className="pt-2 text-[13px] text-muted print:hidden">
          Nobody has measured {c.bank ?? "this bank"}&rsquo;s cheque leaf yet, so the
          standard positions are being used. Print one on plain paper, hold it against a
          real leaf, and nudge the positions in Settings.
        </p>
      )}

      <div
        className="relative mt-3 overflow-hidden border border-dashed border-line-strong bg-white print:border-0"
        style={{ width: `${l.leafWidthMm}mm`, height: `${l.leafHeightMm}mm` }}
      >
        <span style={at(l.dateX, l.dateY)} className="num">{c.date}</span>
        <span style={at(l.payeeX, l.payeeY)}>{c.payee ?? ""}</span>
        <span style={at(l.words1X, l.words1Y)}>{words1}</span>
        {words2 && <span style={at(l.words2X, l.words2Y)}>{words2}</span>}
        <span style={at(l.figuresX, l.figuresY)} className="num">{formatTaka(c.amount)}</span>
      </div>
    </section>
  );
}

/** Two lines, split at a space near the middle rather than mid-word. */
function splitWords(words: string): [string, string | null] {
  if (words.length <= 46) return [words, null];
  const at = words.lastIndexOf(" ", 46);
  if (at <= 0) return [words, null];
  return [words.slice(0, at), words.slice(at + 1)];
}
