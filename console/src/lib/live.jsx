import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BASE } from './api'

/**
 * Live decisions over /ws.
 *
 * The server pushes { type: 'request' | 'alert', data, timestamp } for the signed-in workspace. This keeps the
 * latest few, reconnects with backoff, and tells React Query when something changed so lists refresh.
 * `status` is honest: 'live', 'connecting', or 'offline' (with the reason a person can act on).
 */
const Ctx = createContext({ status: 'connecting', events: [] })
const MAX = 60

export function LiveProvider({ children }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState('connecting')
  const [events, setEvents] = useState([])
  const retry = useRef(0)
  const timer = useRef(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let ws
    const connect = () => {
      if (!alive.current) return
      setStatus('connecting')
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      try { ws = new WebSocket(`${proto}://${window.location.host}${BASE}/ws`) } catch { setStatus('offline'); return }
      ws.onopen = () => { retry.current = 0; setStatus('live') }
      ws.onmessage = (m) => {
        let msg
        try { msg = JSON.parse(m.data) } catch { return }
        if (!msg || !msg.type) return
        setEvents((prev) => [{ ...msg, id: `${msg.timestamp}-${Math.random().toString(16).slice(2, 6)}` }, ...prev].slice(0, MAX))
        if (msg.type === 'request') {
          qc.invalidateQueries({ queryKey: ['decisions'] })
          qc.invalidateQueries({ queryKey: ['escalations'] })
          qc.invalidateQueries({ queryKey: ['dashboard'] })
        } else if (msg.type === 'alert') {
          qc.invalidateQueries({ queryKey: ['alerts'] })
          qc.invalidateQueries({ queryKey: ['dashboard'] })
        }
      }
      ws.onclose = () => {
        if (!alive.current) return
        setStatus('offline')
        const wait = Math.min(15000, 1000 * 2 ** retry.current)
        retry.current += 1
        timer.current = setTimeout(connect, wait)
      }
      ws.onerror = () => { try { ws.close() } catch { /* already closing */ } }
    }
    connect()
    return () => { alive.current = false; clearTimeout(timer.current); try { ws && ws.close() } catch { /* ignore */ } }
  }, [qc])

  const value = useMemo(() => ({ status, events }), [status, events])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useLive = () => useContext(Ctx)
