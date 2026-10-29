import { OrdersScreen } from "@/components/orders/orders-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/orders");
  return <OrdersScreen />;
}
