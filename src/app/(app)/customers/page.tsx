import { CustomersScreen } from "@/components/customers/customers-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/customers");
  return <CustomersScreen />;
}
