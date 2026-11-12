/** Who an approval row names: "Auto" for a permission-mode approval, else "You". */
export function approvalDeciderLabel(decidedBy?: "user" | "auto" | null): "Auto" | "You" {
  return decidedBy === "auto" ? "Auto" : "You";
}
