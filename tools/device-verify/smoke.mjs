#!/usr/bin/env node
/**
 * device-verify smoke run.
 *
 *   node tools/device-verify/smoke.mjs --offline
 *   node tools/device-verify/smoke.mjs --gateway https://192.168.1.11:3443
 *
 * `--offline` only assembles the injected file and checks that it parses; it
 * needs no browser, no gateway and no phone, so it is safe in CI.
 *
 * Without `--offline` it opens the *real* dsh-mobile page in headless Chromium
 * (reusing the ui-lab pairing cache), injects the exact same file `run.mjs
 * overlay on` would write, waits for the published report and prints the
 * summary. It never writes to DSH_HOME and never starts or stops the gateway.
 *
 * The headless run is deliberately not a substitute for a phone: no soft
 * keyboard, no WebView, no safe-area. It proves the pilot, the waits, the
 * opt-out toggle and the JSON export work against today's page.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildInjection,
  createSinkServer,
  loadConfig,
  loadOverlayLib,
  mergeCli,
  parseArgs,
  waitForReport,
} from './run-lib.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(TOOL_DIR, '..', '..')
const LIB_PATH = join(TOOL_DIR, 'overlay-lib.js')
const OVERLAY_PATH = join(TOOL_DIR, 'overlay.js')
const DEFAULT_CONFIG = join(TOOL_DIR, 'scenarios.json')
const OUT_ROOT = join(ROOT, '.cache', 'device-verify')
const ADMIN = process.env.DSH_UI_LAB_URL ?? 'http://127.0.0.1:3080'

const lib = loadOverlayLib(LIB_PATH)

function log(message) {
  console.log(`smoke: ${message}`)
}

function fail(message) {
  console.error(`smoke: ${message}`)
  process.exit(1)
}

export function injectionFor(config) {
  return buildInjection({
    config,
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
}

export async function offline(options) {
  const config = mergeCli(loadConfig(options.config === undefined ? DEFAULT_CONFIG : resolve(options.config)), {})
  const injection = injectionFor({ ...config, autoStart: false })
  assertParses(injection)
  const normalized = lib.normalizeConfig(config)
  log(`offline OK · injection ${injection.length}B · ${normalized.scenarios.length} scenario(s) · sink=${normalized.sinkUrl ?? 'off'}`)
  for (const scenario of normalized.scenarios) log(`  ${scenario.name}: ${scenario.labels.join(' | ')}`)
  const report = lib.buildReport({ started: true, env: { inner: { width: 390, height: 844 } }, scenarios: [] })
  const roundTrip = JSON.parse(JSON.stringify(report))
  if (roundTrip.schema !== lib.SCHEMA) fail('report does not survive a JSON round-trip')
  if (lib.decodeTitle(lib.encodeTitle(report, 20000).title).report?.schema !== lib.SCHEMA) fail('title encoding does not round-trip')
  assertParses(`window.__dvReport = ${JSON.stringify(report)};`)
  log(`offline OK · empty report encodes to a ${lib.encodeTitle(report, 20000).bytes}B title`)
}

function assertParses(source) {
  try {
    new Function(source) // eslint-disable-line no-new-func
  } catch (error) {
    fail(`injected script does not parse: ${error.message}`)
  }
}

/**
 * A real reachability check, so `--gateway https://127.0.0.1:3999` fails loudly
 * instead of silently falling back to the admin status (F2).
 *
 * It is a TCP connect, not an HTTP fetch: the gateway uses a private CA that Node
 * does not trust (Playwright ignores TLS errors, Node does not), and "is anything
 * listening on this host:port" is exactly the question we need answered.
 *
 * @returns {Promise<{ok: boolean, url: string, port?: number, error?: string}>}
 */
export async function probeGateway(url, timeoutMs = 4000) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return { ok: false, url: String(url), error: 'invalid URL' }
  }
  const port = Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port)
  const host = parsed.hostname
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (ok, error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, url: `${parsed.origin}/`, port, ...(error === undefined ? {} : { error }) })
    }
    socket.setTimeout(timeoutMs, () => finish(false, `timeout after ${timeoutMs}ms`))
    socket.once('connect', () => finish(true))
    socket.once('error', error => finish(false, error.code ?? error.message))
  })
}

export async function resolveGateway(options) {
  if (options.gateway !== undefined) return String(options.gateway).replace(/\/+$/u, '')
  const response = await fetch(`${ADMIN}/api/mobile-access/status`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (response === null || response.ok === false) {
    fail(`cannot read ${ADMIN}/api/mobile-access/status; pass --gateway https://<host>:3443`)
  }
  const status = await response.json()
  const origin = status?.gateway?.origin
  if (typeof origin !== 'string' || origin === '') fail('the admin status has no gateway.origin; is LAN mobile access enabled?')
  return origin
}

export function resolveStatePath(options) {
  if (options.state !== undefined) {
    const path = resolve(options.state)
    if (existsSync(path) === false) fail(`pairing cache not found: ${path}`)
    return path
  }
  const candidates = [
    process.env.DSH_UI_LAB_STATE_DIR === undefined ? null : join(process.env.DSH_UI_LAB_STATE_DIR, 'mobile-state.json'),
    join(ROOT, '..', 'dsh-ui-lab', '.cache', 'mobile-state.json'),
    join(ROOT, '.cache', 'mobile-state.json'),
  ].filter(Boolean)
  const found = candidates.find(path => existsSync(path))
  if (found === undefined) fail('no pairing cache; pair once with dsh-ui-lab or pass --state <mobile-state.json>')
  return found
}

function loadPlaywright() {
  const roots = [process.env.PLAYWRIGHT_ROOT, join(ROOT, '..', 'dsh-ui-lab'), ROOT].filter(Boolean)
  for (const base of roots) {
    try {
      const require = createRequire(join(base, 'package.json'))
      return require('playwright')
    } catch { /* try the next root */ }
  }
  fail('playwright not found: install dsh-ui-lab (it ships playwright) or set PLAYWRIGHT_ROOT')
}

async function live(options) {
  const config = mergeCli(loadConfig(options.config === undefined ? DEFAULT_CONFIG : resolve(options.config)), options)
  const sink = createSinkServer({ port: Number(options.sinkPort ?? 0) })
  const address = await sink.listen()
  const noPilot = options['no-pilot'] === 'true'
  const injection = injectionFor({
    ...config,
    autoStart: noPilot !== true,
    noPilot,
    startDelayMs: Number(options['start-delay'] ?? 2500),
    sinkUrl: sink.url,
  })
  assertParses(injection)
  log(`sink ${sink.url} · injection ${injection.length}B`)

  const gateway = await resolveGateway(options)
  const preflight = await probeGateway(gateway)
  if (preflight.ok === false) {
    console.error(`smoke: gateway ${preflight.url} is not reachable (${preflight.error})`)
    console.error('smoke: refusing to fall back to another gateway — pass a reachable --gateway or start the gateway')
    process.exitCode = 1
    await sink.close()
    return
  }
  log(`gateway ${preflight.url} reachable (tcp ${preflight.port})`)
  const statePath = resolveStatePath(options)
  const timeoutMs = Number(options.timeout ?? 150) * 1000
  const outDir = join(OUT_ROOT, `smoke-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
  mkdirSync(outDir, { recursive: true })
  let browser = null
  // Declared outside the try so the failure path can report what the page said.
  const consoleLines = []

  try {
    const { chromium } = loadPlaywright()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: Number(options.width ?? 390), height: Number(options.height ?? 844) },
      deviceScaleFactor: Number(options.dpr ?? 3),
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      storageState: statePath,
    })
    const page = await context.newPage()
    page.on('console', message => {
      const text = message.text()
      if (text.includes('[dsh-verify]')) consoleLines.push(text)
    })
    page.on('pageerror', error => consoleLines.push(`pageerror: ${error.message}`))
    page.on('requestfailed', request => {
      if (consoleLines.length < 40) consoleLines.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })

    log(`gateway ${gateway} (explicit)`)
    await page.goto(`${gateway}/`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForSelector('.dshm-shell', { timeout: 30000 })
    log('shell mounted; injecting the overlay')
    await page.addScriptTag({ content: injection })

    if (noPilot) {
      // --no-pilot: the overlay must NOT drive the page; the run starts on demand.
      await page.waitForFunction(() => window.__dshVerify !== undefined, { timeout: 15000 })
      const phase = await page.evaluate(() => window.__dshVerify.state.phase)
      const running = await page.evaluate(() => window.__dshVerify.state.piloting === true)
      log(`no-pilot: phase="${phase}" piloting=${running}`)
      if (running === true || /idle/.test(phase) === false) {
        fail(`--no-pilot did not leave the page idle (phase="${phase}", piloting=${running})`)
      }
      await page.evaluate(() => window.__dvRun())
      log('no-pilot: window.__dvRun() started the pilot manually')
    }

    const started = Date.now()
    // `window.__dvReport` is the primary channel here: a headless Chromium may
    // refuse the https→http loopback POST under its local-network policy, and
    // that is a fact worth printing rather than a reason to hang.
    const pageReport = page.waitForFunction(() => window.__dvReport !== undefined, { timeout: timeoutMs }).then(() => true).catch(() => false)
    const sinkReport = waitForReport(sink, { timeoutMs, accept: entry => lib.isReport(entry.report) })
    await Promise.race([pageReport, sinkReport.then(result => result.ok)])
    await page.waitForTimeout(2000)
    const elapsed = Date.now() - started
    const sinkStatus = sink.requests.length > 0 ? `posted ${sink.requests.length}` : 'no POST'

    const report = await page.evaluate(() => window.__dvReport ?? null) ?? (sink.requests.length > 0 ? sink.requests[sink.requests.length - 1].report : null)
    if (report === null) {
      const diagnostics = await page.evaluate(() => ({
        shell: document.querySelector('.dshm-shell') !== null,
        title: document.title.slice(0, 120),
        overlay: document.getElementById('dsh-verify-overlay') !== null,
        error: window.__dvError ?? null,
      }))
      writeFileSync(join(outDir, 'diagnostics.json'), JSON.stringify({ diagnostics, consoleLines }, null, 2))
      await page.screenshot({ path: join(outDir, 'no-report.png') })
      fail(`no report after ${Math.round(elapsed / 1000)}s · ${JSON.stringify({ diagnostics, consoleLines })}`)
    }

    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(outDir, 'console.log'), `${consoleLines.join('\n')}\n`)
    await page.screenshot({ path: join(outDir, 'mobile.png') })
    const title = await page.title()
    const decoded = lib.decodeTitle(title)
    writeFileSync(join(outDir, 'title.txt'), `${title}\n`)

    // Optional keyboard probe proof: shrink the viewport the way adjustResize
    // does and check that the *live* report flips to open=true with a matching
    // delta. This is the mechanism t18 fixed; the real IME needs a finger tap.
    if (options['keyboard-test'] === 'true') {
      const closed = await page.evaluate(() => window.__dvReport?.keyboard ?? null)
      const baseHeight = Number(options.height ?? 844)
      const shrink = Number(options['keyboard-shrink'] ?? 400)
      await page.setViewportSize({ width: Number(options.width ?? 390), height: baseHeight - shrink })
      await page.waitForTimeout(1600)
      const open = await page.evaluate(() => window.__dvReport?.keyboard ?? null)
      const events = await page.evaluate(() => window.__dvReport?.viewportEvents?.length ?? 0)
      writeFileSync(join(outDir, 'keyboard-test.json'), JSON.stringify({ closed, open, events }, null, 2))
      const deltaOk = open !== null && Math.abs((open.innerDelta ?? 0) + shrink) <= 2
      log(`keyboard-test: closed.open=${closed?.open} open.open=${open?.open} innerDelta=${open?.innerDelta} source=${open?.source} events=${events}`)
      if (open?.open !== true || deltaOk === false) {
        console.error('  FAIL: the live report did not follow the viewport shrink')
        process.exitCode = 1
      } else {
        log(`keyboard-test OK: open=true, innerDelta=${open.innerDelta} (expected -${shrink}), viewportEvents=${events}`)
      }
      const restored = await page.setViewportSize({ width: Number(options.width ?? 390), height: baseHeight })
      void restored
      await page.waitForTimeout(600)
    }

    const summary = lib.summarize(report)
    summary.forEach(line => console.log(`  ${line}`))
    log(`report from window.__dvReport in ${Math.round(elapsed / 1000)}s; sink channel: ${sinkStatus} → ${join(outDir, 'report.json')}`)
    log(`document.title carries ${decoded === null ? 'no' : decoded.truncated ? 'a truncated' : 'the full'} report (${title.length}B)`)
    log(`screenshot → ${join(outDir, 'mobile.png')}`)

    const failed = report.scenarios.filter(item => item.status === 'failed')
    if (failed.length > 0) {
      for (const item of failed) {
        const reason = lib.reason(item.reason ?? 'unknown')
        console.error(`  FAIL ${item.name}: ${item.reason} — ${reason.message}`)
        if (reason.hint !== '') console.error(`       hint: ${reason.hint}`)
      }
      process.exitCode = 1
    }
    if (report.aborted !== null) {
      console.error(`  ABORT ${report.aborted.reason}: ${report.aborted.message ?? ''}`)
      process.exitCode = 1
    }
    for (const line of consoleLines) console.log(`  [page] ${line}`)
  } catch (error) {
    // F5: goto / shell / evaluate failures used to leave an empty outDir.
    const diagnostics = {
      phase: 'browser',
      url: gateway,
      error: String(error && error.stack ? error.stack : error),
      hint: 'the gateway must be reachable from here; for the real device use run.mjs report --channel screenshot',
      consoleLines,
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2))
    console.error(`smoke: ${diagnostics.error.split('\n')[0]}`)
    console.error(`smoke: diagnostics → ${join(outDir, 'diagnostics.json')}`)
    process.exitCode = 1
  } finally {
    if (browser !== null) await browser.close().catch(() => {})
    await sink.close()
  }
}

export async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  // `--offline` may be the first argument (parseArgs treats argv[0] as the
  // command) or a flag after another command.
  const wantsOffline = command === 'offline' || command === '--offline' || options.offline === 'true'
  if (wantsOffline) {
    await offline(options)
    return
  }
  await live(options)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main().catch(error => fail(String(error && error.stack ? error.stack : error)))
