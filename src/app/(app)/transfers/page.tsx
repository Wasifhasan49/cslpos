import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/transfers");
  return (
    <SectionPlaceholder
      title="Transfers"
      what="Send stock to another branch and receive what they send you."
      comingIn="P7"
    />
  );
}
