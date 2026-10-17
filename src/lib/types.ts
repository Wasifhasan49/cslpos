export type Role = "owner" | "manager" | "cashier";
export type PaymentMethod = "cash" | "bkash" | "nagad" | "card";

export interface Staff {
  id: string;
  name: string;
  role: Role;
  discountLimitPct: number;
  shopName: string;
}

export interface Category {
  id: string;
  name: string;
}

export interface SerialUnit {
  id: string;
  serial: string;
}

/** What the counter sees. No cost price, ever. */
export interface Product {
  id: string;
  code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  categoryId: string | null;
  price: number;
  warrantyMonths: number;
  isSerial: boolean;
  stock: number;
  serials: SerialUnit[]; // in-stock units, for serial items
}

export interface CartLine {
  productId: string;
  qty: number; // for serial items this always equals serialIds.length
  serialIds: string[];
}

export interface SaleInput {
  lines: CartLine[];
  paymentMethod: PaymentMethod;
  discountPct: number;
  managerPin: string | null;
  customerPhone: string | null;
  cashReceived: number | null;
  paymentRef: string | null;
}

export interface ReceiptLine {
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  warrantyUntil: string | null; // YYYY-MM-DD
  serials: string[];
}

export interface Receipt {
  id: string;
  invoiceNo: string;
  createdAt: string;
  staffName: string;
  shopName: string;
  shopAddress: string | null;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  total: number;
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  changeGiven: number | null;
  paymentRef: string | null;
  customerPhone: string | null;
  items: ReceiptLine[];
}
