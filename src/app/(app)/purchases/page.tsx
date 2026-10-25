import { PurchasesScreen } from "@/components/purchases/purchases-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/purchases");
  return <PurchasesScreen />;
}
