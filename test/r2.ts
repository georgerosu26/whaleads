// Minimal in-memory R2 bucket for tests: put / get (with range) / delete / head.
export function fakeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const body = (b: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close() } })
  const bucket = {
    async put(key: string, value: Uint8Array | ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value)
      store.set(key, { bytes: new Uint8Array(bytes), contentType: opts?.httpMetadata?.contentType })
      return { key, size: bytes.byteLength }
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const o = store.get(key)
      if (!o) return null
      const bytes = opts?.range ? o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : o.bytes
      return { key, size: bytes.byteLength, body: body(bytes), arrayBuffer: async () => bytes.slice().buffer, httpMetadata: { contentType: o.contentType } }
    },
    async delete(key: string) { store.delete(key) },
  }
  return { bucket: bucket as unknown as R2Bucket, store }
}
