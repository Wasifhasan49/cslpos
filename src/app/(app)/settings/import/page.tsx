import { ImportScreen } from "@/components/settings/import-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/settings");
  return <ImportScreen />;
}
