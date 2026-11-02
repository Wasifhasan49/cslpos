/**
 * What each import needs, and the column names BMS actually uses for it.
 *
 * The aliases are the whole point: a shop should not have to know that its
 * "Model No/Caption" column is our "name". Anything not recognised is still mappable
 * by hand, so an unknown export is slower but never blocked.
 */

export type ImportKind = "products" | "prices" | "stock" | "serials" | "customers" | "suppliers";

export interface FieldSpec {
  key: string;
  label: string;
  /** Without this the row cannot be imported at all. */
  required?: boolean;
  /** A balance can be either way round: a customer in credit, a supplier the shop has
   *  overpaid. A price cannot. */
  allowNegative?: boolean;
  type: "text" | "number" | "money" | "warranty" | "phone" | "bool";
  /** Header names that mean this field, lower-cased. BMS's own names first. */
  aliases: string[];
  hint?: string;
}

export interface KindSpec {
  kind: ImportKind;
  label: string;
  what: string;
  /** What BMS report this usually comes from. */
  from: string;
  fields: FieldSpec[];
}

const CODE: FieldSpec = {
  key: "code",
  label: "Product code",
  required: true,
  type: "text",
  aliases: ["product code", "code", "item code", "sku", "product id", "barcode/code"],
  hint: "What a barcode scan looks for. Everything is matched on this.",
};

export const IMPORT_KINDS: KindSpec[] = [
  {
    kind: "products",
    label: "Products",
    what: "The catalogue: codes, names, categories, brands, prices and warranty.",
    from: "BMS → Current Stock (Combined) with cost",
    fields: [
      CODE,
      {
        key: "name", label: "Product name", required: true, type: "text",
        // BMS calls the product name "Model No/Caption", which is nobody's first guess.
        aliases: ["model no/caption", "model no / caption", "caption", "product name",
                  "name", "description", "item name", "particulars"],
      },
      {
        key: "category", label: "Category", type: "text",
        aliases: ["product group", "group", "category", "product category", "item group"],
      },
      { key: "brand", label: "Brand", type: "text", aliases: ["brand name", "brand", "manufacturer"] },
      { key: "model", label: "Model", type: "text", aliases: ["model", "model no", "model number"] },
      { key: "unit", label: "Unit", type: "text", aliases: ["unit", "uom", "unit of measure"] },
      {
        key: "price", label: "Selling price", type: "money",
        aliases: ["sales price", "sale price", "selling price", "price", "retail price", "rate", "mrp price"],
      },
      { key: "mrp", label: "MRP", type: "money", aliases: ["mrp", "max retail price", "maximum retail price"] },
      {
        key: "warranty", label: "Warranty", type: "warranty",
        aliases: ["warranty", "warranty period", "guarantee", "warrenty"],
        hint: 'Understands "1 Year", "6 Month", "36" and "N/A".',
      },
      { key: "barcode", label: "Barcode", type: "text", aliases: ["barcode", "bar code", "ean"] },
      {
        key: "is_serial", label: "Serial tracked", type: "bool",
        aliases: ["serial", "is serial", "serial tracked", "imei", "serial/imei"],
      },
      { key: "reorder_level", label: "Re-order level", type: "number", aliases: ["reorder level", "re-order level", "minimum qty", "min qty"] },
      { key: "specification", label: "Specification", type: "text", aliases: ["specification", "spec", "details", "remarks"] },
    ],
  },
  {
    kind: "prices",
    label: "Prices",
    what: "A price per product for one price list, with an optional lowest and highest.",
    from: "BMS → Sales Price Fixing",
    fields: [
      CODE,
      { key: "price", label: "Price", required: true, type: "money", aliases: ["sales price", "price", "rate", "selling price"] },
      { key: "mrp", label: "MRP", type: "money", aliases: ["mrp", "max retail price"] },
      { key: "min_price", label: "Lowest allowed", type: "money", aliases: ["lower price", "min price", "minimum price", "lowest price"] },
      { key: "max_price", label: "Highest allowed", type: "money", aliases: ["higher price", "max price", "maximum price", "highest price"] },
    ],
  },
  {
    kind: "stock",
    label: "Opening stock",
    what: "What is on the shelf right now. It comes in as an opening-stock adjustment, so the history says where it came from.",
    from: "BMS → Current Stock (Combined) with cost",
    fields: [
      CODE,
      {
        key: "qty", label: "Quantity", required: true, type: "number",
        aliases: ["balance qty", "stock qty", "qty", "quantity", "closing qty", "balance", "stock"],
      },
      { key: "location", label: "Store", type: "text", aliases: ["store", "warehouse", "location", "store name"] },
    ],
  },
  {
    kind: "serials",
    label: "Serial numbers",
    what: "Serial and IMEI numbers for the items that have them. Anything already sold is skipped.",
    from: "BMS → Current Stock (Combined) with Serial And Cost",
    fields: [
      CODE,
      {
        key: "serial", label: "Serial / IMEI", required: true, type: "text",
        aliases: ["serial/imei no", "serial/imei", "serial no", "serial number", "serial", "imei", "imei no"],
      },
      {
        key: "status", label: "Status", type: "text",
        aliases: ["status", "stock status"],
        hint: 'Anything that reads as sold is skipped rather than imported as available.',
      },
      { key: "location", label: "Store", type: "text", aliases: ["store", "warehouse", "location"] },
    ],
  },
  {
    kind: "customers",
    label: "Customers",
    what: "Customers and what they owe. The dues become opening balances, ready for the accounts.",
    from: "BMS → Customer Information, or All Traders Due List",
    fields: [
      {
        key: "phone", label: "Mobile", type: "phone",
        aliases: ["mobile no", "mobile", "phone", "phone no", "contact no", "cell"],
        hint: "11 digits starting 01. A made-up one is dropped, and the customer comes in under their name.",
      },
      { key: "name", label: "Name", type: "text", aliases: ["customer name", "name", "party name", "client name"] },
      { key: "address", label: "Address", type: "text", aliases: ["address", "location", "area"] },
      {
        key: "due", label: "Amount owed", type: "money", allowNegative: true,
        aliases: ["due amount", "due", "balance", "outstanding", "receivable", "closing balance"],
      },
    ],
  },
  {
    kind: "suppliers",
    label: "Suppliers",
    what: "Suppliers and what the shop owes them, as opening balances.",
    from: "BMS → Supplier Information, or All Traders Due List",
    fields: [
      { key: "name", label: "Name", required: true, type: "text", aliases: ["supplier name", "name", "party name", "vendor name"] },
      { key: "phone", label: "Mobile", type: "phone", aliases: ["mobile no", "mobile", "phone", "phone no", "contact no"] },
      { key: "address", label: "Address", type: "text", aliases: ["address", "location", "area"] },
      {
        key: "due", label: "Amount owed to them", type: "money", allowNegative: true,
        aliases: ["due amount", "due", "balance", "outstanding", "payable", "closing balance"],
      },
    ],
  },
];

export function kindSpec(kind: ImportKind): KindSpec {
  const spec = IMPORT_KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`Unknown import kind: ${kind}`);
  return spec;
}
