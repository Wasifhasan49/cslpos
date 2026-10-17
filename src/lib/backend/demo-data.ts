// Same sample catalogue as supabase/seed.sql, for demo mode.
import type { Category, Product } from "../types";

export const DEMO_CATEGORIES: Category[] = [
  { id: "c1", name: "Cables & adapters" },
  { id: "c2", name: "Accessories" },
  { id: "c3", name: "RAM & storage" },
  { id: "c4", name: "Networking" },
  { id: "c5", name: "Laptops" },
  { id: "c6", name: "Printing" },
];

const p = (
  id: string, categoryId: string, code: string, name: string, brand: string,
  price: number, warrantyMonths: number, stock: number, serials: string[] = [],
): Product => ({
  id, categoryId, code, barcode: null, name, brand, price, warrantyMonths,
  isSerial: serials.length > 0,
  stock: serials.length > 0 ? serials.length : stock,
  serials: serials.map((s, i) => ({ id: `${id}-s${i}`, serial: s })),
});

export function demoProducts(): Product[] {
  return [
    p("a1", "c1", "VEN-AUD-35", "Vention Audio 3.5mm to 2 Female 3.5mm", "Vention", 500, 12, 4),
    p("a2", "c1", "VEN-HDMI-15", "Vention HDMI Cable 1.5m Black", "Vention", 450, 12, 9),
    p("a3", "c1", "VEN-TC-35", "Vention Type-C to 3.5mm Adapter", "Vention", 350, 6, 7),
    p("a4", "c2", "LOG-M90", "Logitech M90 Wired Mouse", "Logitech", 450, 12, 15),
    p("a5", "c2", "LOG-K120", "Logitech K120 Keyboard", "Logitech", 850, 12, 10),
    p("a6", "c2", "CPAD-5F", "Laptop Cooling Pad, 5 fans", "Generic", 1200, 6, 3),
    p("a7", "c3", "KVR-8G-32", "Kingston 8GB DDR4 3200 Laptop RAM", "Kingston", 2900, 36, 0, ["KVR8A2410933", "KVR8A2410941", "KVR8A2411007"]),
    p("a8", "c3", "SAM-980-500", "Samsung 980 500GB NVMe SSD", "Samsung", 6200, 60, 0, ["S64DNX0T41822", "S64DNX0T41907", "S64DNX0T42015"]),
    p("a9", "c4", "TPL-C6", "TP-Link Archer C6 Router", "TP-Link", 3300, 12, 0, ["22406C6010382", "22406C6010415"]),
    p("aa", "c5", "ASU-X1504", "ASUS Vivobook 15 (i5, 16GB, 512GB SSD)", "ASUS", 72000, 24, 0, ["R9N0CV12A345", "R9N0CV12A388"]),
    p("ab", "c6", "HP-680-BK", "HP 680 Black Ink Cartridge", "HP", 1050, 0, 0),
  ];
}

export const DEMO_PIN = "1234";
