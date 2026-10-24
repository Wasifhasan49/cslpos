// The sale being rung up right now.
import { create } from "zustand";
import type { CartLine, PaymentMethod, Product } from "../types";

interface SaleState {
  lines: CartLine[];
  discount: string;
  pin: string;
  /** Which owner/manager is being asked to approve. The counter names the approver so
   *  the audit log records who it actually was, instead of whichever hash matched. */
  approverId: string | null;
  /** From verify_manager_pin(). Non-null means really approved, checked and recorded —
   *  not "typed, we'll find out when the customer has already waited." */
  approvalId: string | null;
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
  setApprover: (id: string | null) => void;
  setApproval: (id: string | null) => void;
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
  approverId: null as string | null,
  approvalId: null as string | null,
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
  // Changing the discount drops any approval: it was approved for a different amount.
  setDiscount: (v) => set({ discount: v.replace(/[^0-9.]/g, "").slice(0, 5), pin: "", approvalId: null }),
  setPin: (v) => set({ pin: v.replace(/\D/g, "").slice(0, 6) }),
  setApprover: (id) => set({ approverId: id, pin: "", approvalId: null }),
  setApproval: (id) => set({ approvalId: id }),
  setPhone: (v) => set({ phone: v.replace(/\D/g, "").slice(0, 11) }),
  setMethod: (m) => set({ method: m, paymentRef: "" }),
  setCashReceived: (v) => set({ cashReceived: v.replace(/\D/g, "").slice(0, 9) }),
  setPaymentRef: (v) => set({ paymentRef: v.trim().slice(0, 24) }),
  reset: () => set({ ...empty }),
}));
