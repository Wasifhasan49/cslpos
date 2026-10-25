import { WarrantyScreen } from "@/components/warranty/warranty-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/warranty");
  return <WarrantyScreen />;
}
