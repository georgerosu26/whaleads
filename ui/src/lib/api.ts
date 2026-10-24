// Cookie session + CSRF header. A 401 on any call except the auth probes sends the user to /login.
let csrf = ''
export const setCsrf = (t: string) => { csrf = t }

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, any> | null = null) { super(message) }
  get field(): string | undefined { return typeof this.data?.field === 'string' ? this.data.field : undefined }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData // browser sets the multipart boundary
  if (opts.body !== undefined && !isForm) headers['content-type'] = 'application/json'
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf
  let res: Response
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body) })
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and retry.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = typeof data?.message === 'string' ? data.message /* friendly text beside a code */ : typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/setup')) {
      window.dispatchEvent(new Event('wl:unauthorized'))
    }
    throw new ApiError(res.status, msg, data)
  }
  return data as T
}
