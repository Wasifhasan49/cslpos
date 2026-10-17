import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      ok: "bg-ok-bg text-ok-ink",
      low: "bg-warn-bg text-warn-ink",
      out: "bg-bad-bg text-bad-ink",
      info: "bg-info-bg text-info-ink",
      neutral: "bg-subtle text-ink-soft",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  className, tone, ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
