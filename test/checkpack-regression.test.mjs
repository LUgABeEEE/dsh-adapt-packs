/**
 * Regression tests for the two directed-fixture assertions added in PR #9.
 *
 * Each case copies docs/examples/fixture-pack into a temp directory, injects one
 * deliberate defect into its fixture.html, and runs `tools/check-pack.mjs <tmp>
 * --json`. The target assertion must be reported as failed and check-pack must
 * exit 1 — this is the "deliberately turns red" coverage the reviewer asked for.
 *
 * The checker needs Playwright + Chromium. Unit-test job environments install
 * neither, so the whole file skips when the checker reports a missing-browser
 * startup error. The dedicated CI step after "Install Playwright and Chromium"
 * sets CHECKPACK_REGRESSION_REQUIRE_BROWSER=1, which turns that skip into a hard
 * failure so the browser job can never go green by skipping these regressions.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const EXAMPLE = join(REPO, 'docs', 'examples', 'fixture-pack')
const CHECKER = join(REPO, 'tools', 'check-pack.mjs')
const CONTEXT_PACK = join(REPO, 'packs', 'dsh-context-mobile')
const SHELL_PACK = join(REPO, 'packs', 'shell-chrome')
const REQUIRE_BROWSER = process.env.CHECKPACK_REGRESSION_REQUIRE_BROWSER === '1'
const RUN_TIMEOUT_MS = 180_000

// Strings check-pack puts in its startup error when Playwright or its Chromium
// build is missing (see loadPlaywright / describeChromiumLaunchFailure).
const BROWSER_MISSING_PATTERNS = [
  /Playwright 未找到/,
  /playwright not found/i,
  /Chromium 无法启动/,
  /Executable doesn't exist/i,
  /browserType\.launch/i,
]

function runChecker(packPath) {
  const result = spawnSync(process.execPath, [CHECKER, packPath, '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  })
  let payload = null
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    // Not JSON: leave payload null and surface stdout/stderr in the assertion.
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, payload }
}

function missingBrowserReason() {
  const probe = runChecker(EXAMPLE)
  if (probe.status === 0) return null
  const detail = [probe.payload?.error, probe.stderr, probe.stdout].map(value => (typeof value === 'string' ? value : '')).join('\n')
  if (BROWSER_MISSING_PATTERNS.some(pattern => pattern.test(detail)) === false) return null
  const firstLine = detail.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'unknown browser error'
  return `Playwright/Chromium 不可用，跳过 check-pack 定向 fixture 回归：${firstLine.slice(0, 160)}`
}

const skipReason = missingBrowserReason()
if (skipReason !== null && REQUIRE_BROWSER === true) {
  throw new Error(`CHECKPACK_REGRESSION_REQUIRE_BROWSER=1，但浏览器不可用：${skipReason}`)
}
const skip = skipReason ?? false

/** Copy the example pack, apply one fixture mutation, run fn(packDir), clean up. */
function withMutatedFixture(mutate, fn) {
  const root = mkdtempSync(join(tmpdir(), 'checkpack-regression-'))
  const packDir = join(root, 'fixture-pack')
  try {
    cpSync(EXAMPLE, packDir, { recursive: true })
    const fixturePath = join(packDir, 'fixture.html')
    const source = readFileSync(fixturePath, 'utf8')
    const mutated = mutate(source)
    assert.notEqual(mutated, source, 'fixture mutation did not change fixture.html')
    writeFileSync(fixturePath, mutated)
    return fn(packDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function failedAssertion(payload, assertionId) {
  assert.notEqual(payload, null, 'check-pack --json output was not JSON (is Playwright/Chromium available?)')
  assert.equal(payload.ok, false, 'check-pack --json should report ok=false')
  const pack = payload.packs.find(item => item.id === 'fixture-pack')
  assert.ok(pack, 'fixture-pack missing from the --json report')
  const assertion = pack.assertions.find(item => item.id === assertionId)
  assert.ok(assertion, `assertion ${assertionId} missing from the report`)
  assert.equal(assertion.status, 'failed', `expected ${assertionId} to be failed, got ${assertion.status}: ${assertion.message}`)
  return assertion
}

test('directed fixture: an overflowing panel fails runtime.mobile.panel.right', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withMutatedFixture(source => {
    assert.match(source, /<div class="demo-panel">/)
    return source.replace('<div class="demo-panel">', '<div class="demo-panel" style="min-width:600px">')
  }, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 for a failing directed fixture\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    const assertion = failedAssertion(result.payload, 'runtime.mobile.panel.right')
    assert.match(assertion.message, /600px/)
  })
})

test('directed fixture: a 12px text field fails runtime.mobile.inputFontSize', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withMutatedFixture(source => {
    assert.match(source, /font-size: 16px; line-height: 1\.25;/)
    return source.replace('font-size: 16px; line-height: 1.25;', 'font-size: 12px; line-height: 1.25;')
  }, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 for a failing directed fixture\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    const assertion = failedAssertion(result.payload, 'runtime.mobile.inputFontSize')
    assert.match(assertion.message, /12px/)
  })
})

test('directed fixture: a widened document fails runtime.mobile.overflow', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withMutatedFixture(source => {
    assert.match(source, /<body>/)
    return source.replace('<body>', '<body style="width:500px">')
  }, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 for a failing directed fixture\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    const assertion = failedAssertion(result.payload, 'runtime.mobile.overflow')
    assert.match(assertion.message, /scrollWidth/)
  })
})

/**
 * Copy a real pack under its own basename (so its catalog entry still applies) and
 * append CSS to mobile.css. Used for "the gate must actually be proven" regressions.
 */
function withMutatedPack(sourceDir, cssAppend, fn) {
  const root = mkdtempSync(join(tmpdir(), 'checkpack-hostgate-'))
  const packDir = join(root, basename(sourceDir))
  try {
    cpSync(sourceDir, packDir, { recursive: true })
    const cssPath = join(packDir, 'mobile.css')
    assert.ok(readFileSync(cssPath, 'utf8').includes(':not([data-dsh-panel])'), 'the source pack must use the host gate')
    writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n${cssAppend}`)
    return fn(packDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Reviewer B1: a `<44px` retreat check would pass an ungated 40px floor that shrinks
// the host's own 44px floor on dsh-mobile >=0.8.1. The probe must read the computed
// min-height (back to the no-pack value), so this deliberately broken pack has to
// turn red — no device needed, but the browser job runs it with
// CHECKPACK_REGRESSION_REQUIRE_BROWSER=1.
test('host gate: an ungated 40px floor fails runtime.hostGate.floor-retreated', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withMutatedPack(CONTEXT_PACK, `
@media (pointer: coarse) {
  :root:not([data-dsh-adapt="off"]) [data-slot="main"] [data-dshm-context-panel="1"]
    :where(button, [role="button"]) { min-height: 40px !important; }
}
`, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 for a residual 40px floor\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    assert.notEqual(result.payload, null, 'check-pack --json output was not JSON (is Playwright/Chromium available?)')
    assert.equal(result.payload.ok, false, 'check-pack --json should report ok=false')
    const pack = result.payload.packs.find(item => item.id === 'dsh-context-mobile')
    assert.ok(pack, 'dsh-context-mobile missing from the --json report')
    const assertion = pack.assertions.find(item => item.id === 'runtime.hostGate.floor-retreated')
    assert.ok(assertion, 'runtime.hostGate.floor-retreated missing from the report')
    assert.equal(assertion.status, 'failed', `expected the residual 40px floor to fail the gate check, got ${assertion.status}: ${assertion.message}`)
    assert.match(assertion.message, /40px/, `the failure should name the residual min-height: ${assertion.message}`)
  })
})

// Reviewer F1 (t9): the host-probe used to sample only the first button/input, so a
// pack could crush a non-sampled control (here: every `[role="group"] button`) while
// the sampled settings button still measured 44px. The probe now walks every control,
// so this deliberately narrowed floor has to turn red.
test('host gate: crushing only [role=group] buttons still fails host-floor-kept', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withMutatedPack(CONTEXT_PACK, `
@media (pointer: coarse) {
  :root:not([data-dsh-adapt="off"]):not(.dshm-bp1):not(.dshm-bp2):not(.dshm-bp3):not(.dshm-bp4):not(.dshm-bp5):not(.dshm-bp6)
    .dshm-main[data-dsh-panel="1"] [data-slot="main"] [data-dshm-context-panel="1"] [role="group"] button {
    min-height: 20px !important;
  }
}
`, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 when a non-sampled control is crushed\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    assert.notEqual(result.payload, null, 'check-pack --json output was not JSON (is Playwright/Chromium available?)')
    assert.equal(result.payload.ok, false, 'check-pack --json should report ok=false')
    const pack = result.payload.packs.find(item => item.id === 'dsh-context-mobile')
    assert.ok(pack, 'dsh-context-mobile missing from the --json report')
    const assertion = pack.assertions.find(item => item.id === 'runtime.hostGate.host-floor-kept')
    assert.ok(assertion, 'runtime.hostGate.host-floor-kept missing from the report')
    assert.equal(assertion.status, 'failed', `expected the crushed group buttons to fail host-floor-kept, got ${assertion.status}: ${assertion.message}`)
    assert.match(assertion.message, /20px/, `the failure should name the crushed height: ${assertion.message}`)
    assert.match(assertion.message, /4 个不达标/, `the failure should count every crushed control: ${assertion.message}`)
  })
})

/**
 * Copy a real pack under its basename, let `patch` rewrite mobile.css, run the checker.
 * Used by the shell-chrome regressions (the docked-row rule must not depend on
 * `data-open`, so re-scoping it to a state that never happens has to fail the probe).
 */
function withPatchedPack(sourceDir, patch, fn) {
  const root = mkdtempSync(join(tmpdir(), 'checkpack-shell-'))
  const packDir = join(root, basename(sourceDir))
  try {
    cpSync(sourceDir, packDir, { recursive: true })
    const cssPath = join(packDir, 'mobile.css')
    const source = readFileSync(cssPath, 'utf8')
    const patched = patch(source)
    assert.notEqual(patched, source, 'pack mutation did not change mobile.css')
    writeFileSync(cssPath, patched)
    return fn(packDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Reviewer BUG-03 (t12): the docked sidebar rows (`role="treeitem"`, 32/34px) were only
// reached when `[data-open="true"]`. A rule that keeps that filter must fail, otherwise
// the tablet docked layout silently stays below 44px.
test('shell chrome: a docked sidebar rule gated on data-open fails runtime.shell.dockedRows', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withPatchedPack(SHELL_PACK, source => {
    assert.ok(source.includes(':not([data-dsh-adapt="off"]) .dshm-drawer [data-slot="sidebar"] [role="treeitem"]'))
    return source.replace(
      ':not([data-dsh-adapt="off"]) .dshm-drawer [data-slot="sidebar"] [role="treeitem"]',
      ':not([data-dsh-adapt="off"]) .dshm-drawer[data-open="never"] [data-slot="sidebar"] [role="treeitem"]',
    )
  }, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 when docked rows stay below the floor\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    assert.notEqual(result.payload, null, 'check-pack --json output was not JSON (is Playwright/Chromium available?)')
    assert.equal(result.payload.ok, false, 'check-pack --json should report ok=false')
    const pack = result.payload.packs.find(item => item.id === 'shell-chrome')
    assert.ok(pack, 'shell-chrome missing from the --json report')
    const assertion = pack.assertions.find(item => item.id === 'runtime.shell.dockedRows')
    assert.ok(assertion, 'runtime.shell.dockedRows missing from the report')
    assert.equal(assertion.status, 'failed', `expected the data-open-gated rule to fail dockedRows, got ${assertion.status}: ${assertion.message}`)
    assert.match(assertion.message, /32px/, `the failure should name the unraised row height: ${assertion.message}`)
  })
})

// Reviewer F1 (t15): the rail rule used to lift height only (36×36 → 36×44). Width is
// part of the 44px target, so the rail assertion now checks both edges; a rule that
// drops min-width must fail.
test('shell chrome: a height-only rail rule fails runtime.shell.rail', { skip, timeout: RUN_TIMEOUT_MS }, () => {
  withPatchedPack(SHELL_PACK, source => {
    assert.ok(source.includes('min-width: 44px !important;'))
    // Drop the width floor while keeping the height floor: rail (36x36) and
    // drawerToggle (28x28 / 36x36) must then fail their width assertions.
    return source.replace('min-width: 44px !important;', 'min-width: 36px !important;')
  }, packDir => {
    const result = runChecker(packDir)
    assert.equal(result.status, 1, `check-pack should exit 1 when rail width stays below 44px\nstdout: ${result.stdout?.slice(0, 2000)}\nstderr: ${result.stderr?.slice(0, 2000)}`)
    assert.notEqual(result.payload, null, 'check-pack --json output was not JSON (is Playwright/Chromium available?)')
    assert.equal(result.payload.ok, false, 'check-pack --json should report ok=false')
    const pack = result.payload.packs.find(item => item.id === 'shell-chrome')
    assert.ok(pack, 'shell-chrome missing from the --json report')
    const assertion = pack.assertions.find(item => item.id === 'runtime.shell.rail')
    assert.ok(assertion, 'runtime.shell.rail missing from the report')
    assert.equal(assertion.status, 'failed', `expected the height-only rail rule to fail, got ${assertion.status}: ${assertion.message}`)
    assert.match(assertion.message, /36×44/, `the failure should name both edges: ${assertion.message}`)
    const toggle = pack.assertions.find(item => item.id === 'runtime.shell.drawerToggle')
    assert.ok(toggle, 'runtime.shell.drawerToggle missing from the report')
    assert.equal(toggle.status, 'failed', `expected the height-only rule to fail the toggle width too, got ${toggle.status}: ${toggle.message}`)
  })
})
