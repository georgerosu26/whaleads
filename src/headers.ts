// security headers on every Worker response (/api/*, /webhooks/*). The SPA and its static files never reach
// the Worker (run_worker_first), so their headers live in ui/public/_headers; keep the two in step.
// A response that already sets a CSP (media: `sandbox`) keeps its own. WebSocket upgrades (101) pass untouched.
export const API_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101 || res.webSocket) return res
  const out = new Response(res.body, res) // responses from fetch()/bindings have immutable headers
  for (const [k, v] of Object.entries(API_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v)
  // JSON and text never need to load anything; HTML (none today) would set its own policy.
  if (!out.headers.has('Content-Security-Policy')) out.headers.set('Content-Security-Policy', API_CSP)
  return out
}
