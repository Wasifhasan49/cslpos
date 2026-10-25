import { ProductsScreen } from "@/components/products/products-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/products");
  return <ProductsScreen />;
}
