import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/dashboard");
  return (
    <SectionPlaceholder
      title="Dashboard"
      what="Today's sales and profit, best sellers, low stock, and whether the cash adds up."
      comingIn="P12"
    />
  );
}
