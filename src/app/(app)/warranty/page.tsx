import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/warranty");
  return (
    <SectionPlaceholder
      title="Warranty"
      what="Look up a serial number or a phone number to see what was sold and when the warranty ends."
      comingIn="P11"
    />
  );
}
