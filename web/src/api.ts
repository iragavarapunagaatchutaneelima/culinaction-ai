export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public fields: Record<string, string> = {},
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CulinAction': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'Cannot reach the CulinAction server. Check that it is running and you are online.',
      'network',
    );
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = (
      data as { error?: { message?: string; code?: string; details?: { fields?: Record<string, string> } } }
    )?.error;
    // Some endpoints (e.g. AI explain) return the updated record with a non-2xx status.
    if (!e && data && typeof data === 'object')
      throw new ApiError(res.status, 'Request failed', 'with_body', {}, data);
    throw new ApiError(
      res.status,
      e?.message ?? `Request failed (${res.status})`,
      e?.code ?? 'error',
      e?.details?.fields ?? {},
      e?.details,
    );
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const del = <T>(p: string, b?: unknown) => api<T>('DELETE', p, b ?? {});
