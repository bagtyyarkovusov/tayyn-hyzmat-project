export type CancellationOutcome =
  | "WITH_REFUND"
  | "WITHOUT_REFUND"
  | "BEFORE_ACCEPTANCE"
  | "NO_DEBIT"
  | "UNKNOWN";

const labels: Record<CancellationOutcome, string> = {
  WITH_REFUND: "Отменён с возвратом",
  WITHOUT_REFUND: "Отменён без возврата",
  BEFORE_ACCEPTANCE: "Отменён до принятия",
  NO_DEBIT: "Отменён без списания",
  UNKNOWN: "Отменён · исход не определён",
};

// Never infer a historical financial outcome from CANCELLED alone.
export function cancellationLabel(outcome?: CancellationOutcome | null) {
  return outcome ? (labels[outcome] ?? "Отменён") : "Отменён";
}
