import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/purchases");
  return (
    <SectionPlaceholder
      title="Purchases"
      what="Requisitions, purchase orders, receiving goods, and what you still owe each supplier."
      comingIn="P6"
    />
  );
}
