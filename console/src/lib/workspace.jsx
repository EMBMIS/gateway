import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, setActiveProject } from './api'

/**
 * Who is signed in, and which workspace they are looking at.
 * user: { id, email, projectId, role } | null; undefined while loading.
 */
const Ctx = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)
  const [workspace, setWorkspace] = useState(null)

  const load = useCallback(async () => {
    try {
      const { user: u } = await api.get('/api/auth/me')
      setActiveProject(u.projectId)
      setUser(u)
      try {
        const list = await api.get('/api/projects')
        setWorkspace((Array.isArray(list) ? list : []).find((p) => p.id === u.projectId) || { id: u.projectId, name: 'Workspace' })
      } catch { setWorkspace({ id: u.projectId, name: 'Workspace' }) }
    } catch {
      setActiveProject(null)
      setUser(null)
      setWorkspace(null)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const value = useMemo(() => ({
    user, workspace, reload: load,
    projectId: user?.projectId,
    login: async (email, password) => { await api.post('/api/auth/login', { email, password }); await load() },
    register: async (email, password) => { const r = await api.post('/api/auth/register', { email, password }); await load(); return r },
    logout: async () => { try { await api.post('/api/auth/logout') } finally { setActiveProject(null); setUser(null); setWorkspace(null) } },
  }), [user, workspace, load])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
