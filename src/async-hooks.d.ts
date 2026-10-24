// Workers provide node:async_hooks under nodejs_compat; @types/node is not a dependency here.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R
    getStore(): T | undefined
  }
}
