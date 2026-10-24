import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/customers");
  return (
    <SectionPlaceholder
      title="Customers"
      what="Customers, their dues, and who owes what."
      comingIn="P10"
    />
  );
}
