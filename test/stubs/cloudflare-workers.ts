// Stand-in for the `cloudflare:workers` module in unit tests (the real one only exists inside workerd).
export class DurableObject<E = unknown> {
  constructor(public ctx: unknown, public env: E) {}
}
