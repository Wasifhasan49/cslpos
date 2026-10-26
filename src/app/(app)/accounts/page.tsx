import { AccountsScreen } from "@/components/accounts/accounts-screen";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/accounts");
  return <AccountsScreen />;
}
