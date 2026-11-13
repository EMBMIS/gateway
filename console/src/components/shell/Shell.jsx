import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  MagnifyingGlassIcon, Bars3Icon, SunIcon, MoonIcon, ComputerDesktopIcon, ChevronDownIcon,
  ArrowRightOnRectangleIcon, KeyIcon, RocketLaunchIcon,
} from '@heroicons/react/24/outline'
import { useAuth } from '../../lib/workspace'
import { LiveProvider, useLive } from '../../lib/live'
import { api } from '../../lib/api'
import { useResource } from '../../lib/useResource'
import { getThemeMode, setTheme } from '../../lib/darkMode'
import { CommandPalette, Dialog, Kbd, Sheet } from '../ui'
import { AREAS, FOOT, locate } from './navigation'
import { desktop, inDesktop } from './desktopBridge'

/**
 * The shell: a dock with one plate per area, the area's own screens beside it, breadcrumbs, ⌘K, and a bottom bar on
 * phones. Same pattern as Business OS.
 */
const SHORTCUTS = [
  ['⌘K / Ctrl K', 'Search pages and actions'],
  ['g d', 'Go to the dashboard'], ['g l', 'Go to all decisions'], ['g q', 'Go to the escalation queue'],
  ['g a', 'Go to agents'], ['g p', 'Go to policies'], ['g s', 'Go to settings'],
  ['/', 'Search the list on screen'], ['↑ ↓ or j k', 'Move through a list'], ['Enter', 'Open the focused row'],
  ['Esc', 'Close'], ['?', 'Show this list'],
]
const GO = { d: '/', l: '/decisions', q: '/decisions/queue', a: '/agents', p: '/policies', s: '/settings' }

function useQueueCount() {
  const q = useResource(['escalations', 'count'], () => api.get('/api/escalations', { limit: 100 }), { refetchInterval: 30000, staleTime: 10000 })
  return q.data?.open?.length || 0
}

function LiveDot() {
  const { status } = useLive()
  const text = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'
  const title = status === 'live' ? 'Decisions arrive here as they happen.' : status === 'connecting' ? 'Connecting to the live feed…' : 'The live feed is disconnected. Lists still refresh every half minute; it reconnects on its own.'
  return (
    <span className="hidden items-center gap-1.5 rounded-md px-2 text-xs text-ink-600 sm:inline-flex" title={title} role="status">
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="3.5" className={status === 'live' ? 'fill-ok-500' : status === 'connecting' ? 'fill-warn-500' : 'fill-risk-500'} /></svg>
      <span className="font-mono text-2xs uppercase tracking-wide">{text}</span>
    </span>
  )
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(getThemeMode)
  const ref = useRef(null)
  const btn = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!ref.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const initials = (user?.email || '?').slice(0, 2).toUpperCase()
  const choose = (m) => { setTheme(m); setMode(m) }
  return (
    <div className="relative">
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true" aria-label={`Account: ${user?.email || ''}`} className="flex h-8 items-center gap-2 rounded-md pl-1 pr-1.5 hover:bg-ink-100">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 font-mono text-[10px] font-medium text-white">{initials}</span>
        <ChevronDownIcon className="hidden h-3.5 w-3.5 text-ink-500 sm:block" aria-hidden="true" />
      </button>
      {open && (
        <div ref={ref} className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-ink-200 bg-overlay p-1 shadow-overlay animate-pop">
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium text-fg">{user?.email}</p>
            <p className="mt-1 font-mono text-2xs uppercase tracking-wide text-ink-500">{user?.role || 'member'}</p>
          </div>
          <div className="my-1 h-px bg-ink-200" />
          <p className="label-mono px-2 pb-1 pt-1">Appearance</p>
          <div role="radiogroup" aria-label="Appearance" className="mx-2 mb-1 grid grid-cols-3 gap-0.5 rounded-md border border-ink-200 bg-sunken p-0.5">
            {[['light', SunIcon, 'Light'], ['dark', MoonIcon, 'Dark'], ['system', ComputerDesktopIcon, 'Auto']].map(([m, Icon, l]) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => choose(m)} className={clsx('inline-flex h-7 items-center justify-center gap-1 rounded text-xs', mode === m ? 'bg-surface font-medium text-fg shadow-[0_0_0_1px_rgb(var(--c-ink-200))]' : 'text-ink-600 hover:text-fg')}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{l}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-ink-200" />
          <a href="/download" target="_blank" rel="noopener" className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-ink-100"><ComputerDesktopIcon className="h-4 w-4" aria-hidden="true" />Get the desktop app</a>
          <button type="button" onClick={onLogout} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-risk-600 hover:bg-ink-100"><ArrowRightOnRectangleIcon className="h-4 w-4" />Sign out</button>
        </div>
      )}
    </div>
  )
}

function Plate({ area, active, badge }) {
  const Icon = area.icon
  return (
    <li>
      <Link
        to={area.href}
        title={area.label}
        aria-current={active ? 'page' : undefined}
        className={clsx('relative flex w-full flex-col items-center gap-0.5 rounded-md px-0 py-1 text-center', active ? 'bg-ink-100 text-fg' : 'text-ink-600 hover:bg-ink-100 hover:text-fg')}
      >
        {active && <span aria-hidden="true" className="absolute left-0 top-1.5 h-7 w-[2px] rounded-full bg-ink-900" />}
        <Icon className={clsx('h-5 w-5 shrink-0', active ? 'text-ink-900' : 'text-ink-500')} aria-hidden="true" />
        <span className={clsx('w-full truncate text-[10px] leading-tight tracking-tight', active && 'font-medium')}>{area.label}</span>
        {badge > 0 && <span className="absolute right-1.5 top-1 rounded bg-warn-500 px-1 font-mono text-[10px] font-medium leading-4 text-ink-950 tabular-nums" aria-label={`${badge} waiting for a person`}>{badge > 99 ? '99+' : badge}</span>}
      </Link>
    </li>
  )
}

function Spine({ located, queue }) {
  const area = located.area
  const children = area?.children || []
  if (children.length < 2) return null
  return (
    <nav aria-label={`${area.label} screens`} className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-ink-200 bg-canvas px-2 py-3 ui-scroll lg:flex">
      <Link to={area.href} className="mb-2 truncate px-2 text-sm font-semibold text-fg hover:underline">{area.label}</Link>
      <ul className="space-y-px">
        {children.map((c) => {
          const on = located.child?.href === c.href
          return (
            <li key={c.href}>
              <Link to={c.href} aria-current={on ? 'page' : undefined} className={clsx('flex h-8 items-center gap-2 rounded-md px-2 text-[13px]', on ? 'bg-ink-100 font-medium text-fg' : 'text-ink-600 hover:bg-ink-100 hover:text-fg')}>
                <span className="truncate">{c.name}</span>
                {c.badge === 'queue' && queue > 0 && <span className="ml-auto rounded bg-warn-500 px-1 font-mono text-[10px] font-medium leading-4 text-ink-950 tabular-nums">{queue}</span>}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function ShellFrame() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, workspace, logout } = useAuth()
  const queue = useQueueCount()
  const located = useMemo(() => locate(location.pathname), [location.pathname])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const crumbs = useMemo(() => {
    const out = []
    const { area, child } = located
    if (area && area.key !== 'overview') out.push({ label: area.label, to: area.href })
    if (child && child.href !== area?.href) out.push({ label: child.name, to: child.href })
    if (area?.key === 'overview') out.push({ label: child?.name || 'Dashboard' })
    if (!out.length) out.push({ label: 'EMBMIS Gateway' })
    return out
  }, [located])
  const pageLabel = crumbs[crumbs.length - 1]?.label

  useEffect(() => { document.title = pageLabel ? `${pageLabel} · EMBMIS Gateway` : 'EMBMIS Gateway' }, [pageLabel])
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  useEffect(() => {
    let pending = 0
    const typing = (el) => el?.closest?.('input,textarea,select,[contenteditable="true"],[role="combobox"]')
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); return }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[aria-modal="true"]')) return
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true); return }
      if (e.key === 'g') { pending = Date.now(); return }
      if (pending && Date.now() - pending < 900 && GO[e.key]) { e.preventDefault(); pending = 0; navigate(GO[e.key]); return }
      pending = 0
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const paletteItems = useMemo(() => {
    const pages = []
    for (const a of [...AREAS, FOOT]) {
      pages.push({ id: `page:${a.href}`, title: a.label, group: 'Pages', icon: a.icon, run: () => navigate(a.href) })
      for (const c of a.children) if (c.href !== a.href) pages.push({ id: `page:${c.href}`, title: c.name, subtitle: a.label, group: 'Pages', run: () => navigate(c.href) })
    }
    return [
      { id: 'act:agent', title: 'Create an agent', group: 'Actions', run: () => navigate('/agents?new=1') },
      { id: 'act:policy', title: 'Create a policy', group: 'Actions', run: () => navigate('/policies?new=1') },
      { id: 'act:test', title: 'Test an action against your policies', group: 'Actions', run: () => navigate('/policies/tester') },
      { id: 'act:verify', title: 'Verify the audit chain', group: 'Actions', run: () => navigate('/decisions/audit') },
      ...pages,
      { id: 'cmd:dark', title: 'Switch to dark appearance', group: 'Commands', run: () => setTheme('dark') },
      { id: 'cmd:light', title: 'Switch to light appearance', group: 'Commands', run: () => setTheme('light') },
      { id: 'cmd:keys', title: 'Keyboard shortcuts', group: 'Commands', icon: KeyIcon, hint: '?', run: () => setHelpOpen(true) },
    ]
  }, [navigate])

  const handleLogout = useCallback(async () => { await logout(); navigate('/login') }, [logout, navigate])

  // ---- Inside the EMBMIS desktop app: the desktop draws the frame (see desktopBridge.js). ----
  const { status: liveStatus } = useLive()
  useEffect(() => {
    if (!desktop) return
    const item = (a) => ({ key: a.key, label: a.label, href: a.href, match: a.match, exact: !!a.exactRoot, badge: a.badge === 'queue' ? queue : undefined, children: a.children.map((c) => ({ name: c.name, href: c.href, badge: c.badge === 'queue' ? queue : undefined })) })
    desktop.publish({
      product: 'gateway',
      nav: { groups: [{ group: 'Gateway', items: AREAS.map(item) }], foot: item(FOOT), pinned: [] },
      located: { item: located.area?.key || null, child: located.child?.href || null },
      crumbs,
      path: location.pathname + location.search,
      user: user ? { name: user.name || user.email, email: user.email, role: user.role || 'member' } : null,
      company: workspace ? { id: workspace.id, name: workspace.name } : null,
      companies: [],
      queue,
      live: liveStatus,
    })
  }, [located, crumbs, location.pathname, location.search, user, workspace, queue, liveStatus])
  useEffect(() => {
    if (!desktop) return
    setTheme('system') // the desktop decides light or dark
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onScheme = () => setTheme('system')
    mq?.addEventListener?.('change', onScheme)
    return () => mq?.removeEventListener?.('change', onScheme)
  }, [])
  const live = useRef({})
  live.current = { navigate, handleLogout, paletteItems }
  useEffect(() => {
    if (!desktop) return
    return desktop.onCommand((c) => {
      const l = live.current
      if (!c || typeof c !== 'object') return
      if (c.type === 'navigate' && typeof c.path === 'string' && c.path.startsWith('/')) l.navigate(c.path)
      else if (c.type === 'help') setHelpOpen(true)
      else if (c.type === 'palette') setPaletteOpen(true)
      else if (c.type === 'logout') l.handleLogout()
      else if (c.type === 'search' && typeof c.q === 'string' && c.id) {
        const q = c.q.trim().toLowerCase()
        const hrefOf = { 'act:agent': '/agents?new=1', 'act:policy': '/policies?new=1', 'act:test': '/policies/tester', 'act:verify': '/decisions/audit' }
        const rows = l.paletteItems.filter((i) => i.group === 'Actions' && hrefOf[i.id] && i.title.toLowerCase().includes(q)).map((i) => ({ title: i.title, subtitle: 'Gateway', group: 'Actions', href: hrefOf[i.id] }))
        desktop.reply?.(c.id, q.length < 2 ? [] : rows)
      }
    })
  }, [])

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas text-fg">
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-[100] rounded-md bg-surface px-3 py-2 text-sm font-medium text-fg shadow-overlay">Skip to content</a>

      {!inDesktop && <header className="z-topbar flex h-12 shrink-0 items-center gap-2 border-b border-ink-200 bg-surface px-2 sm:px-3">
        <Link to="/" className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-ink-100" aria-label="EMBMIS Gateway — dashboard">
          <img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="" width={22} height={22} className="rounded" />
          <span className="hidden text-sm font-semibold text-fg md:inline">EMBMIS Gateway</span>
        </Link>
        {workspace && <span className="hidden max-w-[180px] truncate rounded border border-ink-200 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide text-ink-600 md:inline" title="Workspace">{workspace.name}</span>}
        <span aria-hidden="true" className="hidden h-5 w-px bg-ink-200 md:block" />
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1
              return (
                <li key={`${c.label}-${i}`} className={clsx('flex min-w-0 items-center gap-1', !last && 'hidden shrink-0 sm:flex')}>
                  {c.to && !last ? <Link to={c.to} className="truncate rounded px-1 text-ink-500 hover:bg-ink-100 hover:text-fg">{c.label}</Link> : <span aria-current={last ? 'page' : undefined} className="truncate px-1 font-medium text-fg">{c.label}</span>}
                  {!last && <span aria-hidden="true" className="text-ink-300">/</span>}
                </li>
              )
            })}
          </ol>
        </nav>
        <LiveDot />
        <button type="button" onClick={() => setPaletteOpen(true)} className="hidden h-8 w-56 items-center gap-2 rounded-md border border-ink-200 bg-sunken px-2.5 text-sm text-ink-500 hover:border-ink-300 hover:text-ink-700 md:flex">
          <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100 md:hidden">
          <MagnifyingGlassIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <UserMenu user={user} onLogout={handleLogout} />
      </header>}

      <div className="flex min-h-0 flex-1">
        <aside className="relative hidden w-[84px] shrink-0 flex-col border-r border-ink-200 bg-surface lg:flex">
          <nav aria-label="Areas" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1.5 ui-scroll">
              <ul className="space-y-0.5">{AREAS.map((a) => <Plate key={a.key} area={a} active={located.area?.key === a.key} badge={a.badge === 'queue' ? queue : 0} />)}</ul>
            </div>
            <ul className="border-t border-ink-200 px-1.5 py-1.5"><Plate area={FOOT} active={located.area?.key === 'settings'} /></ul>
          </nav>
        </aside>
        <Spine located={located} queue={queue} />

        <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-[calc(var(--bottomnav-h)+env(safe-area-inset-bottom))] focus:outline-none lg:pb-0 ui-scroll">
          <div key={location.pathname} className="page-fade mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:py-6">
            <Outlet />
          </div>
        </main>
      </div>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-topbar grid grid-cols-5 border-t border-ink-200 bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        {[
          { label: 'Overview', icon: AREAS[0].icon, to: '/' },
          { label: 'Decisions', icon: AREAS[1].icon, to: '/decisions', badge: queue },
          { label: 'Agents', icon: AREAS[2].icon, to: '/agents' },
          { label: 'Policies', icon: AREAS[3].icon, to: '/policies' },
          { label: 'More', icon: Bars3Icon, onClick: () => setMenuOpen(true) },
        ].map((b) => {
          const active = b.to && (b.to === '/' ? location.pathname === '/' : location.pathname.startsWith(b.to))
          const inner = (
            <>
              <span className="relative">
                <b.icon className="h-6 w-6" aria-hidden="true" />
                {b.badge > 0 && <span className="absolute -right-2 -top-1 rounded bg-warn-500 px-1 font-mono text-[10px] leading-4 text-ink-950">{b.badge > 99 ? '99+' : b.badge}</span>}
              </span>
              <span className="text-[11px] font-medium">{b.label}</span>
            </>
          )
          const cls = clsx('flex h-[60px] flex-col items-center justify-center gap-0.5', active ? 'text-fg' : 'text-ink-500')
          return b.to
            ? <Link key={b.label} to={b.to} aria-current={active ? 'page' : undefined} className={cls}>{inner}</Link>
            : <button key={b.label} type="button" onClick={b.onClick} className={cls}>{inner}</button>
        })}
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="EMBMIS Gateway" side="bottom">
        <div className="space-y-4 p-3">
          {[...AREAS, FOOT].map((a) => (
            <div key={a.key}>
              <Link to={a.href} className="flex items-center gap-2 text-sm font-semibold text-fg"><a.icon className="h-4 w-4 text-ink-500" aria-hidden="true" />{a.label}</Link>
              {a.children.length > 1 && (
                <ul className="ml-6 mt-1 space-y-0.5 border-l border-ink-200 pl-3">
                  {a.children.map((c) => <li key={c.href}><Link to={c.href} className="block py-1 text-sm text-ink-700">{c.name}</Link></li>)}
                </ul>
              )}
            </div>
          ))}
          <Link to="/onboarding" className="flex items-center gap-2 text-sm text-ink-700"><RocketLaunchIcon className="h-4 w-4 text-ink-500" aria-hidden="true" />Get started</Link>
        </div>
      </Sheet>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} placeholder="Search pages and actions…" />

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="md">
        <dl className="divide-y divide-ink-100">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-ink-700">{d}</dt>
              <dd className="flex shrink-0 gap-1">{k.split(' / ').map((part) => <Kbd key={part}>{part}</Kbd>)}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </div>
  )
}

export default function Shell() {
  return (
    <LiveProvider>
      <ShellFrame />
    </LiveProvider>
  )
}
