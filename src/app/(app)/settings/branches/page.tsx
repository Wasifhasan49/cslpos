import { BranchSettings } from "@/components/settings/branch-settings";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/settings");
  return <BranchSettings />;
}
