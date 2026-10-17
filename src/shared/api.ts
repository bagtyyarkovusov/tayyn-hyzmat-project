export type Role = "admin" | "driver";
export interface User {
  id: string;
  fullName: string;
  phone: string;
  role: "ADMIN" | "DRIVER";
}
export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  user: User;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export const apiBase =
  import.meta.env.VITE_API_URL || import.meta.env.VUE_APP_API_URL || "/api";
const inflight = new Map<Role, Promise<SessionPayload>>();
const versions: Record<Role, number> = { admin: 0, driver: 0 };
export const tokens = {
  access: (role: Role) =>
    localStorage.getItem(`openride.${role}.accessToken`) || "",
  refresh: (role: Role) =>
    localStorage.getItem(`openride.${role}.refreshToken`) || "",
  generation: (role: Role) => versions[role],
  set(role: Role, session: SessionPayload, rotated = false) {
    if (!rotated) versions[role]++;
    localStorage.setItem(`openride.${role}.accessToken`, session.accessToken);
    localStorage.setItem(`openride.${role}.refreshToken`, session.refreshToken);
    localStorage.setItem(`tayyn.${role}.user`, JSON.stringify(session.user));
    window.dispatchEvent(
      new CustomEvent(`session:${role}`, { detail: session }),
    );
  },
  clear(role: Role) {
    versions[role]++;
    inflight.delete(role);
    for (const key of ["accessToken", "refreshToken"])
      localStorage.removeItem(`openride.${role}.${key}`);
    localStorage.removeItem(`tayyn.${role}.user`);
    window.dispatchEvent(new CustomEvent(`session:${role}`, { detail: null }));
  },
};
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
export async function publicRequest<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse<T>(response);
}
async function readResponse<T>(response: Response): Promise<T> {
  const data =
    response.status === 204
      ? undefined
      : await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data?.message ||
        data?.error?.message ||
        `Ошибка запроса (${response.status})`,
      response.status,
    );
  return data as T;
}
export async function refreshRole(
  role: Role,
  signal?: AbortSignal,
): Promise<SessionPayload> {
  const previous = inflight.get(role);
  if (previous) return previous;
  const version = versions[role];
  const current = publicRequest<SessionPayload>(
    "/auth/refresh",
    {
      refreshToken: tokens.refresh(role),
    },
    signal,
  )
    .then((data) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (version !== versions[role]) throw new Error("Сессия уже изменена.");
      tokens.set(role, data, true);
      return data;
    })
    .catch((error) => {
      if (
        version === versions[role] &&
        !signal?.aborted &&
        error instanceof ApiError &&
        [401, 403].includes(error.status)
      )
        tokens.clear(role);
      throw error;
    })
    .finally(() => {
      if (inflight.get(role) === current) inflight.delete(role);
    });
  inflight.set(role, current);
  return current;
}
function createClient(role: Role) {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, unknown>,
    retry = true,
    signal?: AbortSignal,
  ): Promise<{ data: T }> {
    const generation = versions[role];
    function assertCurrent() {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (generation !== versions[role])
        throw new Error("Сессия уже изменена.");
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {}))
      if (value !== undefined && value !== null) query.set(key, String(value));
    const suffix = query.size
      ? `${path.includes("?") ? "&" : "?"}${query}`
      : "";
    const response = await fetch(`${apiBase}${path}${suffix}`, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(tokens.access(role)
          ? { Authorization: `Bearer ${tokens.access(role)}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assertCurrent();
    if (response.status === 401 && retry && tokens.refresh(role)) {
      await refreshRole(role, signal);
      assertCurrent();
      return request(method, path, body, params, false, signal);
    }
    if (response.status === 401) tokens.clear(role);
    const data = await readResponse<T>(response);
    assertCurrent();
    return { data };
  }
  return {
    get: <T = unknown>(
      path: string,
      options?: { params?: Record<string, unknown>; signal?: AbortSignal },
    ) =>
      request<T>(
        "GET",
        path,
        undefined,
        options?.params,
        true,
        options?.signal,
      ),
    post: <T = unknown>(path: string, body?: unknown) =>
      request<T>("POST", path, body),
    patch: <T = unknown>(path: string, body?: unknown) =>
      request<T>("PATCH", path, body),
    delete: <T = unknown>(path: string, body?: unknown) =>
      request<T>("DELETE", path, body),
  };
}
export const adminApi = createClient("admin");
export const driverApi = createClient("driver");
