import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

export type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T }

// GET once, expose reload and a local setter so mutations can patch without a refetch.
export function useLoad<T>(path: string) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' })
  const reload = useCallback(async () => {
    try { setState({ status: 'ready', data: await api<T>(path) }) } catch (e) { setState({ status: 'error', message: (e as Error).message }) }
  }, [path])
  useEffect(() => { setState({ status: 'loading' }); void reload() }, [reload])
  return { state, reload, set: (data: T) => setState({ status: 'ready', data }) }
}
