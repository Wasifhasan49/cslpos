import type { SettingTable } from "./types";

/**
 * What each setup list looks like on screen.
 *
 * Ten near-identical lists would be ten near-identical screens to write and keep in
 * step, so the shape is data and one component renders all of them. The database is
 * still the thing that validates: save_setting_row() checks the table and every field
 * name, so a mistake here is a broken screen, never a bad write.
 */
export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "bool" | "select";
  /** Shown under the field when the point of it isn't obvious. */
  hint?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  /** Hidden from the add/edit form: set by the shop, not by a person. */
  readOnly?: boolean;
  suffix?: string;
}

export interface ListSpec {
  table: SettingTable;
  title: string;
  /** One line on why a shop would care. */
  what: string;
  /** Which feature switch has to be on for this list to be worth showing. */
  feature?: string;
  /** The field shown as the row's name. */
  nameField: string;
  fields: FieldSpec[];
  /** Rows the shop cannot add to or remove from, only edit (fixed vocabulary). */
  fixedRows?: boolean;
}

export const SETTING_LISTS: ListSpec[] = [
  {
    table: "units",
    title: "Units of measure",
    what: "How each product is counted. Cable is sold by the metre, so that unit allows decimals; a mouse does not.",
    nameField: "name",
    fields: [
      { key: "name", label: "Unit", type: "text", required: true },
      { key: "allow_decimals", label: "Allow decimals", type: "bool", hint: "On for things sold by length or weight (2.5 metres)." },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "vat_rates",
    title: "VAT rates",
    what: "The rates this shop charges. Inclusive means the shelf price already contains the VAT, which is the usual way here.",
    feature: "vat",
    nameField: "name",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "pct", label: "Rate", type: "number", suffix: "%", required: true },
      { key: "inclusive", label: "Price includes VAT", type: "bool", hint: "On: the customer pays the shelf price. Off: VAT is added at the till." },
      { key: "is_default", label: "Use by default", type: "bool" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "hs_codes",
    title: "HS codes",
    what: "Customs codes, for shops that import. A product can carry one.",
    feature: "hs_codes",
    nameField: "code",
    fields: [
      { key: "code", label: "HS code", type: "text", required: true },
      { key: "description", label: "What it covers", type: "text" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "extra_charges",
    title: "Extra charges",
    what: "Things added to a sale on top of the goods: delivery, installation, a service charge.",
    feature: "extra_charges",
    nameField: "name",
    fields: [
      { key: "name", label: "Charge", type: "text", required: true },
      {
        key: "kind", label: "Worked out as", type: "select", required: true,
        options: [
          { value: "fixed", label: "A fixed amount" },
          { value: "percent", label: "A percentage of the sale" },
        ],
      },
      { key: "value", label: "Amount or percent", type: "number", required: true },
      { key: "taxable", label: "VAT applies to it", type: "bool" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "discount_types",
    title: "Discount reasons",
    what: "Why a discount was given, so the owner's report says “Festival offer” instead of just “10%”.",
    nameField: "name",
    fields: [
      { key: "name", label: "Reason", type: "text", required: true },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "payment_methods",
    title: "Payment methods",
    what: "What this shop takes. A method that is off is refused at the till, not quietly accepted.",
    nameField: "label",
    fixedRows: true,
    fields: [
      { key: "key", label: "Method", type: "text", readOnly: true },
      { key: "label", label: "Shown as", type: "text", required: true },
      { key: "enabled", label: "This shop takes it", type: "bool" },
      { key: "needs_ref", label: "Needs a reference", type: "bool", hint: "A transaction ID, cheque number or the card's last 4 digits." },
    ],
  },
  {
    table: "card_types",
    title: "Card types",
    what: "What the card company takes, so the shop knows what actually arrives in the bank.",
    nameField: "name",
    fields: [
      { key: "name", label: "Card", type: "text", required: true },
      { key: "charge_pct", label: "Their charge", type: "number", suffix: "%" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "bank_accounts",
    title: "Where the money lands",
    what: "The drawer, bank accounts and mobile wallets money goes into. The accounts in P13 post to these.",
    nameField: "name",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      {
        key: "kind", label: "Kind", type: "select", required: true,
        options: [
          { value: "cash_drawer", label: "Cash drawer" },
          { value: "bank", label: "Bank account" },
          { value: "wallet", label: "Mobile wallet (bKash, Nagad)" },
        ],
      },
      { key: "account_no", label: "Account or wallet number", type: "text" },
      { key: "bank_name", label: "Bank", type: "text" },
      { key: "branch_name", label: "Bank branch", type: "text" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "warranty_terms",
    title: "Warranty terms",
    what: "Named terms a product can use, with the wording printed on the receipt. BMS prints only “1 Year”, which is why claims turn into arguments.",
    nameField: "name",
    fields: [
      { key: "name", label: "Term", type: "text", required: true },
      { key: "months", label: "Length", type: "number", suffix: "months", required: true },
      { key: "receipt_text", label: "Printed on the receipt", type: "text", hint: "Say what is and isn't covered, in plain words." },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "transaction_categories",
    title: "Categories",
    what: "Labels for splitting reports: walk-in, corporate, online, service.",
    nameField: "name",
    fields: [
      { key: "name", label: "Category", type: "text", required: true },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
  {
    table: "sale_fields",
    title: "Extra fields on a sale",
    what: "Your own fields at the counter: a PO number, a reference, anything the shop needs recorded against a sale.",
    nameField: "name",
    fields: [
      { key: "name", label: "Field", type: "text", required: true },
      { key: "show_on_invoice", label: "Print it on the invoice", type: "bool" },
      { key: "active", label: "In use", type: "bool" },
    ],
  },
];

export interface FeatureSpec {
  key: string;
  label: string
  what: string;
}

/** The switches, in the order a shop would think about them. */
export const FEATURE_SWITCHES: FeatureSpec[] = [
  { key: "vat", label: "This shop charges VAT", what: "Adds VAT rates to products and shows the tax on receipts. Only turn this on if the shop is VAT registered." },
  { key: "price_lists", label: "Price lists", what: "Different prices for retail, dealers and corporate customers." },
  { key: "credit_sales", label: "Credit sales (baki)", what: "Selling on due, and collecting it later." },
  { key: "purchase_orders", label: "Purchase paperwork", what: "Requisitions, purchase orders and supplier dues." },
  { key: "transfers", label: "Branch transfers", what: "Moving stock between branches with a send and a receive." },
  { key: "multi_location", label: "Several stock locations per branch", what: "For a branch with a shop floor and a warehouse." },
  { key: "extra_charges", label: "Extra charges on a sale", what: "Delivery, installation, service charges." },
  { key: "hs_codes", label: "HS codes", what: "Customs codes, for shops that import." },
  { key: "accounts", label: "Accounts", what: "Double-entry books, vouchers and cheques." },
  { key: "sms", label: "SMS", what: "Receipts and due reminders by text message." },
];

/** Owner-only sections an owner can choose to share with their managers. */
export const MANAGER_SHARES: FeatureSpec[] = [
  { key: "managers_see_dashboard", label: "Managers can see the dashboard", what: "Today's sales, profit and best sellers." },
  { key: "managers_see_accounts", label: "Managers can see the accounts", what: "The books. Most shops leave this off." },
  { key: "managers_see_settings", label: "Managers can change settings", what: "Everything on this screen. Leave off unless you trust them with it." },
];

export const DOC_TYPE_LABELS: Record<string, string> = {
  invoice: "Invoices", return: "Returns", quote: "Quotations", order: "Sales orders",
  challan: "Delivery challans", grn: "Goods received", po: "Purchase orders",
  requisition: "Requisitions", transfer: "Branch transfers", adjustment: "Stock adjustments",
  receipt: "Money received", payment: "Money paid", voucher: "Vouchers", cheque: "Cheques",
};

export const PERMISSION_AREA_LABELS: Record<string, string> = {
  counter: "At the counter", stock: "Stock", reports: "Reports",
  accounts: "Accounts", admin: "Administration",
};
