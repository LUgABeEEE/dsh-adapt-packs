#!/usr/bin/env node
/**
 * Real-device verification driver (v2).
 *
 * Thin, explicit wrapper around adb: it never guesses coordinates and never
 * simulates a "pass". A human (or an agent reading the JSON) decides what a run
 * means; this tool collects state, configures scenarios, and pulls the report the
 * page publishes.
 *
 *   node tools/device-verify/run.mjs doctor
 *   node tools/device-verify/run.mjs devices
 *   node tools/device-verify/run.mjs info --serial <id>
 *   node tools/device-verify/run.mjs scenarios [--config f] [--json]
 *   node tools/device-verify/run.mjs overlay on|off|status [--scenarios a,b] [--port 8799]
 *   node tools/device-verify/run.mjs reload [--gesture]
 *   node tools/device-verify/run.mjs channels
 *   node tools/device-verify/run.mjs report [--port 8799] [--timeout 180] [--shot]
 *   node tools/device-verify/run.mjs report --channel auto|sink|logcat|screenshot [--wait 20]
 *   node tools/device-verify/run.mjs run    [--port 8799] [--timeout 180] [--shot] [--shutdown]
 *   node tools/device-verify/run.mjs shot   [--label before-open]
 *   node tools/device-verify/run.mjs tap    [--x 120] [--y 480] [--finger|--mode finger|plain]
 *   node tools/device-verify/run.mjs ime    status|close|open --x 120 --y 480 [--finger]
 *   node tools/device-verify/run.mjs swipe  [--x1 200] [--y1 700] [--x2 200] [--y2 300]
 *   node tools/device-verify/run.mjs rotate 0|1
 *   node tools/device-verify/run.mjs key    home|back|enter|power
 *
 * DSH_HOME defaults to ~/.dsh; the overlay is written to
 * <DSH_HOME>/mobile-access/mobile.js and restored by `overlay off`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInjection,
  createSinkServer,
  decodeLogcat,
  formatSummary,
  loadConfig,
  loadOverlayLib,
  mergeCli,
  parseArgs,
  waitForReport,
  INJECTION_MARKER,
} from './run-lib.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(TOOL_DIR, '..', '..')
const LIB_PATH = join(TOOL_DIR, 'overlay-lib.js')
const OVERLAY_PATH = join(TOOL_DIR, 'overlay.js')
const DEFAULT_CONFIG = join(TOOL_DIR, 'scenarios.json')
const ADB = process.env.ADB ?? '/data/agent/tools/android/platform-tools/adb'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CUSTOM_JS = join(DSH_HOME, 'mobile-access', 'mobile.js')
const CUSTOM_BACKUP = join(DSH_HOME, 'mobile-access', 'mobile.js.device-verify-backup')
const OUT_ROOT = join(ROOT, '.cache', 'device-verify')
const APP_PACKAGE = process.env.DSH_MOBILE_PACKAGE ?? 'io.github.sayach.dshmobile'

const lib = loadOverlayLib(LIB_PATH)

function fail(message) {
  console.error(`device-verify: ${message}`)
  process.exit(1)
}

function adb(args, { serial, buffer = false } = {}) {
  const full = serial === undefined ? args : ['-s', serial, ...args]
  return execFileSync(ADB, full, {
    encoding: buffer ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
}

function adbTry(args, options) {
  try {
    return { ok: true, out: adb(args, options) }
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : ''
    return { ok: false, out: '', error: stderr !== '' ? stderr : String(error && error.message ? error.message : error) }
  }
}

function devices() {
  return adbTry(['devices', '-l']).out.trim()
}

function deviceSerials() {
  return devices()
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(fields => fields.length >= 2 && fields[1] === 'device')
    .map(fields => fields[0])
}

function serial(options) {
  if (options.serial !== undefined) return options.serial
  const found = deviceSerials()
  if (found.length === 0) fail('no authorized device; plug in USB and accept the RSA prompt (or set --serial)')
  return found[0]
}

function info(target) {
  const props = ['ro.product.model', 'ro.product.brand', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi']
  const table = {}
  for (const prop of props) table[prop] = adb(['shell', 'getprop', prop], { serial: target }).trim()
  table.size = adb(['shell', 'wm', 'size'], { serial: target }).trim()
  table.density = adb(['shell', 'wm', 'density'], { serial: target }).trim()
  try {
    const webview = adb(['shell', 'dumpsys', 'webviewupdate'], { serial: target })
    table.webview = (webview.match(/Current WebView package[^\n]*/u) ?? [''])[0].trim()
  } catch { table.webview = 'unavailable' }
  try {
    table.app = adb(['shell', 'dumpsys', 'package', 'io.github.sayach.dshmobile'], { serial: target })
      .split('\n').find(line => line.includes('versionName='))?.trim() ?? 'not installed'
  } catch { table.app = 'not installed' }
  return table
}

// --------------------------------------------------------------- overlay file

function isOverlay(path) {
  try {
    return readFileSync(path, 'utf8').includes(INJECTION_MARKER)
  } catch {
    return false
  }
}

function overlayState() {
  const installed = existsSync(CUSTOM_JS) && isOverlay(CUSTOM_JS)
  const backup = existsSync(CUSTOM_BACKUP)
  return {
    mobileJs: existsSync(CUSTOM_JS) ? (installed ? 'overlay' : 'user-file') : 'absent',
    installed,
    backup: backup ? (isOverlay(CUSTOM_BACKUP) ? 'overlay' : 'user-file') : 'absent',
    path: CUSTOM_JS,
    backupPath: CUSTOM_BACKUP,
  }
}

function effectiveConfig(options) {
  const configPath = options.config === undefined ? DEFAULT_CONFIG : resolve(options.config)
  if (existsSync(configPath) === false) fail(`config not found: ${configPath}`)
  return mergeCli(loadConfig(configPath), options)
}

function overlayOn(options) {
  const config = effectiveConfig(options)
  mkdirSync(dirname(CUSTOM_JS), { recursive: true })
  // Only a real user file is worth restoring; a previous overlay must never become
  // its own "backup", which would leave the overlay installed after `overlay off`.
  if (existsSync(CUSTOM_BACKUP) === false && existsSync(CUSTOM_JS) && isOverlay(CUSTOM_JS) === false) {
    copyFileSync(CUSTOM_JS, CUSTOM_BACKUP)
  }
  const injection = buildInjection({
    config,
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
  writeFileSync(CUSTOM_JS, injection)
  console.log(`overlay written to ${CUSTOM_JS} (${injection.length}B)`)
  console.log(`scenarios: ${config.scenarios.map(item => item.name).join(', ')}`)
  console.log(`sink: ${config.sinkUrl ?? 'off'}`)
  console.log('the gateway picks it up within ~2s; reload the mobile page (or `run.mjs reload`)')
  if (config.sinkUrl !== null) console.log(`then: node tools/device-verify/run.mjs report --port ${new URL(config.sinkUrl).port || 8799}`)
}

function overlayOff() {
  const backupIsReal = existsSync(CUSTOM_BACKUP) && isOverlay(CUSTOM_BACKUP) === false
  if (backupIsReal) {
    copyFileSync(CUSTOM_BACKUP, CUSTOM_JS)
    rmSync(CUSTOM_BACKUP)
    console.log('overlay removed, previous mobile.js restored')
    return
  }
  if (existsSync(CUSTOM_BACKUP)) rmSync(CUSTOM_BACKUP)
  if (existsSync(CUSTOM_JS) && isOverlay(CUSTOM_JS)) {
    rmSync(CUSTOM_JS)
    console.log('overlay removed')
    return
  }
  console.log(existsSync(CUSTOM_JS) ? 'mobile.js is not ours; left untouched' : 'no overlay present')
}

// ------------------------------------------------------------------- capture

function shot(target, label, outDir) {
  const directory = outDir ?? join(OUT_ROOT, target, new Date().toISOString().replace(/[:.]/gu, '-'))
  mkdirSync(directory, { recursive: true })
  const name = `${label ?? 'shot'}.png`
  writeFileSync(join(directory, name), adb(['exec-out', 'screencap', '-p'], { serial: target, buffer: true }))
  console.log(`screenshot → ${join(directory, name)}`)
  return join(directory, name)
}

const ADMIN = process.env.DSH_UI_LAB_URL ?? 'http://127.0.0.1:3080'

async function gatewayOrigin() {
  try {
    const response = await fetch(`${ADMIN}/api/mobile-access/status`, { signal: AbortSignal.timeout(3000) })
    if (response.ok === false) return null
    const status = await response.json()
    return typeof status?.gateway?.origin === 'string' ? status.gateway.origin : null
  } catch {
    return null
  }
}

/** Print what each channel can actually do here, before an expensive wait. */
function describeChannels(origin, sinkUrl) {
  const https = typeof origin === 'string' && origin.startsWith('https://')
  const loopbackHttp = typeof sinkUrl === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/u.test(sinkUrl)
  console.log('channels:')
  console.log(`  sink     ${sinkUrl ?? 'off'}${https && loopbackHttp ? '  ← page is https, this is http loopback: WebView blocks it (mixed content)' : ''}`)
  console.log('  logcat   depends on the App forwarding WebView console; unverified per device')
  console.log('  screenshot always works — `run.mjs report --channel screenshot` or `run.mjs shot --label report`')
  console.log('  title    only readable from a browser/CDP session (headless smoke)')
  if (https && loopbackHttp) console.log('  → on a real device expect the screenshot channel to be the one that works')
}

function logcatDump(target, tail = 3000) {
  const result = adbTry(['logcat', '-d', '-t', String(tail)], target)
  if (result.ok === false) return { ok: false, error: result.error }
  return { ok: true, lines: result.out.split('\n').filter(line => line.includes('dsh-verify')) }
}

function clearLogcat(target) {
  return adbTry(['logcat', '-c'], target).ok
}

/**
 * Collect the report from whichever channel delivers first: the loopback POST
 * (needs adb reverse) or the WebView console → logcat text (needs neither).
 */
async function waitForAnyReport({ sink, target, timeoutMs, channel }) {
  const started = Date.now()
  const wantSink = channel !== 'logcat'
  const wantLogcat = channel !== 'sink'
  let logcatError = null
  let logcatLines = 0
  for (;;) {
    if (wantSink) {
      const hits = sink.requests.filter(entry => lib.isReport(entry.report))
      if (hits.length > 0) {
        const entry = hits[hits.length - 1]
        return { ok: true, channel: 'sink', report: entry.report, bytes: entry.bytes, waitedMs: Date.now() - started }
      }
    }
    if (wantLogcat) {
      const dump = logcatDump(target)
      if (dump.ok === false) logcatError = dump.error
      else {
        logcatLines = dump.lines.length
        const decoded = decodeLogcat(dump.lines)
        if (decoded.ok) {
          return { ok: true, channel: 'logcat', report: decoded.report, bytes: decoded.bytes, chunks: decoded.chunks, waitedMs: Date.now() - started }
        }
      }
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, waitedMs: Date.now() - started, logcatError, logcatLines }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
  }
}

async function screenshotReport(target, options) {
  const outDir = options.out === undefined
    ? join(OUT_ROOT, target, new Date().toISOString().replace(/[:.]/gu, '-'))
    : resolve(options.out)
  const waitSeconds = Number(options.wait ?? 20)
  if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
    console.log(`screenshot channel: waiting ${waitSeconds}s for the pilot, then capturing the overlay panel…`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, waitSeconds * 1000))
  }
  const file = shot(target, 'report', outDir)
  console.log('\nread the numbers in the overlay panel at the top of the screenshot:')
  console.log('  每行：ok|FAIL <场景>: n=… min=… <44=… hit=… opt=<44=… flo=… ovf=… <ms>ms')
  console.log('  末行：cleanup / export title=… sink=… logcat=… / ABORT=…')
  console.log(`screenshot: ${file}`)
  return { ok: true, screenshot: file }
}

async function report(target, options) {
  const channel = options.channel ?? 'auto'
  if (channel === 'screenshot') return screenshotReport(target, options)
  const port = Number(options.port ?? 8799)
  if (Number.isFinite(port) === false || port <= 0) fail(`bad --port: ${String(options.port)}`)
  const timeoutMs = Number(options.timeout === undefined ? 180 : options.timeout) * 1000
  const outDir = options.out === undefined
    ? join(OUT_ROOT, target, new Date().toISOString().replace(/[:.]/gu, '-'))
    : resolve(options.out)

  const sink = createSinkServer({ port })
  try {
    await sink.listen()
  } catch (error) {
    fail(`cannot listen on 127.0.0.1:${port} (${error.code ?? 'error'}); another run may hold it — pass --port`)
  }

  if (channel !== 'sink') clearLogcat(target)
  const reverse = channel === 'logcat' ? { ok: false, error: 'disabled (--channel logcat)' } : adbTry(['reverse', `tcp:${port}`, `tcp:${port}`], target)
  const origin = await gatewayOrigin()
  const effective = effectiveConfig(options)
  console.log(`gateway: ${origin ?? 'unknown'} · sink listening on ${sink.url}`)
  console.log(reverse.ok ? `adb reverse tcp:${port} → host:${port}` : `sink channel unusable: ${reverse.error}`)
  describeChannels(origin, effective.sinkUrl ?? null)
  console.log(`waiting up to ${Math.round(timeoutMs / 1000)}s (${channel})…`)

  try {
    const hit = channel === 'sink'
      ? await waitForReport(sink, { timeoutMs, accept: entry => lib.isReport(entry.report) }).then(result => result.ok ? { ok: true, channel: 'sink', report: result.entry.report, bytes: result.entry.bytes, waitedMs: result.waitedMs } : result)
      : await waitForAnyReport({ sink, target, timeoutMs, channel })
    if (hit.ok === false) {
      console.error('\nno report arrived over the network/console channels.')
      const state = overlayState()
      console.error(`  1. overlay not installed        → ${state.installed ? 'installed now' : 'NOT installed: run `overlay on`'}`)
      console.error('  2. page not reloaded since install → mobile page must re-fetch mobile.js (~2s hot reload)')
      console.error('  3. adb reverse missing          → see `adb reverse --list` below')
      console.error('  4. sink URL mismatch            → injected config must POST to this port (see `scenarios --json`)')
      console.error('  5. page crashed / app backgrounded → bring the App to the foreground')
      console.error(`  6. logcat channel empty         → ${hit.logcatLines ?? 0} matching [dsh-verify] line(s), error=${hit.logcatError ?? 'none'}`)
      if ((hit.logcatLines ?? 0) === 0) {
        console.error('\n   logcat verdict: this App/WebView did not forward console output to logcat,')
        console.error('   so the logcat channel cannot be used here. That is the case on the')
        console.error('   Xiaomi Pad 9 Pro Max (Android 17 / WebView 150) measured on 2026-11-02.')
      }
      console.error('\n   real-device data flow that always works:')
      console.error('     node tools/device-verify/run.mjs report --channel screenshot --wait 20')
      console.error('     (or `shot --label report`) → read the overlay panel text in the screenshot')
      console.error('   sink needs an HTTPS or same-origin endpoint; logcat needs App console forwarding.')
      console.error(`\nadb reverse --list:\n${adbTry(['reverse', '--list'], target).out.trim() || '(empty)'}`)
      console.error(`\noverlay state: ${JSON.stringify(state)}`)
      process.exitCode = 1
      return
    }

    const reportData = hit.report
    mkdirSync(outDir, { recursive: true })
    const reportPath = join(outDir, 'report.json')
    writeFileSync(reportPath, JSON.stringify(reportData, null, 2))
    const summary = formatSummary(lib, reportData)
    writeFileSync(join(outDir, 'summary.txt'), `${summary.join('\n')}\n`)
    console.log(`\nreport  (${hit.bytes}B via ${hit.channel}${hit.chunks === undefined ? '' : `, ${hit.chunks} chunk(s)`} after ${hit.waitedMs}ms) → ${reportPath}`)
    summary.forEach(line => console.log(`  ${line}`))
    const failed = reportData.scenarios.filter(item => item.status === 'failed')
    if (failed.length > 0) {
      console.log('\nfailed scenarios:')
      for (const item of failed) {
        const reason = lib.reason(item.reason ?? 'unknown')
        console.log(`  ${item.name}: ${item.reason} — ${reason.message}`)
        if (reason.hint !== '') console.log(`    hint: ${reason.hint}`)
      }
      process.exitCode = 1
    }
    if (reportData.aborted !== null) {
      console.log(`aborted: ${reportData.aborted.reason} — ${reportData.aborted.message ?? ''}`)
      process.exitCode = 1
    }
    if (options.shot === 'true') shot(target, 'report', outDir)
    if (options['keep-json'] !== 'false') writeFileSync(join(outDir, 'report.min.json'), JSON.stringify(reportData))
  } finally {
    if (reverse.ok) adbTry(['reverse', '--remove', `tcp:${port}`], target)
    await sink.close()
  }
}

async function runAll(target, options) {
  overlayOn(options)
  if (options.reload === 'true') {
    reload(target)
  } else {
    console.log('reload the mobile page now (`run.mjs reload`), then this waits for the report')
  }
  const config = effectiveConfig(options)
  const origin = await gatewayOrigin()
  const mixed = typeof origin === 'string' && origin.startsWith('https://')
    && /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/u.test(String(config.sinkUrl ?? ''))
  const chosen = mixed && (options.channel === undefined || options.channel === 'auto') ? 'screenshot' : (options.channel ?? 'auto')
  if (chosen === 'screenshot') {
    console.log('run: page is https and the sink is http loopback — a real-device WebView blocks it,')
    console.log('     so this run uses the screenshot channel (read the overlay panel in the PNG).')
  }
  await report(target, { ...options, channel: chosen, wait: options.wait ?? '25' })
  if (options.shutdown === 'true') overlayOff()
}

/**
 * Reload the mobile page. Default is a full app restart: a WebView has no
 * address bar, and on the Pad 9 Pro Max the pull-to-refresh swipe lands in the
 * composer and raises the soft keyboard instead of reloading (measured
 * 2026-11-02). `--gesture` keeps the swipe for devices where it works.
 */
function reload(target, options) {
  if (options?.gesture === 'true') {
    adb(['shell', 'input', 'swipe', '200', '240', '200', '760', '280'], { serial: target })
    console.log('pull-to-refresh gesture sent (may hit the composer; the default restart is safer)')
    return
  }
  adb(['shell', 'am', 'force-stop', APP_PACKAGE], { serial: target })
  const launched = adbTry(['shell', 'monkey', '-p', APP_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1'], target)
  console.log(launched.ok ? `restarted ${APP_PACKAGE} — the WebView reloads and re-runs the pilot` : `restart failed: ${launched.error}`)
}

async function channels(explicitSerial) {
  const found = deviceSerials()
  const target = explicitSerial ?? (found.length > 0 ? found[0] : null)
  const config = existsSync(DEFAULT_CONFIG) ? loadConfig(DEFAULT_CONFIG) : {}
  const origin = await gatewayOrigin()
  const sinkUrl = config.sinkUrl ?? null
  console.log(`device: ${target ?? 'none'}`)
  console.log(`gateway: ${origin ?? 'unknown'} · admin: ${ADMIN}`)
  describeChannels(origin, sinkUrl)
  if (target !== null) {
    const reverse = adbTry(['reverse', '--list'], target)
    console.log(`adb reverse: ${reverse.ok ? (reverse.out.trim() || '(none)') : `error: ${reverse.error}`}`)
    const dump = logcatDump(target, 3000)
    const dv = dump.ok ? dump.lines.length : 0
    console.log(`logcat: ${dump.ok ? `${dv} [dsh-verify] line(s) in the last 3000 log lines` : `unreadable: ${dump.error}`}`)
    console.log(`        ${dv === 0 ? '→ console forwarding does not work on this device (measured: Pad 9 Pro Max / Android 17 / WebView 150)' : '→ console forwarding may work; verify with report --channel logcat'}`)
  }
}

/**
 * A 1px, ~120ms swipe is delivered as a real touch gesture: the WebView raises
 * the IME. `input tap` (and `input motionevent DOWN/UP`) reaches focusin/focusout
 * but not the IME on Android 17 / WebView 150 — measured on the Pad 9 Pro Max.
 */
function tapAt(target, x, y, options) {
  const finger = options?.finger === true
  const duration = Number(options?.duration ?? 120)
  if (finger !== true) {
    adb(['shell', 'input', 'tap', String(x), String(y)], { serial: target })
    console.log(`tap ${x},${y} (plain input tap — may not raise the IME)`)
    return
  }
  adb(['shell', 'input', 'swipe', String(x), String(y), String(x), String(Number(y) + 1), String(duration)], { serial: target })
  console.log(`finger tap ${x},${y} (swipe ${x},${y}→${x},${Number(y) + 1} ${duration}ms — treated as a real finger)`)
}

function imeState(target) {
  const dump = adbTry(['shell', 'dumpsys', 'input_method'], target)
  if (dump.ok === false) return { shown: null, error: dump.error }
  const text = dump.out
  const shown = /mInputShown=(true|false)/u.exec(text)
  const viewShown = /mIsInputViewShown=(true|false)/u.exec(text)
  const method = /mCurMethodId=([^\s]+)/u.exec(text) ?? /mCurId=([^\s]+)/u.exec(text)
  return {
    shown: shown === null ? null : shown[1] === 'true',
    inputViewShown: viewShown === null ? null : viewShown[1] === 'true',
    method: method === null ? null : method[1],
  }
}

function doctor(explicitSerial) {
  const checks = []
  const state = overlayState()
  const deviceList = devices()
  const found = deviceSerials()
  const target = explicitSerial ?? (found.length > 0 ? found[0] : null)
  checks.push({ name: 'adb', ok: found.length > 0, detail: found.length > 0 ? found.join(',') : deviceList.split('\n').slice(0, 3).join(' | ') })
  checks.push({ name: 'dsh-home', ok: existsSync(join(DSH_HOME, 'mobile-access')), detail: join(DSH_HOME, 'mobile-access') })
  checks.push({ name: 'overlay', ok: state.installed, detail: `${state.mobileJs}; backup=${state.backup}` })
  const reverse = target === null ? '' : adbTry(['reverse', '--list'], target).out.trim()
  checks.push({ name: 'adb-reverse', ok: reverse.includes('tcp:'), detail: reverse === '' ? '(none)' : reverse.replace(/\n/gu, ' | ') })
  const logcat = target === null ? { ok: false, error: 'no device' } : adbTry(['logcat', '-d', '-t', '1'], target)
  checks.push({ name: 'logcat', ok: logcat.ok, detail: logcat.ok ? 'readable (channel logcat is usable)' : logcat.error })
  const config = existsSync(DEFAULT_CONFIG) ? loadConfig(DEFAULT_CONFIG) : null
  checks.push({
    name: 'config',
    ok: config !== null,
    detail: config === null ? `${DEFAULT_CONFIG} missing` : `${config.scenarios?.length ?? 0} scenarios, sink=${config.sinkUrl ?? 'off'}`,
  })
  const uiLab = resolve(ROOT, '..', 'dsh-ui-lab', 'node_modules', 'playwright')
  checks.push({ name: 'smoke-playwright', ok: existsSync(uiLab), detail: uiLab })
  for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(16)} ${check.detail}`)
  if (checks.some(check => check.ok === false)) process.exitCode = 1
}

function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'devices':
      console.log(devices())
      return
    case 'info':
      console.log(JSON.stringify(info(serial(options)), null, 2))
      return
    case 'scenarios': {
      const config = effectiveConfig(options)
      const normalized = lib.normalizeConfig(config)
      if (options.json === 'true') {
        console.log(JSON.stringify({ scenarios: normalized.scenarios, dropped: normalized.dropped, timeoutMs: normalized.timeoutMs, sinkUrl: normalized.sinkUrl }, null, 2))
      } else {
        console.log(`config: ${options.config ?? DEFAULT_CONFIG}`)
        console.log(`timeoutMs=${normalized.timeoutMs} pollIntervalMs=${normalized.pollIntervalMs} settlePolls=${normalized.settlePolls} sink=${normalized.sinkUrl ?? 'off'}`)
        for (const scenario of normalized.scenarios) {
          console.log(`  ${scenario.name.padEnd(18)} panel=${scenario.panel.padEnd(18)} labels=${scenario.labels.join(' | ')}${scenario.optional ? ' (optional)' : ''}`)
        }
        if (normalized.dropped.length > 0) console.log(`dropped: ${JSON.stringify(normalized.dropped)}`)
      }
      return
    }
    case 'overlay':
      if (positional[0] === 'on') overlayOn(options)
      else if (positional[0] === 'off') overlayOff()
      else if (positional[0] === 'status' || positional[0] === undefined) console.log(JSON.stringify(overlayState(), null, 2))
      else fail('overlay needs on|off|status')
      return
    case 'reload':
      reload(serial(options), options)
      return
    case 'report':
      report(serial(options), options).catch(error => fail(String(error && error.stack ? error.stack : error)))
      return
    case 'run':
      runAll(serial(options), options).catch(error => fail(String(error && error.stack ? error.stack : error)))
      return
    case 'channels':
      channels(options.serial).catch(error => fail(String(error && error.stack ? error.stack : error)))
      return
    case 'doctor':
      doctor(options.serial)
      return
    case 'shot':
      shot(serial(options), options.label, options.out === undefined ? undefined : resolve(options.out))
      return
    case 'tap': {
      const target = serial(options)
      if (options.x === undefined || options.y === undefined) fail('tap needs --x and --y')
      const finger = options.finger === 'true' || options.mode === 'finger'
      tapAt(target, options.x, options.y, { finger, duration: options.duration })
      return
    }
    case 'ime': {
      const target = serial(options)
      const action = positional[0] ?? 'status'
      if (action === 'status') {
        const state = imeState(target)
        console.log(JSON.stringify(state, null, 2))
        if (state.shown === false) process.exitCode = 1
        return
      }
      if (action === 'close') {
        adb(['shell', 'input', 'keyevent', '4'], { serial: target })
        console.log('back key sent (closes the IME when it is up)')
        return
      }
      if (action === 'open') {
        if (options.x === undefined || options.y === undefined) fail('ime open needs --x and --y')
        tapAt(target, options.x, options.y, { finger: options.finger !== 'false', duration: options.duration })
        return
      }
      fail('ime needs status|close|open --x --y')
      return
    }
    case 'swipe': {
      const target = serial(options)
      for (const key of ['x1', 'y1', 'x2', 'y2']) if (options[key] === undefined) fail(`swipe needs --${key}`)
      adb(['shell', 'input', 'swipe', String(options.x1), String(options.y1), String(options.x2), String(options.y2), String(options.duration ?? 300)], { serial: target })
      console.log('swipe sent')
      return
    }
    case 'rotate': {
      const target = serial(options)
      const value = positional[0] === '1' ? '1' : '0'
      adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'], { serial: target })
      adb(['shell', 'settings', 'put', 'system', 'user_rotation', value], { serial: target })
      console.log(`rotation ${value} (the overlay records the new viewport on resize; run "report" again to fetch it)`)
      return
    }
    case 'key': {
      const target = serial(options)
      const map = { home: '3', back: '4', enter: '66', power: '26' }
      const code = map[positional[0]]
      if (code === undefined) fail('key needs home|back|enter|power')
      adb(['shell', 'input', 'keyevent', code], { serial: target })
      console.log(`key ${positional[0]}`)
      return
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      fail(`unknown command: ${String(command)}`)
  }
}

main()
