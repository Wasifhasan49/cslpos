import type { Category, Product, Receipt, SaleInput, Staff } from "../types";

/** Everything the counter needs from "the server". Demo mode and Supabase both implement this. */
export interface Backend {
  mode: "demo" | "supabase";
  currentStaff(): Promise<Staff | null>;
  listCategories(): Promise<Category[]>;
  listProducts(): Promise<Product[]>;
  /** Throws an Error whose message is already in plain words. */
  completeSale(input: SaleInput): Promise<Receipt>;
  /** Demo mode checks the PIN locally; Supabase checks it when the sale is saved. */
  checkManagerPin(pin: string): Promise<boolean | null>;
  signOut(): Promise<void>;
}
