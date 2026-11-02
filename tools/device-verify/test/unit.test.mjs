/**
 * Unit tests for the device-verify overlay library and driver helpers.
 *
 *   node --test tools/device-verify/test/
 *
 * No browser, no adb, no phone: overlay-lib.js is loaded exactly the way the
 * injected mobile.js loads it (a classic script attaching to globalThis), and
 * run-lib.mjs is imported as a normal ESM module.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeGateway, resolveGateway } from '../smoke.mjs'
import {
  buildInjection,
  createSinkServer,
  decodeLogcat,
  encodeLogcatLines,
  loadConfig,
  loadOverlayLib,
  mergeCli,
  parseArgs,
  reverseMappings,
  waitForReport,
} from '../run-lib.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_PATH = join(TOOL_DIR, 'overlay-lib.js')
const OVERLAY_PATH = join(TOOL_DIR, 'overlay.js')
const CONFIG_PATH = join(TOOL_DIR, 'scenarios.json')
const lib = loadOverlayLib(LIB_PATH)

function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async milliseconds => { time += milliseconds },
    advance: milliseconds => { time += milliseconds },
    time: () => time,
  }
}

test('default config is complete and clamped', () => {
  const config = lib.normalizeConfig(undefined)
  assert.equal(config.version, 2)
  assert.equal(config.autoStart, true)
  assert.equal(config.timeoutMs, 9000)
  assert.equal(config.pollIntervalMs, 120)
  assert.equal(config.settlePolls, 3)
  assert.equal(config.settleWindowMs, 900)
  assert.equal(config.closeTimeoutMs, 1200)
  assert.equal(config.allowHistoryBack, true)
  assert.equal(config.keyboardProbe, true)
  assert.equal(config.exportLogcat, true)
  assert.equal(config.hideDuringMeasure, true, 'our own copy area must not shadow real controls during hit tests')
  assert.equal(config.sinkUrl, null)
  assert.ok(config.scenarios.length >= 3)
  assert.deepEqual(config.scenarios.map(item => item.name), ['context-insights', 'todos', 'plugins', 'memory'])
  assert.equal(config.scenarios.at(-1).optional, true)
})

test('config values are clamped, not trusted', () => {
  const config = lib.normalizeConfig({
    timeoutMs: 1,
    pollIntervalMs: 100000,
    settlePolls: 0,
    titleMaxChars: 10,
    maxStates: 1,
    sinkUrl: '  ',
    scenarios: [],
  })
  assert.equal(config.timeoutMs, 500)
  assert.equal(config.pollIntervalMs, 2000)
  // settlePolls floor is 2: one sample is not "stable"
  assert.equal(config.settlePolls, 2)
  assert.equal(config.titleMaxChars, 500)
  assert.equal(config.closeTimeoutMs, 1200)
  assert.equal(config.maxStates, 2)
  assert.equal(config.sinkUrl, null)
  assert.equal(config.scenarios.length, 4, 'an empty list falls back to the defaults')
})

test('scenario normalization drops bad entries and keeps the first definition', () => {
  const { scenarios, dropped } = lib.normalizeScenarios([
    { name: 'a', labels: ['A'] },
    { name: 'a', labels: ['A2'] },
    { labels: ['no-name'] },
    { name: 'b', labels: [] },
    { name: 'c', labels: ['C', 'C', ''] },
    'nope',
  ])
  assert.deepEqual(scenarios.map(item => item.name), ['a', 'c'])
  assert.deepEqual(scenarios[1].labels, ['C'])
  assert.equal(scenarios[0].panel, 'a', 'panel falls back to the name')
  assert.equal(scenarios[0].optional, false)
  const reasons = dropped.map(item => item.reason)
  assert.ok(reasons.includes('duplicate-name:a'))
  assert.ok(reasons.includes('missing-name'))
  assert.ok(reasons.includes('no-labels:b'))
  assert.ok(reasons.includes('not-an-object'))
})

test('classifySizes uses the 44px floor with sub-pixel tolerance', () => {
  assert.deepEqual(lib.classifySizes([44, 44, 20]), { count: 3, min: 20, under44: 1, floor: 44 })
  assert.deepEqual(lib.classifySizes([43.5, 44]), { count: 2, min: 43.5, under44: 0, floor: 44 })
  assert.deepEqual(lib.classifySizes([43.4]), { count: 1, min: 43.4, under44: 1, floor: 44 })
  assert.deepEqual(lib.classifySizes([]), { count: 0, min: null, under44: 0, floor: 44 })
  assert.deepEqual(lib.classifySizes([0, -1, Number.NaN, 50]), { count: 1, min: 50, under44: 0, floor: 44 })
})

test('touchSignature is stable across hit-test results but sensitive to sizes', () => {
  const base = { count: 3, min: 44, under44: 0, sizes: [44, 48, 100], checked: 3, miss: 1 }
  assert.equal(lib.touchSignature(base), lib.touchSignature({ ...base, miss: 0, checked: 3 }))
  assert.notEqual(lib.touchSignature(base), lib.touchSignature({ ...base, sizes: [44, 48, 101] }))
  assert.equal(lib.touchSignature(null), 'none')
})

test('panelSignature also notices text-only changes', () => {
  const touch = { count: 13, min: 44, under44: 0, sizes: [44, 44, 48] }
  const skeleton = lib.panelSignature(touch, 12)
  const content = lib.panelSignature(touch, 420)
  assert.notEqual(skeleton, content, 'same control sizes but a different panel state')
  assert.equal(lib.panelSignature(touch, 20), lib.panelSignature(touch, 30), 'small text noise stays in one bucket')
  assert.equal(lib.panelSignature(touch, Number.NaN), lib.panelSignature(touch, 0))
})

test('keyboardOf detects a shrunken layout viewport', () => {
  const baseline = { inner: { height: 786 }, visual: { height: 786 } }
  const open = lib.keyboardOf(baseline, { inner: { height: 472 }, visual: { height: 472 } })
  assert.equal(open.open, true)
  assert.equal(open.innerDelta, -314)
  assert.equal(open.visualDelta, -314)

  const small = lib.keyboardOf(baseline, { inner: { height: 700 }, visual: { height: 700 } })
  assert.equal(small.open, true, 'an 86px shrink is past the default 80px threshold')
  assert.equal(small.innerDelta, -86)

  const tiny = lib.keyboardOf(baseline, { inner: { height: 760 }, visual: { height: 760 } })
  assert.equal(tiny.open, false, 'a 26px shrink is layout noise, not a keyboard')

  const strict = lib.keyboardOf(baseline, { inner: { height: 700 }, visual: { height: 700 } }, { threshold: 200 })
  assert.equal(strict.open, false, 'the threshold is configurable')

  const visualOnly = lib.keyboardOf(baseline, { inner: { height: 786 }, visual: { height: 472 } })
  assert.equal(visualOnly.open, true, 'iOS-style visual viewport shrink counts too')

  const unknown = lib.keyboardOf({}, {})
  assert.equal(unknown.open, false)
  assert.equal(unknown.innerDelta, null)
})

test('classifyViewportChange names the cause instead of guessing', () => {
  const portrait = { inner: { width: 909, height: 1314 }, visual: { width: 909, height: 1314 }, orientation: 'portrait' }
  const keyboard = { inner: { width: 909, height: 841 }, visual: { width: 909, height: 842 }, orientation: 'portrait' }
  const k = lib.classifyViewportChange(portrait, keyboard, { editableFocused: true })
  assert.equal(k.source, 'keyboard')
  assert.equal(k.keyboardLike, true)
  assert.equal(k.deltaInner, -473)
  assert.equal(k.deltaVisual, -472)

  // Rotation also shrinks the height (1314 -> 860) but must never count as a keyboard.
  const landscape = { inner: { width: 1363, height: 860 }, visual: { width: 1363, height: 860 }, orientation: 'landscape' }
  const r = lib.classifyViewportChange(portrait, landscape, { editableFocused: true })
  assert.equal(r.source, 'rotation')
  assert.equal(r.orientationChanged, true)
  assert.equal(r.keyboardLike, false)

  const zoomed = { ...portrait, visual: { width: 600, height: 900 } }
  assert.equal(lib.classifyViewportChange(portrait, zoomed, { scale: 1.5 }).source, 'zoom')

  const unfocused = lib.classifyViewportChange(portrait, keyboard, { editableFocused: false })
  assert.equal(unfocused.source, 'viewport-shrink')
  assert.equal(unfocused.shrank, true)

  assert.equal(lib.classifyViewportChange(keyboard, portrait, {}).source, 'viewport-grow')
  assert.equal(lib.classifyViewportChange(portrait, { ...portrait, inner: { width: 909, height: 1300 } }, {}).source, 'resize')
  assert.equal(lib.classifyViewportChange(null, portrait, {}).source, 'none')
})

test('keyboardReport reads the live viewport against the tallest baseline', () => {
  const baseline = { inner: { width: 909, height: 1314 }, visual: { width: 909, height: 1314 } }
  const open = lib.keyboardReport({
    current: { inner: { width: 909, height: 841 }, visual: { width: 909, height: 842 } },
    baseline,
    baselineOrientation: 'portrait',
    currentOrientation: 'portrait',
    editableFocused: true,
  })
  assert.equal(open.open, true)
  assert.equal(open.source, 'keyboard')
  assert.equal(open.innerDelta, -473)
  assert.equal(open.visualDelta, -472)
  assert.equal(open.editableFocused, true)
  assert.deepEqual(open.baseline, { inner: 1314, visual: 1314 })

  const closed = lib.keyboardReport({ current: baseline, baseline })
  assert.equal(closed.open, false)
  assert.equal(closed.innerDelta, 0)

  const rotated = lib.keyboardReport({
    current: { inner: { width: 1363, height: 860 }, visual: { width: 1363, height: 860 } },
    baseline,
    baselineOrientation: 'portrait',
    currentOrientation: 'landscape',
    editableFocused: true,
  })
  assert.equal(rotated.open, false, 'rotation must never be reported as a keyboard, even when the height drops')
  assert.equal(rotated.source, 'rotation')
  assert.equal(rotated.innerDelta, -454)

  const landscapeOpen = lib.keyboardReport({
    current: { inner: { width: 1363, height: 441 }, visual: { width: 1363, height: 441 } },
    baseline: { inner: { width: 1363, height: 860 }, visual: { width: 1363, height: 860 } },
    baselineOrientation: 'landscape',
    currentOrientation: 'landscape',
    editableFocused: true,
  })
  assert.equal(landscapeOpen.open, true)
  assert.equal(landscapeOpen.innerDelta, -419)

  const unknown = lib.keyboardReport({ current: {}, baseline: {} })
  assert.equal(unknown.open, false)
  assert.equal(unknown.innerDelta, null)
})

test('viewportEvents survive normalization and reach the report', () => {
  const report = lib.buildReport({
    started: true,
    viewportEvents: [
      { at: '2026-11-02T05:00:00Z', phase: 'done', trigger: 'visualViewport', source: 'keyboard', inner: { width: 909, height: 841 }, visual: { width: 909, height: 842 }, deltaInner: -473, orientation: 'portrait', editableFocused: true },
      null,
      'nope',
    ],
  })
  assert.ok(lib.REPORT_KEYS.includes('viewportEvents'))
  assert.equal(report.viewportEvents.length, 1)
  assert.equal(report.viewportEvents[0].source, 'keyboard')
  assert.equal(report.viewportEvents[0].deltaInner, -473)
  assert.equal(report.viewportEvents[0].editableFocused, true)
  assert.match(lib.summarize(report).join('\n'), /viewportEvents 1 \(last keyboard Δ-473\)/)
})

test('orientationOf reports landscape only when wider than tall', () => {
  assert.equal(lib.orientationOf({ innerWidth: 390, innerHeight: 844 }), 'portrait')
  assert.equal(lib.orientationOf({ innerWidth: 844, innerHeight: 390 }), 'landscape')
  assert.equal(lib.orientationOf({ innerWidth: 390, innerHeight: 390 }), 'portrait')
})

test('buildReport keeps a fixed key order and normalizes every scenario', () => {
  const report = lib.buildReport({
    started: true,
    env: { inner: { width: 390, height: 844 } },
    scenarios: [
      { name: 'todos', panel: 'todos', status: 'ok', ok: true, touch: { count: 3, min: 20, under44: 1 }, hit: { checked: 3, miss: 1 }, floaters: { attr: '1', raw: '1' }, detail: { clicked: 'label', label: '待办' } },
      { name: 'plugins' },
    ],
    states: [{ phase: 'boot', inner: { width: 390, height: 844 } }, null, 'nope'],
  })
  assert.equal(report.schema, 'dsh-device-verify/2')
  assert.deepEqual(Object.keys(report), lib.REPORT_KEYS)
  assert.equal(report.scenarios.length, 2)
  assert.equal(report.scenarios[0].touch.min, 20)
  assert.equal(report.scenarios[0].touch.under44, 1)
  assert.equal(report.scenarios[0].status, 'ok')
  assert.equal(report.scenarios[0].floaters.applied, true)
  assert.equal(report.scenarios[0].detail.clicked, 'label', 'detail survives normalization (it is the diagnosis)')
  assert.equal(report.scenarios[1].detail, null)
  assert.equal(report.scenarios[1].status, 'failed', 'a missing status is never reported as ok')
  assert.equal(report.scenarios[1].reason, null)
  assert.equal(report.states.length, 1)
  assert.equal(report.aborted, null)
  assert.equal(report.keyboard, null)
})

test('isReport rejects anything but our schema', () => {
  const report = lib.buildReport({ started: true })
  assert.equal(lib.isReport(report), true)
  assert.equal(lib.isReport({ ...report, schema: 'other' }), false)
  assert.equal(lib.isReport(null), false)
  assert.equal(lib.isReport({ schema: 'dsh-device-verify/2' }), false)
})

test('title encoding round-trips and marks truncation', () => {
  const report = lib.buildReport({ started: true, env: { inner: { width: 390, height: 844 } } })
  const encoded = lib.encodeTitle(report, 100000)
  assert.equal(encoded.truncated, false)
  assert.ok(encoded.title.startsWith(lib.TITLE_PREFIX))
  const decoded = lib.decodeTitle(encoded.title)
  assert.equal(decoded.report.started, true)
  assert.equal(decoded.report.env.inner.height, 844)

  const cut = lib.encodeTitle(report, 64)
  assert.equal(cut.truncated, true)
  assert.ok(cut.title.startsWith(lib.TITLE_TRUNCATED_PREFIX))
  assert.equal(lib.decodeTitle(cut.title).report, null)

  assert.equal(lib.decodeTitle('just a page title'), null)
  assert.equal(lib.decodeTitle(`${lib.TITLE_PREFIX}{bad json`).error, 'parse-error')
})

test('waitStable settles after settlePolls identical samples', async () => {
  const clock = fakeClock()
  let polls = 0
  const result = await lib.waitStable(() => { polls += 1; return 'same' }, {
    timeoutMs: 5000, intervalMs: 100, settlePolls: 3, now: clock.now, sleep: clock.sleep,
  })
  assert.equal(result.ok, true)
  assert.equal(result.polls, 3)
  assert.equal(result.waitedMs, 200)
})

test('waitStable keeps polling while the signature changes', async () => {
  const clock = fakeClock()
  const values = ['a', 'b', 'b', 'b']
  let index = 0
  const result = await lib.waitStable(() => values[Math.min(index++, values.length - 1)], {
    timeoutMs: 5000, intervalMs: 100, settlePolls: 3, now: clock.now, sleep: clock.sleep,
  })
  assert.equal(result.ok, true)
  assert.equal(result.value, 'b')
  assert.equal(result.polls, 4)
})

test('waitStable reports unstable on timeout', async () => {
  const clock = fakeClock()
  let value = 0
  const result = await lib.waitStable(() => `v${value++}`, {
    timeoutMs: 500, intervalMs: 100, settlePolls: 3, now: clock.now, sleep: clock.sleep,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unstable')
  assert.ok(result.waitedMs >= 500)
})

test('minWaitMs keeps a "settled" answer from being taken too early', async () => {
  const clock = fakeClock()
  const result = await lib.waitStable(() => 'same', {
    timeoutMs: 5000, intervalMs: 100, settlePolls: 2, minWaitMs: 900, now: clock.now, sleep: clock.sleep,
  })
  assert.equal(result.ok, true)
  assert.ok(result.waitedMs >= 900, `waited ${result.waitedMs}ms, expected >= 900ms`)
  assert.equal(result.value, 'same')
})

test('waitFor accepts on the predicate and reports its own reason', async () => {
  const clock = fakeClock()
  const ok = await lib.waitFor(() => 41, { accept: value => value > 40, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })
  assert.equal(ok.ok, true)

  const timeout = await lib.waitFor(() => false, { accept: value => value === true, timeoutMs: 300, intervalMs: 100, now: clock.now, sleep: clock.sleep, reason: 'panel-not-opened' })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.reason, 'panel-not-opened')
})

test('close strategies are ordered for the tablet case (no panelNav)', () => {
  // Tablet >=900px: the shell renders no .dshm-panelNav, so the native-back
  // event must come first after the (absent) back button.
  const tablet = lib.planClose({ hasPanelNav: false, hasSidebarEntry: true, historyLength: 1 })
  assert.deepEqual(tablet, ['native-back-event', 'sidebar-toggle', 'escape-key'])

  const phone = lib.planClose({ hasPanelNav: true, hasSidebarEntry: true, historyLength: 1 })
  assert.deepEqual(phone, ['panelNav-back', 'native-back-event', 'sidebar-toggle', 'escape-key'])

  const disabled = lib.planClose({ hasPanelNav: true, panelNavDisabled: true, historyLength: 1 })
  assert.deepEqual(disabled, ['native-back-event', 'escape-key'])

  const withHistory = lib.planClose({ hasPanelNav: false, allowHistoryBack: true, historyLength: 3 })
  assert.equal(withHistory.at(-1), 'history-back')
  const noHistory = lib.planClose({ hasPanelNav: false, historyLength: 1 })
  assert.equal(noHistory.includes('history-back'), false, 'a single-entry history must not be popped')
  const forbidden = lib.planClose({ hasPanelNav: false, allowHistoryBack: false, historyLength: 9 })
  assert.equal(forbidden.includes('history-back'), false, 'allowHistoryBack=false wins')

  assert.deepEqual(lib.planClose(undefined), ['native-back-event', 'escape-key'])
})

test('cleanup results are normalized, and the report carries them', () => {
  const report = lib.buildReport({
    started: true,
    cleanup: {
      ok: false,
      cause: 'end-of-run',
      panelOpen: true,
      drawerOpen: false,
      optOutRestored: true,
      attempted: [
        { step: 'close-panel', ok: false, strategy: null, attempts: [{ name: 'native-back-event', ok: false, waitedMs: 1200 }, { name: 'escape-key', ok: false }] },
        { step: 'close-drawer', ok: true },
      ],
    },
  })
  assert.ok(lib.REPORT_KEYS.includes('cleanup'))
  assert.equal(report.cleanup.ok, false)
  assert.equal(report.cleanup.panelOpen, true)
  assert.equal(report.cleanup.attempted[0].attempts.length, 2)
  assert.equal(report.cleanup.attempted[0].attempts[0].name, 'native-back-event')
  assert.equal(report.cleanup.attempted[1].strategy, null)
  assert.equal(lib.buildReport({ started: true }).cleanup, null)
  assert.equal(lib.normalizeCleanup(undefined), null)
  assert.match(lib.summarize(report).join('\n'), /cleanup ok=false panelOpen=true close-panel=fail close-drawer=ok/)
})

test('every reason code has a message and a hint', () => {
  for (const code of Object.keys(lib.REASONS)) {
    const reason = lib.reason(code)
    assert.equal(typeof reason.message, 'string')
    assert.ok(reason.message.length > 0, code)
    assert.ok(reason.hint.length > 0, code)
    assert.ok(lib.describeReason(code).startsWith(`${code}: `))
  }
  assert.equal(lib.reason('nope').message, 'nope')
})

test('summarize prints one line per scenario plus keyboard', () => {
  const report = lib.buildReport({
    started: true,
    env: { inner: { width: 390, height: 844 }, dpr: 3, visual: { width: 390, height: 844 } },
    scenarios: [
      { name: 'a', status: 'ok', touch: { count: 10, min: 44, under44: 0, checked: 10, miss: 0 }, optOut: { changed: true, touch: { under44: 7 } } },
      { name: 'b', status: 'failed', reason: 'panel-not-opened', touch: { count: 0, min: null, under44: null } },
      { name: 'c', status: 'skipped', reason: 'skipped', touch: {} },
    ],
    keyboard: { open: true, baseline: { inner: 786 }, current: { inner: 472 } },
  })
  const lines = lib.summarize(report)
  assert.equal(lines.length, 5)
  assert.match(lines[1], /^ok {1,3}a /)
  assert.match(lines[2], /^FAIL b .*panel-not-opened/)
  assert.match(lines[3], /^skip c /)
  assert.match(lines[4], /keyboard open=true inner 786->472/)
})

test('overlay.js and overlay-lib.js are classic scripts with no module syntax', () => {
  for (const path of [LIB_PATH, OVERLAY_PATH]) {
    const source = readFileSync(path, 'utf8')
    assert.equal(/^\s*(import|export)\s/m.test(source), false, `${path} must stay a classic script`)
    // new Function compiles a classic script body: top-level await would throw here.
    assert.doesNotThrow(() => new Function(source), `${path} must parse`)
  }
  const overlay = readFileSync(OVERLAY_PATH, 'utf8')
  assert.ok(overlay.includes('window.DshVerifyLib'), 'overlay reads the shared library')
  assert.ok(overlay.includes('window.__dvConfig'), 'overlay reads the generated config')
  assert.ok(overlay.includes('window.__dvReport'), 'overlay publishes the report object')
  assert.ok(overlay.includes('document.title'), 'overlay publishes the report in the title')
})

test('the shipped scenarios.json matches the default scenario contract', () => {
  const config = lib.normalizeConfig(loadConfig(CONFIG_PATH))
  assert.ok(config.scenarios.length >= 3)
  for (const scenario of config.scenarios) {
    assert.equal(typeof scenario.name, 'string')
    assert.ok(scenario.labels.length > 0)
  }
  assert.equal(config.dropped.length, 0)
  assert.equal(config.sinkUrl, 'http://127.0.0.1:8799/report')
})

test('injection puts config first, then the library, then the overlay', () => {
  const config = { scenarios: [{ name: 'a', labels: ['A'] }], sinkUrl: null }
  const injection = buildInjection({
    config,
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
  assert.ok(injection.includes('dsh-verify-overlay'), 'the marker must survive so overlay off can find its own file')
  const configAt = injection.indexOf('window.__dvConfig')
  const libAt = injection.indexOf('global.DshVerifyLib = {')
  const overlayAt = injection.indexOf('dsh-device-verify · in-page overlay')
  assert.ok(configAt > 0 && libAt > configAt && overlayAt > libAt)
  assert.doesNotThrow(() => new Function(injection), 'the injected file must parse as one classic script')
  assert.ok(JSON.parse(JSON.stringify(config)).scenarios.length === 1)
})

function browserStub(overrides) {
  const attributes = new Map()
  const calls = { clicks: 0, dispatched: [] }
  const scope = overrides?.sidebarScope ?? null
  const main = {
    getAttribute: name => (name === 'data-dsh-panel' ? '1' : null),
    querySelector: () => null,
  }
  const drawer = {
    getAttribute: () => 'false',
    hasAttribute: () => false,
    querySelectorAll: () => [],
  }
  const context = {
    console: { info: () => {}, error: () => {}, log: () => {}, warn: () => {} },
    // Polling uses Date.now for its deadline; advance it per read so timeouts
    // fire immediately instead of waiting in real time.
    Date: class FakeDate extends Date {
      static now() { context.__clock = (context.__clock ?? 0) + 250; return context.__clock }
    },
    // Run the callback immediately: polling awaits this, and the fake clock
    // advances per Date.now() read, so deadlines still fire.
    setTimeout: fn => { fn(); return 0 },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    Event: class Event { constructor(type, init) { this.type = type; this.cancelable = init?.cancelable === true; this.defaultPrevented = false } preventDefault() { this.defaultPrevented = true } },
    KeyboardEvent: class KeyboardEvent extends Event { constructor(type, init) { super(type, init); this.key = init?.key } },
    navigator: { userAgent: 'test', clipboard: undefined },
    location: { origin: 'https://example.test', pathname: '/', href: 'https://example.test/' },
    fetch: async () => ({ ok: true, status: 204 }),
    localStorage: { setItem: () => {}, getItem: () => null },
    AbortController,
    screen: { width: 390, height: 844 },
    devicePixelRatio: 3,
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: null,
    history: { length: 1, back: () => {} },
    dispatchEvent: event => { calls.dispatched.push(event.type); return true },
    addEventListener: () => {},
    removeEventListener: () => {},
    document: {
      getElementById: id => (id === 'dsh-verify-overlay' ? null : { id }),
      querySelector: selector => {
        if (selector === '.dshm-main') return main
        if (selector === '.dshm-panelNav') return null
        if (selector === '.dshm-drawer') return drawer
        if (selector === '.dshm-scrim[data-open="true"]') return null
        if (selector === '[data-slot="sidebar"]') return scope
        return null
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, append: () => {}, remove: () => {}, addEventListener: () => {}, getBoundingClientRect: () => ({ width: 0, height: 0 }), classList: [] }),
      documentElement: {
        getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: name => attributes.delete(name),
        scrollWidth: 390,
        clientWidth: 390,
      },
      body: null,
      addEventListener: () => {},
      dispatchEvent: event => { calls.dispatched.push(event.type); return true },
      title: '',
    },
    calls,
  }
  context.window = context
  context.globalThis = context
  return context
}

test('cleanup survives currentScenario = null while a panel is still open (F1)', async () => {
  const injection = buildInjection({
    config: loadConfig(CONFIG_PATH),
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
  const context = browserStub()
  vm.createContext(context)
  vm.runInContext(injection, context)
  const session = context.__dshVerify
  assert.equal(typeof session.cleanup, 'function', 'cleanup must be reachable for diagnostics/tests')

  // The exact F1 shape: pilot finished, currentScenario reset to null, panel open.
  session.state.currentScenario = null
  let result
  await assert.doesNotReject(async () => { result = await session.cleanup('test-null-scenario') })
  assert.equal(result.cause, 'test-null-scenario')
  assert.equal(result.panelOpen, true, 'the stub never closes the panel')
  assert.equal(result.optOutRestored, true)
  const closeStep = result.attempted.find(step => step.step === 'close-panel')
  assert.ok(closeStep !== undefined, 'cleanup still attempts to close the panel')
  // Values created inside the vm have the vm realm's prototypes, so copy them
  // into host arrays before a strict deepEqual.
  const names = Array.from(closeStep.attempts, item => item.name)
  assert.deepEqual(names, ['native-back-event', 'escape-key'], 'no scenario ⇒ native-back first, no sidebar toggle without an entry')
  assert.ok(context.calls.dispatched.includes('dsh-mobile:native-back'))

  // With a scenario whose entry exists, the toggle strategy is offered too.
  const scoped = browserStub({
    sidebarScope: {
      querySelectorAll: () => [],
      getAttribute: () => null,
      children: [],
    },
  })
  scoped.document.querySelector = selector => {
    if (selector === '.dshm-main') return { getAttribute: name => (name === 'data-dsh-panel' ? '1' : null), querySelector: () => null }
    if (selector === '.dshm-panelNav') return null
    if (selector === '.dshm-drawer') return { getAttribute: () => 'false', hasAttribute: () => false, querySelectorAll: () => [] }
    if (selector === '.dshm-scrim[data-open="true"]') return null
    if (selector === '[data-slot="sidebar"]') return { querySelectorAll: () => [], children: [] }
    return null
  }
  vm.createContext(scoped)
  vm.runInContext(injection, scoped)
  scoped.__dshVerify.state.currentScenario = { labels: ['Todos'] }
  const withScenario = await scoped.__dshVerify.cleanup('test-with-scenario')
  const withStep = withScenario.attempted.find(step => step.step === 'close-panel')
  assert.deepEqual(Array.from(withStep.attempts, item => item.name), ['native-back-event', 'escape-key'], 'no matching entry ⇒ same plan, still no crash')
})

test('the injected file actually runs: config, library and overlay all load', () => {
  // `new Function` only proves the file parses. This executes it in a vm with a
  // minimal DOM stub, which is what catches two IIFEs glued together by accident
  // (`})(…)(function(){…})()` compiles fine and throws at load).
  const config = loadConfig(CONFIG_PATH)
  const injection = buildInjection({
    config,
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
  const noop = () => {}
  const waiters = new Map()
  const context = {
    console: { info: noop, error: noop, log: noop, warn: noop },
    setTimeout: (fn, ms) => { const id = Symbol('t'); waiters.set(id, fn); void ms; return id },
    clearTimeout: id => waiters.delete(id),
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: fn => { void fn; return 0 },
    navigator: { userAgent: 'test', clipboard: undefined },
    location: { origin: 'https://example.test', pathname: '/', href: 'https://example.test/' },
    fetch: async () => ({ ok: true, status: 204 }),
    localStorage: { setItem: noop, getItem: () => null },
    AbortController,
    screen: { width: 390, height: 844 },
    devicePixelRatio: 3,
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: null,
    // The overlay must not think its own panel is already mounted.
    document: {
      getElementById: id => (id === 'dsh-verify-overlay' ? null : { id }),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, append: noop, remove: noop, addEventListener: noop }),
      documentElement: { getAttribute: () => null, setAttribute: noop, removeAttribute: noop, scrollWidth: 390, clientWidth: 390 },
      body: null,
      addEventListener: noop,
      title: '',
    },
  }
  context.window = context
  context.globalThis = context
  vm.createContext(context)
  assert.doesNotThrow(() => vm.runInContext(injection, context), 'the injected file must load without a runtime error')
  assert.equal(context.__dvConfig.scenarios.length, 4, 'the generated config is visible to the overlay')
  assert.equal(typeof context.DshVerifyLib.buildReport, 'function', 'the library is loaded')
  assert.equal(context.DshVerifyLib.VERSION, 2)
  // If the two IIFEs had been glued together, __dvConfig would still be set but
  // the overlay would never reach its own boot(): the panel check below is the
  // smoke signal that the overlay body ran at all.
  assert.equal(typeof context.__dshVerify, 'object', 'the overlay booted (window.__dshVerify exists)')
})

test('buildInjection is deterministic', () => {
  const inputs = () => ({
    config: loadConfig(CONFIG_PATH),
    libSource: readFileSync(LIB_PATH, 'utf8'),
    overlaySource: readFileSync(OVERLAY_PATH, 'utf8'),
  })
  assert.equal(buildInjection(inputs()), buildInjection(inputs()))
})

test('a leading option is not a command (F2)', async () => {
  // smoke.mjs --gateway URL used to swallow the URL as the command name, so the
  // run silently fell back to the admin status gateway.
  const parsed = parseArgs(['--gateway', 'https://127.0.0.1:3999', '--offline'])
  assert.equal(parsed.command, undefined)
  assert.equal(parsed.options.gateway, 'https://127.0.0.1:3999')
  assert.equal(parsed.options.offline, 'true')
  // A real subcommand still works.
  assert.equal(parseArgs(['live', '--gateway', 'https://x']).command, 'live')

  // resolveGateway must use the explicit URL verbatim, never the admin status.
  assert.equal(await resolveGateway({ gateway: 'https://127.0.0.1:3999/' }), 'https://127.0.0.1:3999')

  // And an unreachable gateway must be reported as unreachable (no silent fallback).
  const probe = await probeGateway('https://127.0.0.1:3999', 1500)
  assert.equal(probe.ok, false, 'port 3999 has nothing listening on the test box')
  assert.equal(typeof probe.error, 'string')
  assert.ok(probe.error.length > 0)
})

test('reason codes match what the code can actually emit (F3)', () => {
  // overlay-missing had no emit point anywhere; it must not linger in the table.
  assert.equal('overlay-missing' in lib.REASONS, false)
  // panel-not-closed is kept for reading old reports only.
  assert.equal(lib.REASONS['panel-not-closed'].legacy, true)
  assert.equal(lib.REASONS['panel-not-closeable'].legacy, undefined)
  const overlaySource = readFileSync(OVERLAY_PATH, 'utf8')
  assert.equal(/reason:\s*'panel-not-closed'/.test(overlaySource), false, 'the overlay must emit panel-not-closeable, not the legacy code')
  assert.equal(/reason:\s*'overlay-missing'/.test(overlaySource), false)
  const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8')
  assert.match(readme, /`aborted` 只在.*page-not-loaded.*overlay-error/s, 'README must describe the two real abort causes only')
})

test('drawer rows join the settle signature (F4)', () => {
  const touch = { count: 446, min: 44, under44: 0, sizes: [44, 44] }
  assert.notEqual(lib.panelSignature(touch, 420, 'd:67'), lib.panelSignature(touch, 420, 'd:60'))
  assert.equal(lib.panelSignature(touch, 420, ''), lib.panelSignature(touch, 420))
  assert.equal(lib.panelSignature(touch, 420, undefined), lib.panelSignature(touch, 420, ''))
})

test('hit samples name the missed point and what covered it (F7)', () => {
  const full = lib.hitSample({
    tag: 'button', width: 44, height: 44, hit: 4, probed: 5,
    misses: [{ point: 'left', x: 20, y: 30, by: 'div.dshm-drawer[data-slot=sidebar]' }],
  })
  assert.match(full, /^button 44x44 4\/5 miss=left\(20,30\)→div\.dshm-drawer\[data-slot=sidebar\]$/)
  const all = lib.hitSample({ tag: 'button', width: 136, height: 44, hit: 0, probed: 5, misses: [{ point: 'center', x: 1, y: 2, by: null }] })
  assert.match(all, /0\/5 miss=center\(1,2\)→none/)
  const none = lib.hitSample({ tag: 'input', width: 20, height: 20, hit: 3, probed: 3 })
  assert.equal(none, 'input 20x20 3/3')
  assert.equal(lib.hitSample(undefined), 'node 0x0 0/0')
})

test('--no-pilot injects without driving the page', () => {
  const config = lib.normalizeConfig({ noPilot: true })
  assert.equal(config.noPilot, true)
  const merged = mergeCli(loadConfig(CONFIG_PATH), { 'no-pilot': 'true' })
  assert.equal(merged.noPilot, true)
  assert.equal(merged.autoStart, false, 'no pilot implies no autostart')
  assert.equal(lib.normalizeConfig({}).noPilot, false)
})

test('parseArgs handles values, =form, bare flags and positionals', () => {
  const parsed = parseArgs(['report', '--port', '8799', '--shot', '--timeout=30', 'extra'])
  assert.equal(parsed.command, 'report')
  assert.equal(parsed.options.port, '8799')
  assert.equal(parsed.options.shot, 'true')
  assert.equal(parsed.options.timeout, '30')
  assert.deepEqual(parsed.positional, ['extra'])
  assert.deepEqual(parseArgs([]), { command: undefined, options: {}, positional: [] })
})

test('mergeCli applies overrides without mutating the input config', () => {
  const base = loadConfig(CONFIG_PATH)
  const snapshot = JSON.stringify(base)
  const merged = mergeCli(base, { scenarios: 'todos', port: '9123', timeoutMs: '4000', 'no-keyboard': 'true' })
  assert.equal(JSON.stringify(base), snapshot, 'the file config must stay untouched')
  assert.deepEqual(merged.scenarios.map(item => item.name), ['todos'])
  assert.equal(merged.sinkUrl, 'http://127.0.0.1:9123/report')
  assert.equal(merged.timeoutMs, 4000)
  assert.equal(merged.keyboardProbe, false)

  const off = mergeCli(base, { sink: 'off' })
  assert.equal(off.sinkUrl, null)

  const unknown = mergeCli(base, { scenarios: 'brand-new' })
  assert.deepEqual(unknown.scenarios[0], { name: 'brand-new', panel: 'brand-new', labels: ['brand-new'] })
})

test('loadConfig drops documentation keys only', () => {
  const config = loadConfig(CONFIG_PATH)
  assert.equal('$comment' in config, false)
  assert.equal('scenarios' in config, true)
})

test('the logcat channel round-trips a report through log prefixes', () => {
  const report = lib.buildReport({
    started: true,
    env: { inner: { width: 390, height: 844 }, ua: '中文 UA ✓' },
    scenarios: [{ name: 'plugins', status: 'ok', touch: { count: 94, min: 20, under44: 41 } }],
    states: [{ phase: 'boot', inner: { width: 390, height: 844 } }],
  })
  const lines = encodeLogcatLines(report).map((line, index) => `11-02 13:0${index % 10}:00.123  1234  1234 I chromium: ${line}`)
  const decoded = decodeLogcat(lines)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.report.env.ua, '中文 UA ✓', 'base64 keeps non-ASCII intact')
  assert.equal(decoded.report.scenarios[0].touch.under44, 41)
  assert.equal(decoded.complete, true)
  assert.ok(decoded.chunks > 1, 'a real report needs more than one chunk')
})

test('the logcat decoder refuses an incomplete or foreign dump', () => {
  assert.equal(decodeLogcat([]).reason, 'no-report-marker')
  const report = lib.buildReport({ started: true, env: { ua: 'x'.repeat(3000) } })
  const lines = encodeLogcatLines(report)
  const missing = lines.filter(line => line.includes('REPORT 1 ') === false)
  assert.match(decodeLogcat(missing).reason, /chunks-missing/)
  assert.equal(decodeLogcat(['[dsh-verify] REPORT-BEGIN 1 10', '[dsh-verify] REPORT 0 bm90LWpzb24=', '[dsh-verify] REPORT-END']).reason, 'json-invalid')
  const wrong = encodeLogcatLines({ schema: 'nope' })
  assert.equal(decodeLogcat(wrong).reason, 'wrong-schema')
})

test('reverseMappings finds the rows for one tcp port', () => {
  const text = 'htcabc tcp:8799 tcp:8799\nxyz tcp:3443 tcp:3443'
  assert.equal(reverseMappings(text, 8799).length, 1)
  assert.equal(reverseMappings('', 8799).length, 0)
})

test('the sink server accepts a report and rejects other paths', async () => {
  const received = []
  const sink = createSinkServer({ port: 0, onReport: entry => received.push(entry) })
  const address = await sink.listen()
  try {
    const report = lib.buildReport({ started: true, scenarios: [{ name: 'a', status: 'ok', touch: { count: 1, min: 44, under44: 0 } }] })
    const optionsResponse = await fetch(sink.url, { method: 'OPTIONS' })
    assert.equal(optionsResponse.status, 204)
    assert.equal(optionsResponse.headers.get('access-control-allow-origin'), '*')

    const response = await fetch(sink.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(report),
    })
    assert.equal(response.status, 204)
    assert.equal(received.length, 1)
    assert.equal(received[0].report.scenarios[0].name, 'a')
    assert.equal(received[0].kind, 'report')

    const notFound = await fetch(`http://127.0.0.1:${address.port}/nope`, { method: 'POST', body: '{}' })
    assert.equal(notFound.status, 404)

    const bad = await fetch(sink.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' })
    assert.equal(bad.status, 400)

    const waited = await waitForReport(sink, { timeoutMs: 500, accept: entry => lib.isReport(entry.report) })
    assert.equal(waited.ok, true)
    assert.equal(waited.entry.report.schema, 'dsh-device-verify/2')
  } finally {
    await sink.close()
  }
  assert.equal(sink.requests.length, 1, 'a bad payload is not recorded as a report')
})

test('waitForReport times out with a reason instead of hanging', async () => {
  const sink = createSinkServer({ port: 0 })
  await sink.listen()
  try {
    const result = await waitForReport(sink, { timeoutMs: 300, intervalMs: 50, accept: entry => lib.isReport(entry.report) })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'sink-timeout')
  } finally {
    await sink.close()
  }
})

test('the CLI parses and its help text names every command', () => {
  const output = execFileSync(process.execPath, [join(TOOL_DIR, 'run.mjs'), 'scenarios'], { encoding: 'utf8' })
  assert.match(output, /context-insights/)
  assert.match(output, /sink=http:\/\/127\.0\.0\.1:8799\/report/)
  const help = readFileSync(join(TOOL_DIR, 'run.mjs'), 'utf8').split('*/')[0]
  for (const command of ['doctor', 'overlay', 'report', 'run', 'scenarios', 'reload', 'shot', 'tap', 'swipe', 'rotate', 'key', 'info', 'devices']) {
    assert.match(help, new RegExp(`run\\.mjs\\s+${command}`), `help must document ${command}`)
  }
})
