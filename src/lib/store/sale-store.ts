// The sale being rung up right now.
import { create } from "zustand";
import type { CartLine, PaymentMethod, Product } from "../types";

interface SaleState {
  lines: CartLine[];
  discount: string;
  pin: string;
  pinApproved: boolean;
  phone: string;
  method: PaymentMethod;
  cashReceived: string;
  paymentRef: string;

  /** Returns a short message for the screen. */
  addProduct: (p: Product) => string;
  changeQty: (p: Product, delta: number) => void;
  toggleSerial: (productId: string, serialId: string) => void;
  removeLine: (productId: string) => void;
  setDiscount: (v: string) => void;
  setPin: (v: string) => void;
  setPinApproved: (v: boolean) => void;
  setPhone: (v: string) => void;
  setMethod: (m: PaymentMethod) => void;
  setCashReceived: (v: string) => void;
  setPaymentRef: (v: string) => void;
  reset: () => void;
}

const empty = {
  lines: [] as CartLine[],
  discount: "",
  pin: "",
  pinApproved: false,
  phone: "",
  method: "cash" as PaymentMethod,
  cashReceived: "",
  paymentRef: "",
};

export const useSale = create<SaleState>((set, get) => ({
  ...empty,

  addProduct: (p) => {
    if (p.stock <= 0) return `${p.name} is out of stock`;
    const lines = get().lines;
    const existing = lines.find((l) => l.productId === p.id);
    if (!existing) {
      set({ lines: [...lines, { productId: p.id, qty: p.isSerial ? 0 : 1, serialIds: [] }] });
      return p.isSerial ? `Added ${p.name}. Pick its serial number.` : `Added ${p.name}`;
    }
    if (p.isSerial) return `Pick another serial for ${p.name} in the sale panel`;
    if (existing.qty >= p.stock) return `Only ${p.stock} of ${p.name} in stock`;
    set({ lines: lines.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) });
    return `Added another ${p.name}`;
  },

  changeQty: (p, delta) =>
    set({
      lines: get()
        .lines.map((l) => (l.productId === p.id ? { ...l, qty: Math.min(p.stock, l.qty + delta) } : l))
        .filter((l) => l.productId !== p.id || p.isSerial || l.qty > 0), // − at 1 removes the line
    }),

  toggleSerial: (productId, serialId) =>
    set({
      lines: get().lines.map((l) => {
        if (l.productId !== productId) return l;
        const serialIds = l.serialIds.includes(serialId)
          ? l.serialIds.filter((s) => s !== serialId)
          : [...l.serialIds, serialId];
        return { ...l, serialIds, qty: serialIds.length };
      }),
    }),

  removeLine: (productId) => set({ lines: get().lines.filter((l) => l.productId !== productId) }),
  setDiscount: (v) => set({ discount: v.replace(/[^0-9.]/g, "").slice(0, 5), pin: "", pinApproved: false }),
  setPin: (v) => set({ pin: v.replace(/\D/g, "").slice(0, 6) }),
  setPinApproved: (v) => set({ pinApproved: v }),
  setPhone: (v) => set({ phone: v.replace(/\D/g, "").slice(0, 11) }),
  setMethod: (m) => set({ method: m, paymentRef: "" }),
  setCashReceived: (v) => set({ cashReceived: v.replace(/\D/g, "").slice(0, 9) }),
  setPaymentRef: (v) => set({ paymentRef: v.trim().slice(0, 24) }),
  reset: () => set({ ...empty }),
}));
