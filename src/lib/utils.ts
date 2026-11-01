import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * "1 sale", "2 sales". Plain English means not printing "1 sales" at a shopkeeper,
 * and almost every count on screen is an ordinary English noun that takes an -s.
 */
export function plural(n: number, one: string, many = one + "s") {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}
