import { SuppliersScreen } from "@/components/suppliers/suppliers-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/suppliers");
  return <SuppliersScreen />;
}
