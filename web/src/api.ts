async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`) as Error & {
      fields?: string[];
      details?: { field: string; message: string }[];
      status?: number;
    };
    err.fields = data?.fields ?? [];
    err.details = data?.details ?? [];
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export const fmt = {
  time(v: string | null | undefined): string {
    if (!v) return "—";
    const d = new Date(v);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  num(v: number | null | undefined, d = 1): string {
    return v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d);
  },
};
