import { SectionPlaceholder } from "@/components/section-placeholder";
import { guardSection } from "@/lib/guard";

export default async function Page() {
  await guardSection("/accounts");
  return (
    <SectionPlaceholder
      title="Accounts"
      what="The shop's books: ledger, vouchers, cheques and reports."
      comingIn="P13"
    />
  );
}
