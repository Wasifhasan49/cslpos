import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/sales");
  return (
    <SectionPlaceholder
      title="Sales"
      what="Every sale made at this branch, so you can find one, print it again, void it or take a return."
      comingIn="P9"
    />
  );
}
