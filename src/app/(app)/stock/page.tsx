import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/stock");
  return (
    <SectionPlaceholder
      title="Stock"
      what="Receive goods from a supplier, write off damage, and count what is actually on the shelf."
      comingIn="P5"
    />
  );
}
