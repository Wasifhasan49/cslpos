import { TransfersScreen } from "@/components/transfers/transfers-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/transfers");
  return <TransfersScreen />;
}
