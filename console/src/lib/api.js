/**
 * The console talks to the gateway's own API, same origin, with the session cookie.
 * Every failure is turned into an ApiError that says what failed and carries a reference id.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR', reference } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.reference = reference
  }
}

// The console may be served under a path of a shared host (/gateway): every request and link goes through here.
export const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
export const withBase = (path) => `${BASE}${path}`

const reference = () => Math.random().toString(16).slice(2, 10)

// The workspace the signed-in user is looking at. Management endpoints are scoped by projectId; the console always
// says which one, so a gateway with several workspaces never answers with someone else's data.
let activeProject = null
export function setActiveProject(id) { activeProject = id || null }
const scoped = (path) => path.startsWith('/api/') && !path.startsWith('/api/auth') && !path.startsWith('/api/v1')

function qs(params) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') out.set(k, String(v))
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

export async function request(method, path, { query, body, signal, raw } = {}) {
  if (activeProject && scoped(path)) {
    if (body && typeof body === 'object' && !Array.isArray(body)) body = { projectId: activeProject, ...body }
    query = { projectId: activeProject, ...(query || {}) }
  }
  let res
  try {
    res = await fetch(withBase(path) + qs(query), {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new ApiError('The gateway could not be reached. Check your connection and try again.', { code: 'NETWORK', reference: reference() })
  }
  if (raw) {
    if (!res.ok) throw new ApiError(`The export failed (${res.status}).`, { status: res.status, reference: reference() })
    return res
  }
  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `The gateway answered ${res.status}.`
    throw new ApiError(message, { status: res.status, code: (data && data.code) || `HTTP_${res.status}`, reference: reference() })
  }
  return data
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body, opts) => request('POST', path, { body: body ?? {}, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body: body ?? {}, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body: body ?? {}, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),
}

/** Plain-language message for an error, with the reference an operator can look up. */
export function explain(error) {
  if (!error) return ''
  const ref = error.reference ? ` (reference ${error.reference})` : ''
  return `${error.message || 'Something went wrong.'}${ref}`
}
