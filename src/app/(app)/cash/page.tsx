import { CashScreen } from "@/components/cash/cash-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/cash");
  return <CashScreen />;
}
