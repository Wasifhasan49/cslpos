import { HrScreen } from "@/components/staff-records/hr-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/staff-records");
  return <HrScreen />;
}
