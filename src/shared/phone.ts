const phonePrefix = "+993";
export const phoneError = "Введите 8 цифр номера после +993";

/** Keep malformed input intact so a foreign or overlong number cannot become another phone. */
export function localPhoneInput(value: string): string {
  const compact = value.replace(/[\s()-]/g, "");
  if (compact === phonePrefix) return "";
  if (/^\+993[0-9]{0,8}$/.test(compact)) return compact.slice(4);
  if (/^[0-9]{0,8}$/.test(compact)) return compact;
  if (/^00993[0-9]{8}$/.test(compact)) return compact.slice(5);
  return value;
}

export function formatLocalPhone(value: string): string {
  return /^[0-9]{0,8}$/.test(value)
    ? (value.match(/.{1,2}/g)?.join(" ") ?? "")
    : value;
}

export function isTurkmenPhone(value: string): boolean {
  return /^\+993[0-9]{8}$/.test(value);
}
