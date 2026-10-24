import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/products");
  return (
    <SectionPlaceholder
      title="Products"
      what="Add products, set the prices staff sell at, and manage price lists."
      comingIn="P3"
    />
  );
}
