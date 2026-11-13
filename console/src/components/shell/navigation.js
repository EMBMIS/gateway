import {
  HomeIcon, ShieldCheckIcon, CpuChipIcon, ScaleIcon, ClipboardDocumentCheckIcon,
  PuzzlePieceIcon, ChartBarIcon, Cog6ToothIcon,
} from '@heroicons/react/24/outline'

/**
 * Navigation, as the console's authoring model: one plate per area in the dock, the area's own screens beside it.
 * `match` decides which area a path belongs to (longest prefix wins).
 */
export const AREAS = [
  {
    key: 'overview', label: 'Overview', icon: HomeIcon, href: '/', match: ['/', '/alerts'], exactRoot: true,
    children: [{ name: 'Dashboard', href: '/' }, { name: 'Alerts', href: '/alerts' }],
  },
  {
    key: 'decisions', label: 'Decisions', icon: ShieldCheckIcon, href: '/decisions', match: ['/decisions'], badge: 'queue',
    children: [
      { name: 'All decisions', href: '/decisions' },
      { name: 'Escalation queue', href: '/decisions/queue', badge: 'queue' },
      { name: 'Audit and chain', href: '/decisions/audit' },
    ],
  },
  { key: 'agents', label: 'Agents', icon: CpuChipIcon, href: '/agents', match: ['/agents'], children: [] },
  {
    key: 'policies', label: 'Policies', icon: ScaleIcon, href: '/policies', match: ['/policies'],
    children: [{ name: 'Policies', href: '/policies' }, { name: 'Policy tester', href: '/policies/tester' }],
  },
  {
    key: 'compliance', label: 'Compliance', icon: ClipboardDocumentCheckIcon, href: '/compliance', match: ['/compliance'],
    children: [{ name: 'Compliance', href: '/compliance' }, { name: 'Data vault', href: '/compliance/vault' }],
  },
  {
    key: 'connect', label: 'Connect', icon: PuzzlePieceIcon, href: '/connect', match: ['/connect'],
    children: [{ name: 'Integration guides', href: '/connect' }, { name: 'API keys', href: '/connect/keys' }],
  },
  { key: 'usage', label: 'Usage', icon: ChartBarIcon, href: '/usage', match: ['/usage'], children: [] },
]

export const FOOT = {
  key: 'settings', label: 'Settings', icon: Cog6ToothIcon, href: '/settings', match: ['/settings', '/onboarding'],
  children: [{ name: 'Settings', href: '/settings' }, { name: 'Get started', href: '/onboarding' }],
}

/** Which area and which child the path belongs to. */
export function locate(pathname) {
  const all = [...AREAS, FOOT]
  let best = null
  let len = -1
  for (const area of all) {
    for (const prefix of area.match) {
      const hit = prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`)
      if (hit && prefix.length > len) { best = area; len = prefix.length }
    }
  }
  let child = null
  let clen = -1
  for (const c of best?.children || []) {
    const hit = c.href === '/' ? pathname === '/' : pathname === c.href || pathname.startsWith(`${c.href}/`)
    if (hit && c.href.length > clen) { child = c; clen = c.href.length }
  }
  return { area: best, child }
}
