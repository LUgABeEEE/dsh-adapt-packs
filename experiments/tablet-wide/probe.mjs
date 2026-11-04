#!/usr/bin/env node
/**
 * tablet-wide · lab probe (read-only)
 *
 *   node experiments/tablet-wide/probe.mjs [--ui-lab ../../dsh-ui-lab] [--out shots]
 *
 * Opens the real dsh-mobile gateway page (0.8.x) with dsh-ui-lab's pairing cache at
 * 1363×860 / 909×1314 / 834×1194 (below the 1100px threshold) / 1280×800 (fine
 * pointer), opens one existing session for a real conversation, then measures the
 * conversation column and composer before/after injecting `mobile.css` and with
 * `html[data-dsh-adapt="off"]`.
 *
 * It reuses dsh-ui-lab's modules (`openMobileSurface` / pairing) instead of copying
 * them; pass `--ui-lab` when the checkout is elsewhere. Nothing here writes to
 * $DSH_HOME or changes host/plugin state: it only opens a session (navigation) and
 * injects a stylesheet into the page. Screenshots go to `shots/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const uiLab = resolve(flag('ui-lab', join(HERE, '..', '..', '..', 'dsh-ui-lab')))
const outDir = resolve(flag('out', join(HERE, 'shots')))
const cssPath = join(HERE, 'mobile.css')
if (existsSync(uiLab) === false) {
  console.error(`dsh-ui-lab not found: ${uiLab} (pass --ui-lab <path>)`)
  process.exit(2)
}
const importLab = relative => import(pathToFileURL(join(uiLab, 'src', relative)).href)
const { getDefaults } = await importLab('defaults.mjs')
const { resolvePlaywright } = await importLab('playwright.mjs')
const { openMobileSurface, resolveGatewayOrigin } = await importLab('surfaces/mobile.mjs')
const { pairingStatePath } = await importLab('pairing.mjs')

const defaults = getDefaults(process.env, uiLab)
const playwright = resolvePlaywright({ explicit: defaults.playwrightModule, dshHome: defaults.dshHome })
const css = readFileSync(cssPath, 'utf8')
mkdirSync(outDir, { recursive: true })

// A leftover host-side diagnostic script (`$DSH_HOME/mobile-access/mobile.js`) paints a
// full-screen text overlay that would pollute every screenshot. Detect it, block the
// request in the browser, and record the decision instead of silently screenshotting it.
const hostOverlayFile = join(defaults.dshHome, 'mobile-access', 'mobile.js')
const hostOverlay = { file: hostOverlayFile, exists: existsSync(hostOverlayFile), blocked: false }
if (hostOverlay.exists === true) {
  hostOverlay.blocked = true
  console.warn(`WARN  host overlay detected: ${hostOverlayFile} — its request will be blocked in the probe context`)
}

const SCENARIOS = [
  { name: '1363x860', width: 1363, height: 860, coarse: true, shot: true },
  { name: '909x1314', width: 909, height: 1314, coarse: true, shot: true },
  { name: '834x1194-below-1100', width: 834, height: 1194, coarse: true, shot: false },
  { name: '1280x800-fine', width: 1280, height: 800, coarse: false, shot: false },
]

const round = value => Math.round(value * 10) / 10
const box = element => {
  if (element === null || element === undefined) return null
  const rect = element.getBoundingClientRect()
  return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
}
const measure = page => page.evaluate(() => {
  const round = value => Math.round(value * 10) / 10
  const box = element => {
    if (element === null || element === undefined) return null
    const rect = element.getBoundingClientRect()
    return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
  }
  const scroll = document.querySelector('[data-conversation-scroll]')
  const card = document.querySelector('[data-composer-card]')
  const seat = document.querySelector('[data-composer-seat]')
  const stack = card === null ? null : card.closest('[class*="composerStack"]')
  const turns = [...document.querySelectorAll('[data-chat-turn]')]
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, coarse: matchMedia('(pointer: coarse)').matches },
    wideMedia: matchMedia('(min-width: 1100px) and (pointer: coarse)').matches,
    drawer: box(document.querySelector('.dshm-drawer')),
    scroll: box(scroll),
    seat: box(seat),
    stack: box(stack),
    card: box(card),
    turnCount: turns.length,
    firstTurn: turns.length === 0 ? null : box(turns[0]),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }
})

// Pick an existing session that actually has turns, so the measurements include a
// real conversation column (not the empty "New Session" hero). Opening a session is
// navigation only; the probe never sends messages or changes settings.
const openSession = page => page.evaluate(async () => {
  const pick = () => [...document.querySelectorAll('[data-slot="sidebar"] [data-row-key]')]
    .filter(row => (row.getAttribute('data-row-key') || '').startsWith('session:'))
    .filter(row => row.getBoundingClientRect().height > 0)
    .filter(row => /^new session/i.test((row.textContent || '').trim()) === false)
  let rows = pick()
  if (rows.length === 0) {
    // Sidebar groups sessions under workspace rows; expand the first workspace.
    const workspace = [...document.querySelectorAll('[data-slot="sidebar"] [data-row-key]')]
      .find(row => (row.getAttribute('data-row-key') || '').startsWith('workspace:'))
    if (workspace !== undefined) {
      workspace.click()
      await new Promise(resolve => setTimeout(resolve, 900))
      rows = pick()
    }
  }
  for (const row of rows.slice(0, 6)) {
    row.scrollIntoView({ block: 'center' })
    row.click()
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const turns = document.querySelectorAll('[data-chat-turn]').length
    if (turns > 0) return { key: row.getAttribute('data-row-key'), label: (row.textContent || '').trim().slice(0, 40), turns }
  }
  return null
})

const results = []
const nonDedicated = { applied: false, before: null, after: null }
const browser = await playwright.chromium.launch()
try {
  for (const scenario of SCENARIOS) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      deviceScaleFactor: 2,
      isMobile: scenario.coarse,
      hasTouch: scenario.coarse,
      ignoreHTTPSErrors: true,
      storageState: pairingStatePath(defaults.stateDir),
    })
    if (hostOverlay.blocked === true) {
      await context.route('**/mobile-access/mobile.js', route => route.abort())
    }
    const page = await context.newPage()
    const gatewayOrigin = await resolveGatewayOrigin({ url: null, defaults, timeoutMs: 20_000 })
    await openMobileSurface(page, context, {
      gatewayOrigin,
      adminUrl: defaults.adminUrl,
      defaults,
      statePath: pairingStatePath(defaults.stateDir),
      fresh: false,
      waitMs: 2_500,
      timeoutMs: 45_000,
    })
    await page.waitForTimeout(1_200)
    const session = await openSession(page)
    await page.waitForTimeout(1_500)

    const before = await measure(page)
    if (scenario.shot === true) await page.screenshot({ path: join(outDir, `${scenario.name}-before.png`) })
    await page.addStyleTag({ content: css })
    await page.waitForTimeout(400)
    const after = await measure(page)
    if (scenario.shot === true) await page.screenshot({ path: join(outDir, `${scenario.name}-after.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-dsh-adapt', 'off'))
    await page.waitForTimeout(300)
    const optedOut = await measure(page)
    if (scenario.shot === true) await page.screenshot({ path: join(outDir, `${scenario.name}-opted-out.png`) })
    await page.evaluate(() => document.documentElement.removeAttribute('data-dsh-adapt'))
    await context.close()
    results.push({ scenario: scenario.name, session, before, after, optedOut })
  }

  // F2 counterexample: a stock-like page (≥1100px, coarse) with the same data
  // attributes but no `.dshm-shell` must not be touched by the experiment.
  {
    const context = await browser.newContext({ viewport: { width: 1363, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await page.setContent(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}[data-conversation-scroll]{width:1023px;height:700px}[data-composer-card]{width:712px;height:98px}</style></head><body><div data-conversation-scroll><div data-chat-turn style="width:680px;height:80px">turn</div></div><div data-composer-card>composer</div></body></html>`, { waitUntil: 'load' })
    const before = await page.evaluate(() => {
      const scroll = document.querySelector('[data-conversation-scroll]').getBoundingClientRect()
      const card = document.querySelector('[data-composer-card]').getBoundingClientRect()
      return { scroll: { x: scroll.x, y: scroll.y, w: scroll.width, h: scroll.height }, card: { x: card.x, y: card.y, w: card.width, h: card.height } }
    })
    await page.addStyleTag({ content: css })
    await page.waitForTimeout(200)
    const after = await page.evaluate(() => {
      const scroll = document.querySelector('[data-conversation-scroll]').getBoundingClientRect()
      const card = document.querySelector('[data-composer-card]').getBoundingClientRect()
      return { scroll: { x: scroll.x, y: scroll.y, w: scroll.width, h: scroll.height }, card: { x: card.x, y: card.y, w: card.width, h: card.height } }
    })
    nonDedicated.before = before
    nonDedicated.after = after
    nonDedicated.applied = Math.abs(before.scroll.w - after.scroll.w) > 1 || Math.abs(before.card.w - after.card.w) > 1
    await context.close()
  }
} finally {
  await browser.close()
}

const same = (left, right, tolerance = 3) => left !== null && right !== null && ['x', 'y', 'w', 'h'].every(key => Math.abs(left[key] - right[key]) <= tolerance)
const checks = []
for (const result of results) {
  const { scenario, before, after, optedOut } = result
  if (scenario.startsWith('1363')) {
    checks.push([`${scenario}: scroll 720 居中`, after.scroll?.w === 720 && Math.abs(after.scroll.x - (1363 + before.drawer.w - 720) / 2) <= 1.5])
    checks.push([`${scenario}: composer 贴齐列宽（≤720，headless 滚动条差 ≤8）`, after.card !== null && after.card.w <= 720 && after.card.w >= 700])
    checks.push([`${scenario}: 正文列仍为宿主 680`, before.firstTurn !== null && after.firstTurn !== null && Math.abs(after.firstTurn.w - before.firstTurn.w) <= 2])
    checks.push([`${scenario}: 会话内容列未被收窄`, before.firstTurn !== null && after.firstTurn !== null && Math.abs(after.firstTurn.w - before.firstTurn.w) <= 2])
    checks.push([`${scenario}: 侧栏不动`, same(before.drawer, after.drawer)])
    checks.push([`${scenario}: opt-out 回落`, same(before.scroll, optedOut.scroll) && same(before.card, optedOut.card)])
  }
  if (scenario.startsWith('909')) {
    // 媒体查询改为 min-width:1100px 后，909 竖屏不再命中；必须完全不变。
    checks.push([`${scenario}: 规则不命中（<1100）`, after.wideMedia === false])
    checks.push([`${scenario}: 主区完全不变`, same(before.scroll, after.scroll)])
    checks.push([`${scenario}: composer 完全不变`, same(before.card, after.card)])
    checks.push([`${scenario}: opt-out 回落`, same(before.scroll, optedOut.scroll)])
  }
  if (scenario.startsWith('834') || scenario.startsWith('1280')) {
    checks.push([`${scenario}: 规则不命中`, same(before.scroll, after.scroll) && same(before.card, after.card) && after.wideMedia === false])
  }
  checks.push([`${scenario}: 无横向溢出`, after.overflow === false])
}
checks.push(['non-dedicated ≥1100 coarse: 实验不生效', nonDedicated.applied === false])
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
writeFileSync(join(outDir, 'measurements.json'), `${JSON.stringify({ hostOverlay, nonDedicated, results }, null, 2)}\n`)
console.log(`\nresults → ${join(outDir, 'measurements.json')}`)
if (checks.some(([, ok]) => ok === false)) process.exit(1)
