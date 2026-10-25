import { SalesScreen } from "@/components/sales/sales-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/sales");
  return <SalesScreen />;
}
