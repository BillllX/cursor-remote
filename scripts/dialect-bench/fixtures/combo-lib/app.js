import { add } from "./lib.js";

// 故意 off-by-one：应累加 1..n（含 n）
export function sumTo(n) {
  let total = 0;
  for (let i = 0; i < n; i++) total = add(total, i);
  return total;
}
