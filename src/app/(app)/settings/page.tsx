import { SettingsScreen } from "@/components/settings/settings-screen";
import { guardSection } from "@/lib/guard";

export default async function SettingsPage() {
  await guardSection("/settings");
  return <SettingsScreen />;
}
