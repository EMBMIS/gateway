#!/usr/bin/env node
/**
 * Real-browser check of the console: every route, desktop and phone, light and dark.
 *
 * Starts its own gateway on a free port with a throw-away database, seeds it through the public API
 * (scripts/demo-traffic.js), signs in, and for each route asserts:
 *   - the page rendered a heading and no error boundary text
 *   - no uncaught exception, no console error, no failed request (5xx)
 *   - at 390 px wide the page does not scroll sideways
 * and writes a screenshot per route/size/theme to SHOTS (default console/screenshots).
 *
 *   npm run build && npm run check:ui          (from console/)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const SHOTS = process.env.SHOTS || path.join(here, '..', 'screenshots')
const ROUTES = [
  ['dashboard', '/'], ['alerts', '/alerts'], ['decisions', '/decisions'], ['queue', '/decisions/queue'], ['audit', '/decisions/audit'],
  ['agents', '/agents'], ['policies', '/policies'], ['tester', '/policies/tester'], ['compliance', '/compliance'], ['vault', '/compliance/vault'],
  ['connect', '/connect'], ['keys', '/connect/keys'], ['usage', '/usage'], ['settings', '/settings'], ['onboarding', '/onboarding'],
]
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }
const THEMES = ['light', 'dark']
const only = process.env.ONLY ? process.env.ONLY.split(',') : null

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const chromePath = () => {
  if (process.env.CHROME) return process.env.CHROME
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop()
  return path.join(base, dir, 'chrome-linux', 'chrome')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-ui-'))
const port = await freePort()
// BASE_PATH=/gateway checks the console as it is served on embmis.com (build it with CONSOLE_BASE=/gateway/).
const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '')
const base = `http://127.0.0.1:${port}${basePath}`
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', PORT: String(port), SAG_BASE_PATH: basePath, SAG_DB_PATH: path.join(tmp, 'ui.db'), ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1', SAG_PLATFORM_KEYS: 'ui-check-key', SAG_REQUIRE_AUTH: '1', SAG_ADMIN_EMAILS: 'demo@example.com', LLM_API_KEY: '', OPENAI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })
const stop = () => { try { child.kill('SIGKILL') } catch { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }) }
process.on('exit', stop)

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/v1/health`)).ok) break } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150))
  if (i === 119) { console.error(serverLog); process.exit(1) }
}

process.env.SAG_URL = base
const { seed } = require(path.join(root, 'scripts', 'demo-traffic.js'))
const seeded = await seed()
console.log(`seeded: ${seeded.decisions} decisions, ${seeded.open} open escalations`)

fs.mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] })
let failures = 0
const fail = (msg) => { failures += 1; console.error(`  ✗ ${msg}`) }
let checks = 0

for (const theme of THEMES) {
  for (const [sizeName, viewport] of Object.entries(SIZES)) {
    const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 1 })
    await context.addInitScript((t) => { try { localStorage.setItem('embmis.gateway.theme', t) } catch { /* private mode */ } }, theme)
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 4(01|03|09)/.test(m.text())) problems.push(`console: ${m.text()}`) })
    page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`) })

    // Sign in through the real form.
    await page.goto(`${base}/login`)
    await page.fill('input[type="email"]', seeded.email)
    await page.fill('input[type="password"]', seeded.password)
    await page.click('button[type="submit"]')
    await page.waitForURL((u) => u.pathname.replace(/\/+$/, "") === basePath, { timeout: 15000 })

    for (const [name, route] of ROUTES) {
      if (only && !only.includes(name)) continue
      problems.length = 0
      await page.goto(base + route, { waitUntil: 'networkidle' })
      await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(250)
      const label = `${name} · ${sizeName} · ${theme}`
      checks += 1
      const info = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        text: document.body.innerText,
        dark: document.documentElement.classList.contains('dark'),
      }))
      if (!info.h1) fail(`${label}: no heading rendered`)
      if (/something went wrong|unexpected error|cannot read prop/i.test(info.text)) fail(`${label}: error text on the page`)
      if (sizeName === 'phone' && (info.overflow > 1 || info.bodyOverflow > 1)) fail(`${label}: page scrolls sideways by ${Math.max(info.overflow, info.bodyOverflow)}px`)
      if (info.dark !== (theme === 'dark')) fail(`${label}: theme not applied`)
      for (const p of problems) fail(`${label}: ${p}`)
      await page.screenshot({ path: path.join(SHOTS, `${name}-${sizeName}-${theme}.png`) })
    }

    // A decision opened, the one-click explanation.
    if (!only || only.includes('decision-detail')) {
      await page.goto(`${base}/decisions`, { waitUntil: 'networkidle' })
      const target = sizeName === 'phone' ? page.locator('main ul[aria-label] li button').first() : page.locator('table tbody tr').first()
      await target.click({ timeout: 5000 }).catch(() => {})
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).then(async () => {
        await page.waitForTimeout(400)
        checks += 1
        const t = await page.locator('[role="dialog"]').innerText()
        if (!/why/i.test(t) || !/audit chain/i.test(t)) fail(`decision detail · ${sizeName} · ${theme}: explanation sections missing`)
        await page.screenshot({ path: path.join(SHOTS, `decision-detail-${sizeName}-${theme}.png`) })
      }).catch(() => fail(`decision detail · ${sizeName} · ${theme}: no detail opened`))
    }
    await context.close()
  }
}
await browser.close()
stop()
console.log(`${checks} page checks, ${failures} failure${failures === 1 ? '' : 's'}. Screenshots: ${SHOTS}`)
process.exit(failures ? 1 : 0)
