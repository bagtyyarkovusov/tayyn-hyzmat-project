export const passwordHint = "Не менее 6 символов. Можно задать пароль из цифр.";

export function passwordError(value: string): string {
  if (value.length < 6) return "Введите пароль длиной не менее 6 символов";
  if (new TextEncoder().encode(value).length > 72)
    return "Пароль слишком длинный: максимум 72 байта. Сократите его.";
  return "";
}
