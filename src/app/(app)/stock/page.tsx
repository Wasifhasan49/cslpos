import { StockScreen } from "@/components/stock/stock-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/stock");
  return <StockScreen />;
}
