// Same sample catalogue as supabase/seed.sql, for demo mode.
//
// Two branches, like the seed, and deliberately with DIFFERENT stock. A one-branch
// demo would look correct whether or not branch separation actually worked.
import type { Branch, Category, Product } from "../types";

export const DEMO_CATEGORIES: Category[] = [
  { id: "c1", name: "Cables & adapters" },
  { id: "c2", name: "Accessories" },
  { id: "c3", name: "RAM & storage" },
  { id: "c4", name: "Networking" },
  { id: "c5", name: "Laptops" },
  { id: "c6", name: "Printing" },
];

export const DEMO_BRANCHES: Branch[] = [
  { id: "b1", name: "Main branch", code: "MB", locations: [{ id: "e1", name: "Main store", isDefault: true }] },
  { id: "b2", name: "Second branch", code: "SB", locations: [{ id: "e2", name: "Main store", isDefault: true }] },
];

/** The catalogue, without any stock figure: stock is per branch. */
export interface DemoProduct extends Omit<Product, "stock" | "serials"> {
  serialNumbers: string[];
}

const p = (
  id: string, categoryId: string, code: string, name: string, brand: string,
  price: number, warrantyMonths: number, reorderLevel: number, serialNumbers: string[] = [],
): DemoProduct => ({
  id, categoryId, code, barcode: null, name, brand, price, warrantyMonths,
  isSerial: serialNumbers.length > 0,
  reorderLevel,
  serialNumbers,
});

export function demoCatalogue(): DemoProduct[] {
  return [
    p("a1", "c1", "VEN-AUD-35", "Vention Audio 3.5mm to 2 Female 3.5mm", "Vention", 500, 12, 3),
    p("a2", "c1", "VEN-HDMI-15", "Vention HDMI Cable 1.5m Black", "Vention", 450, 12, 3),
    p("a3", "c1", "VEN-TC-35", "Vention Type-C to 3.5mm Adapter", "Vention", 350, 6, 3),
    p("a4", "c2", "LOG-M90", "Logitech M90 Wired Mouse", "Logitech", 450, 12, 5),
    p("a5", "c2", "LOG-K120", "Logitech K120 Keyboard", "Logitech", 850, 12, 3),
    p("a6", "c2", "CPAD-5F", "Laptop Cooling Pad, 5 fans", "Generic", 1200, 6, 2),
    p("a7", "c3", "KVR-8G-32", "Kingston 8GB DDR4 3200 Laptop RAM", "Kingston", 2900, 36, 2, ["KVR8A2410933", "KVR8A2410941", "KVR8A2411007"]),
    p("a8", "c3", "SAM-980-500", "Samsung 980 500GB NVMe SSD", "Samsung", 6200, 60, 2, ["S64DNX0T41822", "S64DNX0T41907", "S64DNX0T42015", "S64DNX0T49999"]),
    p("a9", "c4", "TPL-C6", "TP-Link Archer C6 Router", "TP-Link", 3300, 12, 2, ["22406C6010382", "22406C6010415"]),
    p("aa", "c5", "ASU-X1504", "ASUS Vivobook 15 (i5, 16GB, 512GB SSD)", "ASUS", 72000, 24, 1, ["R9N0CV12A345", "R9N0CV12A388"]),
    p("ab", "c6", "HP-680-BK", "HP 680 Black Ink Cartridge", "HP", 1050, 0, 2),
  ];
}

/** Non-serial stock per branch: product id → qty. Anything missing is 0. */
export const DEMO_STOCK: Record<string, Record<string, number>> = {
  b1: { a1: 4, a2: 9, a3: 7, a4: 15, a5: 10, a6: 3, ab: 0 },
  b2: { a1: 6, a2: 2, a4: 5 },
};

/** Which branch each serial sits in. Serials are physical, so they live in one place. */
export const DEMO_SERIAL_BRANCH: Record<string, string> = {
  S64DNX0T49999: "b2", // the one SSD at the second branch
};
export const DEFAULT_SERIAL_BRANCH = "b1";

export const DEMO_PIN = "1234";
