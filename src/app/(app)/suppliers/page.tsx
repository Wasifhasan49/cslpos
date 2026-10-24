import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/suppliers");
  return (
    <SectionPlaceholder
      title="Suppliers"
      what="Suppliers, their contact details, and what you owe them."
      comingIn="P6"
    />
  );
}
