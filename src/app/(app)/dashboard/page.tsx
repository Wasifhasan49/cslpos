import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/dashboard");
  return <DashboardScreen />;
}
