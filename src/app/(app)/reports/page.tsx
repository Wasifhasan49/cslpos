import { ReportsScreen } from "@/components/reports/reports-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/reports");
  return <ReportsScreen />;
}
