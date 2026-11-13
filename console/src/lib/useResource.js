import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notify } from '../components/ui'
import { explain } from './api'

/** useQuery with the names the rest of the console uses. */
export function useResource(key, fetcher, options = {}) {
  const q = useQuery({ queryKey: key, queryFn: ({ signal }) => fetcher({ signal }), ...options })
  return { ...q, loading: q.isPending, refetch: q.refetch }
}

/**
 * Write, then refresh what the write changed. Errors are said out loud (with a reference id)
 * unless the caller handles them.
 */
export function useAction(mutator, { invalidates = [], success, onSuccess, silent = false } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: mutator,
    onSuccess: (data, vars) => {
      for (const k of invalidates) qc.invalidateQueries({ queryKey: k })
      if (success) notify.success(typeof success === 'function' ? success(data, vars) : success)
      onSuccess?.(data, vars)
    },
    onError: (e) => { if (!silent) notify.error(explain(e)) },
  })
}
