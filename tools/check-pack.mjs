#!/usr/bin/env node
/**
 * check-pack.mjs — one adaptation pack, three layers, no device.
 *
 *   node tools/check-pack.mjs packs/<id> [packs/<id> ...] [--json] [--desktop]
 *   node tools/check-pack.mjs                     # every pack under packs/
 *
 * Layers:
 *   1. static  — extension.json carries exactly the five runtime fields and its
 *                id equals the directory name; every selector in mobile.css is
 *                scoped to the panel state (`[data-dsh-panel="1"]` for the host's
 *                own state, `[data-dshm-adapt-panel="1"]` for a pack's own state),
 *                `(pointer: coarse)` or `[data-dsh-adapt="off"]`, and names no
 *                third-party plugin; the mobile.js script calls
 *                `window.dshMobile.define` with the same id and apiVersion 1.
 *   2. runtime — a fixture that reproduces the phone shell's DOM, wrapped around
 *                a deliberately desktop-first panel (28px buttons, 32px inputs,
 *                a full-width root). At 390×844 with a coarse pointer the pack's
 *                mobile.css then mobile.js run; the panel controls must reach a
 *                44px hit floor and the page must not overflow 390px.
 *   host state  — when a pack gates rules on the host's own `data-dsh-panel`
 *                (the dsh-mobile #319 contract), the harness also simulates a host
 *                that already owns that attribute: the gated rules must back off,
 *                the host attribute must stay untouched, and whatever the pack
 *                keeps on both release lines (e.g. `min-width`) must still apply.
 *   3. desktop — the same fixture at 1280×800 with a fine pointer. The three
 *                rules must move nothing: every measured value equals the
 *                no-pack baseline. `--desktop` adds strict parity of the
 *                computed box of `.dshm-mainContent` and every control rect.
 *   opt-out     — the panel root carries `data-dsh-adapt="off"`; all measured
 *                values must fall back to the no-pack baseline.
 *   fixture     — an optional `packs/<id>/fixture.html` replaces the built-in
 *                fixture for all rounds; when absent the built-in fixture is used
 *                and the report says so. Contract: docs/定向-fixture.md.
 *
 * `--json` prints one machine-readable object instead of the tables. Any failed
 * assertion exits 1; usage errors exit 2.
 *
 * The tool never edits the pack, never touches the network and never writes to
 * $DSH_HOME. What it cannot prove stays with a device: thumb accuracy, the real
 * env(safe-area-inset-*), momentum scrolling and the soft keyboard.
 *
 * Platforms: Linux, macOS and Windows. Windows checkouts with CRLF line endings
 * and case-insensitive paths are supported; paths in the report are shown with
 * forward slashes and existing pack directories are canonicalised to their
 * on-disk case, so `PACKS\CORE-PANEL` and `packs/core-panel` are the same pack.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PACKS_DIR = path.join(REPO, 'packs')
const WINDOWS = process.platform === 'win32'
const DEFAULT_DSH_HOME = path.join(homedir(), '.dsh')

/** Expand a leading `~` / `~/…` before resolving a user-supplied path. */
function expandHome(value) {
  const trimmed = String(value).trim()
  if (trimmed === '~') return homedir()
  return /^~[\\/]/.test(trimmed) ? path.join(homedir(), trimmed.slice(2)) : trimmed
}

/** `$DSH_HOME` with the same semantics as install.mjs: trim, expand `~`, resolve. */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (configured === undefined || configured.trim() === '') return DEFAULT_DSH_HOME
  return path.resolve(expandHome(configured))
}

/** Canonical on-disk case for paths that exist (Windows filesystems ignore case). */
function onDiskPath(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return target
  }
}

function foldPath(target) {
  const resolved = path.resolve(target)
  return WINDOWS ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return foldPath(left) === foldPath(right)
}

function isInsideDirectory(parent, child) {
  const foldedParent = foldPath(parent)
  const foldedChild = foldPath(child)
  return foldedChild === foldedParent || foldedChild.startsWith(foldedParent.endsWith(path.sep) ? foldedParent : foldedParent + path.sep)
}

/** Report paths with forward slashes so --json and docs are identical across OSes. */
function displayPath(target) {
  return String(target).split(path.sep).join('/')
}

const PACKS_DIR_REAL = onDiskPath(PACKS_DIR)

const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 })
const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 })
const HIT_TARGET = 44
const INPUT_FONT_SIZE = 16
const EPSILON = 0.5

/**
 * The host floor dsh-mobile >=0.8.1 applies to an open plugin panel, copied from
 * the installed `lib/mobile-layout.js:504-513` (min-width + min-height for
 * button/[role=button]/select/input, input font size, panel-root clamp, pane
 * scrolling). The host-owned probe injects it so it can prove the pack does not
 * *shrink* the floor the host provides — not merely that the pack's own selectors
 * stopped matching. Kept in sync with the host by hand: it is a test fixture, not a
 * claim that every host version looks like this.
 */
const HOST_FLOOR_CSS = [
  '.dshm-main[data-dsh-panel="1"] .dshm-mainContent{overflow-y:auto;overscroll-behavior:contain}',
  '.dshm-main[data-dsh-panel="1"] .dshm-mainContent>[data-slot="main"]>:not([data-dsh-adapt="off"]){max-width:100%;box-sizing:border-box}',
  '@media (pointer: coarse){',
  '.dshm-main[data-dsh-panel="1"] [data-slot="main"]>:not([data-dsh-adapt="off"]) :is(button,[role="button"],select,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=color]):not([type=file]):not([type=image])):not([role="switch"],[role="checkbox"],[role="radio"],[role="slider"],[data-dsh-adapt="off"],[data-dsh-adapt="off"] *){min-width:44px!important;min-height:44px!important}',
  '.dshm-main[data-dsh-panel="1"] [data-slot="main"]>:not([data-dsh-adapt="off"]) :is(button,[role="button"],a):not([data-dsh-adapt="off"],[data-dsh-adapt="off"] *){touch-action:manipulation}',
  'body:has(.dshm-shell) :is(input,textarea){font-size:max(16px,1em,var(--dsh-content-font-size,1em))!important}',
  '}',
].join('\n')
// Input types that do not accept text; their font-size has nothing to do with the
// iOS focus-zoom behaviour the inputFontSize assertion protects.
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
// Inputs the dsh-mobile 0.8.1 host floor excludes (lib/mobile-layout.js:507) plus the
// roles it excludes; a host-probe must not demand 44px from those.
const NON_FLOOR_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'hidden', 'color', 'file', 'image'])
const NON_FLOOR_ROLES = new Set(['switch', 'checkbox', 'radio', 'slider'])

const PACK_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const MANIFEST_FIELDS = Object.freeze(['description', 'id', 'name', 'schemaVersion', 'version'])
const CSS_LIMIT = 512 * 1024
const JS_LIMIT = 1024 * 1024
const MANIFEST_LIMIT = 64 * 1024
const FIXTURE_LIMIT = 256 * 1024
const FIXTURE_FILE = 'fixture.html'
// Required document skeleton for a per-pack fixture; checked in a real browser so
// a class mentioned only in an inline <style> cannot satisfy it.
const FIXTURE_REQUIRED_SELECTORS = Object.freeze(['.dshm-shell', '.dshm-main', '.dshm-mainContent', '[data-slot="main"]'])

const ROOT = { 'data-slot': true, role: true }

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const flags = { json: false, desktop: false }
const packArgs = []
for (const value of argv) {
  if (value === '--json') flags.json = true
  else if (value === '--desktop') flags.desktop = true
  else if (value === '--help' || value === '-h') {
    console.log(usage())
    process.exit(0)
  } else if (value.startsWith('--')) {
    console.error(`未知参数：${value}\n\n${usage()}`)
    process.exit(2)
  } else packArgs.push(value)
}

if (packArgs.length === 0) {
  packArgs.push(...listPackDirectories())
}

const packPaths = []
for (const argument of packArgs) {
  const resolved = onDiskPath(path.resolve(process.cwd(), argument))
  if (samePath(resolved, PACKS_DIR_REAL)) packPaths.push(...listPackDirectories())
  else packPaths.push(resolved)
}
const selected = []
for (const packPath of packPaths) {
  if (isInsideDirectory(PACKS_DIR_REAL, packPath) === false) {
    selected.push({ path: packPath, skip: null, id: path.basename(packPath) })
    continue
  }
  const name = path.basename(packPath)
  if (name.startsWith('_')) {
    selected.push({ path: packPath, skip: `目录名以下划线开头（${name}）：不参与校验`, id: name })
    continue
  }
  selected.push({ path: packPath, skip: null, id: name })
}

if (selected.length === 0) {
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ tool: 'check-pack', version: 1, ok: true, packs: [] }, null, 2)}\n`)
  } else {
    console.log('packs/ 下没有可校验的包（_template 已跳过）')
  }
  process.exit(0)
}

// ---------------------------------------------------------------- report

class PackReport {
  constructor(id, directory) {
    this.id = id
    this.directory = directory
    this.relative = displayPath(path.relative(process.cwd(), directory)) || displayPath(directory)
    this.ok = true
    this.assertions = []
    this.measurements = {}
    this.fixture = null
    this.error = null
  }

  record(layer, assertion, status, message, detail) {
    const entry = { layer, id: assertion, status, message }
    if (detail !== undefined) entry.detail = detail
    this.assertions.push(entry)
    if (status === 'failed') this.ok = false
    return status === 'passed'
  }

  pass(layer, id, message, detail) { return this.record(layer, id, 'passed', message, detail) }
  warn(layer, id, message, detail) { return this.record(layer, id, 'warning', message, detail) }
  skip(layer, id, message, detail) { return this.record(layer, id, 'skipped', message, detail) }
  fail(layer, id, message, detail) { return this.record(layer, id, 'failed', message, detail) }

  counts() {
    const counts = { passed: 0, failed: 0, skipped: 0, warning: 0 }
    for (const entry of this.assertions) counts[entry.status] += 1
    return counts
  }
}

// ---------------------------------------------------------------- static layer

function inspectStatic(report) {
  const dir = report.directory
  if (existsSync(dir) === false || statSync(dir).isDirectory() === false) {
    report.fail('static', 'static.directory', `包目录不存在：${dir}`)
    return { css: null, js: null, fixture: null }
  }
  report.pass('static', 'static.directory', '包目录存在')

  inspectManifest(report)
  const css = inspectCss(report)
  const js = inspectJs(report, path.basename(report.directory))
  const fixture = inspectFixture(report)
  inspectCatalog(report)
  return { css, js, fixture }
}

function inspectManifest(report) {
  const file = path.join(report.directory, 'extension.json')
  if (existsSync(file) === false) {
    report.fail('static', 'static.manifest.present', '缺少 extension.json')
    return null
  }
  const bytes = readFileSync(file)
  if (bytes.byteLength > MANIFEST_LIMIT) {
    report.fail('static', 'static.manifest.size', `extension.json 超过 64 KB（${bytes.byteLength} 字节）`)
  } else {
    report.pass('static', 'static.manifest.size', `extension.json ${bytes.byteLength} 字节（≤ 64 KB）`)
  }

  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    report.fail('static', 'static.manifest.json', `extension.json 不是合法 JSON：${error.message}`)
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    report.fail('static', 'static.manifest.json', 'extension.json 顶层必须是对象')
    return null
  }
  report.pass('static', 'static.manifest.json', 'extension.json 可解析为对象')

  const keys = Object.keys(value).sort()
  const expected = [...MANIFEST_FIELDS].sort()
  const missing = expected.filter(key => keys.includes(key) === false)
  const extra = keys.filter(key => expected.includes(key) === false)
  if (missing.length === 0 && extra.length === 0) {
    report.pass('static', 'static.manifest.fields', '字段集合恰为 schemaVersion/id/name/version/description', { fields: keys })
  } else {
    const parts = []
    if (missing.length > 0) parts.push(`缺少 ${missing.join(', ')}`)
    if (extra.length > 0) parts.push(`多出 ${extra.join(', ')}`)
    report.fail('static', 'static.manifest.fields', `字段集合不是恰好 5 个：${parts.join('；')}（运行时整包拒绝）`, { fields: keys })
  }

  if (value.schemaVersion === 1) {
    report.pass('static', 'static.manifest.schemaVersion', 'schemaVersion === 1')
  } else {
    report.fail('static', 'static.manifest.schemaVersion', `schemaVersion 必须为 1，实际 ${JSON.stringify(value.schemaVersion)}`)
  }

  const directoryName = path.basename(report.directory)
  const validId = typeof value.id === 'string' && PACK_ID_RE.test(value.id)
  if (typeof value.id === 'string' && value.id === directoryName && validId) {
    report.pass('static', 'static.manifest.id', `id === 目录名（${value.id}）且匹配 ${PACK_ID_RE}`)
  } else if (typeof value.id === 'string' && value.id !== directoryName) {
    report.fail('static', 'static.manifest.id', `id（${value.id}）必须等于目录名（${directoryName}）`)
  } else {
    report.fail('static', 'static.manifest.id', `id 必须是匹配 ${PACK_ID_RE} 的小写标识，实际 ${JSON.stringify(value.id)}`)
  }

  for (const field of ['name', 'version', 'description']) {
    const fieldValue = value[field]
    if (typeof fieldValue === 'string' && fieldValue.trim() !== '') {
      report.pass('static', `static.manifest.${field}`, `${field} 是非空字符串`)
    } else {
      report.fail('static', `static.manifest.${field}`, `${field} 必须是非空字符串（收录要求有描述）`)
    }
  }
  return value
}

function inspectCss(report) {
  const file = path.join(report.directory, 'mobile.css')
  if (existsSync(file) === false) {
    report.skip('static', 'static.css.present', '没有 mobile.css（纯 JS 包）')
    return null
  }
  const bytes = readFileSync(file)
  if (bytes.byteLength > CSS_LIMIT) {
    report.fail('static', 'static.css.size', `mobile.css 超过 512 KB（${bytes.byteLength} 字节）`)
  } else {
    report.pass('static', 'static.css.size', `mobile.css ${bytes.byteLength} 字节（≤ 512 KB）`)
  }
  const source = bytes.toString('utf8')
  const rules = parseStylesheet(source)
  let selectorCount = 0
  let scopeFailures = 0
  let markerFailures = 0
  let hashFailures = 0

  for (const rule of rules) {
    if (rule.kind === 'statement') {
      if (/^@import\b/i.test(rule.prelude)) {
        report.fail('static', 'static.css.import', `第 ${rule.line} 行出现 @import：包不得引入外部样式（不联网）`)
      }
      continue
    }
    if (rule.kind === 'at-block') {
      report.fail('static', 'static.css.at-rule', `第 ${rule.line} 行出现未支持的 at-rule：${rule.prelude.slice(0, 80)}`)
      continue
    }
    for (const rawSelector of splitSelectors(rule.selector)) {
      const selector = rawSelector.trim()
      if (selector === '') continue
      selectorCount += 1
      if (/:has\s*\(/i.test(selector)) {
        hashFailures += 1
        report.fail('static', 'static.css.has', `第 ${rule.line} 行用了 :has()：兼容没有 :has 的 WebView，状态请用 data 属性`)
      }
      const markers = thirdPartyMarkers(selector)
      if (markers.length > 0) {
        markerFailures += 1
        report.fail('static', 'static.css.third-party', `第 ${rule.line} 行出现第三方插件标记 ${markers.join(' / ')}：只允许 .dshm-*、[data-slot]、[role] 与 data-dsh* 自写契约`, { selector })
      }
      const scope = selectorScope(rule, selector)
      if (scope === null) {
        scopeFailures += 1
        report.fail('static', 'static.css.scope', `第 ${rule.line} 行选择器不在 [data-dsh-panel] / 包自有 data-dsh*="1" / (pointer: coarse) / [data-dsh-adapt="off"] 作用域内：${selector}`, { selector })
      }
    }
  }

  if (scopeFailures === 0) {
    report.pass('static', 'static.css.scope', `全部 ${selectorCount} 条选择器都落在允许的作用域内`)
  }
  if (markerFailures === 0) {
    report.pass('static', 'static.css.third-party', '没有第三方插件类名 / id（只用外壳标记）')
  }
  if (hashFailures === 0) {
    report.pass('static', 'static.css.has', '没有使用 :has()')
  }
  // A pack may gate rules on the host's own panel state (dsh-mobile #319 writes
  // `data-dsh-panel` on the main pane). When it does, the runtime layer simulates
  // that host and proves the gated rules back off instead of duplicating the host.
  report.hostGate = /:not\(\s*\[\s*data-dsh-panel\s*\]\s*\)/.test(source)
  if (report.hostGate === true) {
    report.pass('static', 'static.css.hostGate', '用 :not([data-dsh-panel]) 作宿主门阀：宿主接管面板状态时对应规则退让')
  }
  return source
}

function inspectJs(report, directoryId) {
  const file = path.join(report.directory, 'mobile.js')
  if (existsSync(file) === false) {
    report.skip('static', 'static.js.present', '没有 mobile.js（纯 CSS 包）')
    return null
  }
  const bytes = readFileSync(file)
  if (bytes.byteLength > JS_LIMIT) {
    report.fail('static', 'static.js.size', `mobile.js 超过 1 MB（${bytes.byteLength} 字节）`)
  } else {
    report.pass('static', 'static.js.size', `mobile.js ${bytes.byteLength} 字节（≤ 1 MB）`)
  }
  const source = bytes.toString('utf8')

  const defineMatch = source.match(/dshMobile\s*(?:\?\.)?\.?\s*define\s*\(/)
  if (defineMatch === null) {
    report.fail('static', 'static.js.define', 'mobile.js 没有调用 window.dshMobile.define(...)')
    return { source, id: null }
  }
  report.pass('static', 'static.js.define', 'mobile.js 调用了 window.dshMobile.define(...)')

  const tail = source.slice(defineMatch.index + defineMatch[0].length)
  const objectOpen = tail.indexOf('{')
  if (objectOpen === -1) {
    report.fail('static', 'static.js.definition', 'define 的参数不是对象字面量，无法静态核对 id / apiVersion / activate')
    return { source, id: null }
  }
  const objectClose = findBlockEnd(tail, objectOpen, tail.length)
  const objectBody = tail.slice(objectOpen + 1, objectClose)
  const fields = topLevelFields(objectBody)

  const idRaw = fields.get('id')
  let staticId = null
  const idLiteral = idRaw === undefined ? null : idRaw.trim().match(/^(['"`])([^'"`]+)\1$/)
  if (idLiteral === null) {
    report.fail('static', 'static.js.id', "mobile.js 的 define 缺少字面量 id（需要 id: '<目录名>'，便于静态核对）")
  } else {
    staticId = idLiteral[2]
    if (staticId === directoryId) {
      report.pass('static', 'static.js.id', `define 的 id 与目录名一致（${staticId}）`)
    } else {
      report.fail('static', 'static.js.id', `define 的 id（${staticId}）必须等于目录名（${directoryId}）`)
    }
  }

  if (fields.get('apiVersion')?.trim() === '1') {
    report.pass('static', 'static.js.apiVersion', 'apiVersion === 1')
  } else {
    report.fail('static', 'static.js.apiVersion', 'define 缺少 apiVersion: 1（运行时不会激活）')
  }

  if (fields.has('activate') || /(^|[,{\s])activate\s*\(/.test(objectBody)) {
    report.pass('static', 'static.js.activate', 'define 提供了 activate')
  } else {
    report.fail('static', 'static.js.activate', 'define 缺少 activate 函数')
  }
  return { source, id: staticId }
}

/**
 * Per-pack fixture support: `packs/<id>/fixture.html` replaces the built-in
 * fixture for every round (baseline, pack, opt-out, desktop). This is the static
 * half — size/markup/no-script/no-external checks. The DOM parse and the required
 * shell skeleton are verified in a real, offline browser by
 * `inspectFixtureInBrowser` once one is available.
 */
function inspectFixture(report) {
  const file = path.join(report.directory, FIXTURE_FILE)
  if (existsSync(file) === false) {
    report.fixture = { kind: 'builtin', path: null, bytes: null }
    return null
  }
  const relative = path.relative(REPO, file).split(path.sep).join('/')
  const bytes = readFileSync(file)
  const info = { kind: 'custom', path: relative, bytes: bytes.byteLength, source: null, loadable: false }
  report.fixture = { kind: 'custom', path: relative, bytes: bytes.byteLength }

  let sizeOk = true
  if (bytes.byteLength === 0) {
    sizeOk = false
    report.fail('static', 'static.fixture.size', `${FIXTURE_FILE} 是空文件`)
  } else if (bytes.byteLength > FIXTURE_LIMIT) {
    sizeOk = false
    report.fail('static', 'static.fixture.size', `${FIXTURE_FILE} 超过 256 KB（${bytes.byteLength} 字节）`)
  } else {
    report.pass('static', 'static.fixture.size', `${FIXTURE_FILE} ${bytes.byteLength} 字节（≤ 256 KB）`)
  }

  const source = bytes.toString('utf8').replace(/^\uFEFF/, '')
  info.source = source
  const lowered = source.toLowerCase()
  const missing = ['<html', '</html>', '<body', '</body>'].filter(token => lowered.includes(token) === false)
  const hasNul = source.includes('\u0000')
  if (missing.length > 0) {
    report.fail('static', 'static.fixture.markup', `${FIXTURE_FILE} 不是完整 HTML 文档：缺少 ${missing.join(' / ')}`)
  } else if (hasNul === true) {
    report.fail('static', 'static.fixture.markup', `${FIXTURE_FILE} 含有 NUL 字节`)
  } else {
    report.pass('static', 'static.fixture.markup', `${FIXTURE_FILE} 是完整 HTML 文档（<html>/<body> 齐全）`)
  }

  // A fixture is DOM + inline style only: check-pack injects the pack's own
  // mobile.css/mobile.js, so a fixture that ships scripts would bypass the
  // activation shim (and could do anything in an authenticated page). Inline
  // event handlers and javascript: URLs are script too — a `<svg onload>` is
  // enough to run code, so they are rejected alongside <script>.
  const scriptMatch = source.match(/<(?:script|iframe|object|embed)\b|\bon[a-z]+\s*=|\bjavascript\s*:/i)
  if (scriptMatch !== null) {
    report.fail('static', 'static.fixture.no-script', `${FIXTURE_FILE} 含可执行内容（${scriptMatch[0].trim()}）：脚本/事件处理属性/javascript: URL 都由 check-pack 注入链路之外执行，fixture 只放 DOM 与内联样式`)
  } else {
    report.pass('static', 'static.fixture.no-script', `${FIXTURE_FILE} 不含 <script>/<iframe>/<object>/<embed>、内联事件处理属性（on*=）或 javascript: URL`)
  }

  // Resource-bearing attributes are checked independently of the element name:
  // `<img srcset="data:…">`, `<form action=…>`, `<video poster=…>` and
  // `<iframe srcdoc=…>` all load or execute content without a `<script>` tag.
  const external = source.match(/\b(?:src|href|srcset|poster|action|formaction|srcdoc|http-equiv|xlink\s*:\s*href)\s*=|@import\b|\burl\s*\(|https?:\/\/|\bdata\s*:/i)
  if (external !== null) {
    report.fail('static', 'static.fixture.no-external', `${FIXTURE_FILE} 引用了外部/内联数据资源（${external[0].trim()}）：src/href/srcset/poster/action/formaction/srcdoc/http-equiv/xlink:href、@import/url()/http(s)/data: 均不允许，fixture 必须自包含`)
  } else {
    report.pass('static', 'static.fixture.no-external', `${FIXTURE_FILE} 不含 src/href/srcset/poster/action/formaction/srcdoc/http-equiv/xlink:href 属性，也不含 @import/url()/http(s)/data: 引用`)
  }

  info.loadable = sizeOk === true && scriptMatch === null && external === null && missing.length === 0 && hasNul === false
  return info
}

/**
 * Parse the custom fixture in a real (offline) browser and check the minimal DOM
 * contract from docs/定向-fixture.md. Runs before the pack is injected, so the
 * fixture never executes pack code during this step.
 */
async function inspectFixtureInBrowser(report, browser, fixture) {
  if (fixture.loadable === false) {
    report.skip('static', 'static.fixture.parse', 'fixture 未通过静态安全检查：跳过浏览器解析（不加载可疑内容）')
    return
  }
  let context = null
  try {
    context = await browser.newContext({ offline: true })
    const page = await context.newPage()
    await page.setContent(fixture.source, { waitUntil: 'load' })
    const state = await page.evaluate(required => ({
      tag: document.documentElement === null ? null : document.documentElement.tagName,
      missing: required.filter(selector => document.querySelector(selector) === null),
      panelRoot: document.querySelector('[data-slot="main"] > *') !== null,
    }), FIXTURE_REQUIRED_SELECTORS)
    if (state.tag === 'HTML') {
      report.pass('static', 'static.fixture.parse', `${fixture.path} 可被浏览器解析（DOM 已建立）`)
    } else {
      report.fail('static', 'static.fixture.parse', `${fixture.path} 无法解析成 HTML 文档（documentElement=${state.tag ?? 'null'}）`)
    }
    if (state.missing.length === 0 && state.panelRoot === true) {
      report.pass('static', 'static.fixture.structure', `定向 fixture 含壳骨架与面板根（${FIXTURE_REQUIRED_SELECTORS.join(' ')}）`)
    } else {
      const missing = [...state.missing]
      if (state.panelRoot === false) missing.push('[data-slot="main"] > *')
      report.fail('static', 'static.fixture.structure', `定向 fixture 缺少契约要求的元素：${missing.join(' / ')}（见 docs/定向-fixture.md）`)
    }
  } catch (error) {
    report.fail('static', 'static.fixture.parse', `定向 fixture 无法解析：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (context !== null) await context.close().catch(() => undefined)
  }
}

/**
 * Split the body of an object literal into `key -> raw value` at nesting depth 0.
 * Methods (`activate(api) {...}`) are not colon properties; callers detect those
 * separately.
 */
function topLevelFields(body) {
  const fields = new Map()
  let depth = 0
  let quote = null
  let start = 0
  const consume = end => {
    const segment = body.slice(start, end)
    const match = segment.match(/^\s*(?:["'`])?([\w$]+)(?:["'`])?\s*:\s*([\s\S]*?)\s*$/)
    if (match !== null) fields.set(match[1], match[2])
    start = end + 1
  }
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue }
    if (character === '{' || character === '(' || character === '[') depth += 1
    else if (character === '}' || character === ')' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) consume(index)
  }
  consume(body.length)
  return fields
}

function inspectCatalog(report) {
  const file = path.join(REPO, 'catalog.json')
  if (existsSync(file) === false) return
  let catalog
  try {
    catalog = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    report.warn('static', 'static.catalog', 'catalog.json 不是合法 JSON，无法核对登记一致性')
    return
  }
  const entries = Array.isArray(catalog?.packs) ? catalog.packs : []
  const entry = entries.find(item => item?.id === report.id)
  if (entry === undefined) {
    report.warn('static', 'static.catalog', `catalog.json 里没有 ${report.id} 的条目（收录时必须同时提交目录与条目）`)
  } else {
    report.pass('static', 'static.catalog', `catalog.json 已登记 ${report.id}（status=${entry.status ?? '?'}、risk=${entry.risk ?? '?'}、default=${entry.default ?? '?'}）`)
    if (Array.isArray(entry.capabilities)) {
      report.capabilities = new Set(entry.capabilities.map(name => String(name)))
    }
    if (Array.isArray(entry.usesHostMarkers)) report.declaredMarkers = entry.usesHostMarkers.map(String)
  }
}

/** Whether an assertion group should run: a declared capability, or everything
 *  when the catalog has no entry yet (an unreviewed pack still gets checked). */
function covers(report, capability) {
  if (report.capabilities === undefined) return true
  return report.capabilities.has(capability)
}

// ---------------------------------------------------------------- CSS parsing

const DESCEND_AT = new Set(['media', 'supports', 'layer', 'container', 'scope'])
const OPAQUE_AT = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'property', 'page', 'counter-style', 'font-feature-values'])

/** Remove comments but keep every newline so reported line numbers stay true. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
}

function lineAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === '\n') line += 1
  return line
}

function findBlockEnd(source, open, end) {
  let depth = 0
  let quote = null
  for (let index = open; index < end; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') { index += 1; continue }
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return end - 1
}

/** The next top-level `{` or `;` after `from` (parens and strings respected). */
function nextDelimiter(source, from, end) {
  let quote = null
  let parens = 0
  for (let index = from; index < end; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') { index += 1; continue }
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '(') parens += 1
    else if (character === ')') parens = Math.max(0, parens - 1)
    else if (parens === 0 && (character === '{' || character === ';')) return { index, character }
  }
  return { index: end, character: null }
}

/**
 * Walk a stylesheet into flat style rules. At-rules that only group rules are
 * descended into and remembered in `stack`, so a selector can be judged against
 * `@media (pointer: coarse)` and friends.
 */
function parseStylesheet(css) {
  const source = stripComments(css)
  const rules = []
  const walk = (start, end, stack) => {
    let index = start
    while (index < end) {
      while (index < end && /\s/.test(source[index])) index += 1
      if (index >= end) break
      const line = lineAt(source, index)
      const delimiter = nextDelimiter(source, index, end)
      if (delimiter.character === null) break
      const prelude = source.slice(index, delimiter.index).trim()
      if (delimiter.character === ';') {
        rules.push({ kind: 'statement', prelude, line, stack })
        index = delimiter.index + 1
        continue
      }
      const open = delimiter.index
      const close = findBlockEnd(source, open, end)
      if (prelude.startsWith('@')) {
        const name = (prelude.match(/^@([\w-]+)/) ?? [, ''])[1].toLowerCase()
        if (DESCEND_AT.has(name)) walk(open + 1, close, stack.concat({ name, prelude, line }))
        else if (OPAQUE_AT.has(name) === false) rules.push({ kind: 'at-block', prelude, line, stack })
      } else if (prelude !== '') {
        rules.push({ kind: 'style', selector: prelude, line, stack })
      }
      index = close + 1
    }
  }
  walk(0, source.length, [])
  return rules
}

function splitSelectors(selector) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      parts.push(selector.slice(start, index))
      start = index + 1
    }
  }
  parts.push(selector.slice(start))
  return parts
}

function selectorScope(rule, selector) {
  // The host's own panel-state attribute (dsh-mobile #319). Presence is enough:
  // a gate such as `:not([data-dsh-panel])` must count as panel-scoped.
  if (/\[\s*data-dsh-panel\s*(?:[~|^$*]?=\s*(?:"1"|'1'|1))?\s*\]/.test(selector)) return 'panel'
  // A pack's own state contract: any `data-dsh*="1"` attribute it writes itself
  // (`data-dshm-adapt-panel`, `data-dsh-floaters`, `data-dshm-example-panel`, …).
  if (/\[\s*data-dsh[\w-]*\s*=\s*(?:"1"|'1'|1)\s*\]/.test(selector)) return 'panel'
  if (/\[\s*data-dsh-adapt\s*=\s*(?:"off"|'off'|off)\s*\]/.test(selector)) return 'opt-out'
  for (const at of rule.stack) {
    if (at.name === 'media' && /\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/i.test(at.prelude)) return 'coarse'
  }
  return null
}

/**
 * Class / id / data attribute selectors that would name something other than the
 * shell. `.dshm-*`, `[data-slot]`, `[role]`, the pack's own `data-dsh*` contract
 * and the shell's state attributes (`data-open`, `data-pane`) are the only
 * allowed identities; a plugin's own class or test id must never be named.
 */
function thirdPartyMarkers(selector) {
  const offenders = []
  for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (match[1].startsWith('dshm-') === false) offenders.push(`.${match[1]}`)
  }
  for (const match of selector.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) {
    offenders.push(`#${match[1]}`)
  }
  for (const match of selector.matchAll(/\[\s*([^\s\]=~|^$*]+)/g)) {
    const name = match[1].toLowerCase()
    if (name === 'class' || name === 'id' || name === 'style') {
      offenders.push(`[${name}…]`)
      continue
    }
    if (name.startsWith('data-') === false) continue
    if (name === 'data-slot' || name === 'data-open' || name === 'data-pane' || name.startsWith('data-dsh')) continue
    offenders.push(`[${name}]`)
  }
  return [...new Set(offenders)]
}

// ---------------------------------------------------------------- browser fixture

const FIXTURE = (optOut) => `<!DOCTYPE html>
<html lang="zh-CN"${optOut === true ? ' data-dsh-adapt="off"' : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>check-pack fixture</title>
<script>window.__DSH_MOBILE_FRONTEND__ = "dedicated";</script>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #17181c; color: #e6e6e6;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .dshm-shell { display: grid; grid-template-columns: minmax(0, 1fr); height: 100vh; }
  .dshm-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .dshm-panelNav { display: flex; align-items: center; gap: 8px; min-height: 56px;
    padding: max(4px, env(safe-area-inset-top)) 12px 4px 68px; border-bottom: .5px solid #333; }
  .dshm-mainContent { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  [data-slot="main"] { display: contents; }
  /* A deliberately desktop-first panel: no hit floor, full width, desktop sizes. */
  .plugin-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; width: 100%; }
  .plugin-panel h2 { margin: 0; font-size: 16px; }
  .plugin-row { display: flex; align-items: center; gap: 8px; }
  .plugin-btn { min-height: 28px; padding: 0 10px; border: 0; border-radius: 8px;
    background: #262933; color: inherit; font: inherit; }
  .plugin-iconbtn { display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: #9aa0ab; }
  .plugin-input { min-height: 32px; width: 100%; padding: 4px 8px; border: 1px solid #3a3d45;
    border-radius: 8px; background: #16171b; color: inherit; font: inherit;
    /* dsh-mobile sets text fields to 16px to avoid iOS focus zoom; the fixture
       models the host so runtime.mobile.inputFontSize is measurable. */
    font-size: 16px; line-height: 1.25; }
  .plugin-select { min-height: 32px; width: 100%; padding: 4px 8px; border: 1px solid #3a3d45;
    border-radius: 8px; background: #16171b; color: inherit; font: inherit; }
  .dshm-drawer { position: fixed; inset: 0 auto 0 0; width: 56px; background: #1a1c22;
    padding-top: env(safe-area-inset-top); overflow: hidden; }
  .dshm-drawer .rail { width: 56px; height: 100%; display: grid; place-items: start center;
    gap: 4px; padding-top: 12px; }
  /* The drawer is a 56px icon rail when collapsed and a 280px overlay when open; the
     shell's own sidebar rows are desktop-density until a pack raises the floor.
     Both states matter: the rail's icon buttons and the docked session/project rows
     (role="treeitem") are separate touch surfaces. */
  .dshm-drawer[data-open="true"] { width: 280px; }
  .dshm-drawer[data-open="true"] .rail { display: none; }
  .dshm-drawer:not([data-open="true"]) .rows { display: none; }
  .dshm-drawer [data-slot="sidebar"] { display: flex; flex-direction: column; gap: 4px; padding: 12px 8px; }
  .dshm-drawer .rows { display: flex; flex-direction: column; gap: 4px; }
  .rail-icon { display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px;
    background: transparent; color: #9aa0ab; font: inherit; }
  /* The drawer's own expand/collapse toggle: t12/t17 measured 28x28 collapsed and
     36x36 expanded — same width gap as the rail icons. */
  .drawer-toggle { display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
    background: #262933; color: inherit; font: inherit; }
  .dshm-drawer[data-open="true"] .drawer-toggle { width: 36px; height: 36px; }
  .rail-btn { min-height: 28px; padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; color: inherit; font: inherit; text-align: left; }
  .row-item { display: flex; align-items: center; min-height: 32px; padding: 0 10px;
    border-radius: 8px; background: #20222a; color: inherit; font: inherit; }
  .row-item + .row-item { min-height: 34px; }
  /* A fixed widget pinned to the bottom-right corner, like a cost bubble or a
     helper entry point. It sits outside .dshm-shell and is not a panel. */
  .float-widget { position: fixed; right: 8px; bottom: 0; width: 112px; height: 118px;
    z-index: 9999; border-radius: 12px 12px 0 0; background: #2b3350; color: #cfd8ff;
    font-size: 11px; text-align: center; padding-top: 8px; }
</style></head>
<body>
  <div class="dshm-shell">
    <main class="dshm-main" data-pane="conversation">
      <div class="dshm-panelNav"><button type="button" aria-label="返回会话">‹ 返回会话</button></div>
      <div class="dshm-mainContent">
        <div data-slot="main">
          <div class="plugin-panel"${optOut === true ? ' data-dsh-adapt="off"' : ''}>
            <h2>插件面板</h2>
            <div class="plugin-row">
              <button type="button" class="plugin-btn">新建</button>
              <button type="button" class="plugin-iconbtn" aria-label="更多">···</button>
            </div>
            <input class="plugin-input" placeholder="搜索">
            <select class="plugin-select"><option>全部</option></select>
          </div>
        </div>
      </div>
    </main>
  </div>
  <aside class="dshm-drawer" data-open="false"><div data-slot="sidebar">
    <button type="button" class="drawer-toggle" data-fixture="drawer-toggle" aria-label="收起侧边栏">‹</button>
    <div class="rail" data-fixture="rail">
      <button type="button" class="rail-icon" aria-label="会话">≡</button>
      <button type="button" class="rail-icon" aria-label="文件">▤</button>
    </div>
    <div class="rows">
      <button type="button" class="rail-btn">会话</button>
      <button type="button" class="rail-btn">文件</button>
      <button type="button" class="rail-btn">设置</button>
      <div class="row-item" role="treeitem" aria-selected="false" tabindex="0">论文 · 新会话</div>
      <div class="row-item" role="treeitem" aria-selected="false" tabindex="0">项目 · demo</div>
    </div>
  </div></aside>
  <div class="float-widget">float widget</div>
</body></html>`

/**
 * Runs inside the page after the pack's CSS and JS are in place. The activation
 * shim mirrors the host: mobile.js is evaluated as a classic script, its
 * `window.dshMobile.define` definition is collected, and `activate(api)` gets a
 * minimal but honest API (document/window/signal + inert host/ui/native stubs).
 */
async function installPack(pack) {
  const queue = window.__checkPackDefinitions ?? []
  const results = []
  // The host keeps one definition per id (a later define replaces an earlier one).
  const byId = new Map()
  for (const definition of queue) byId.set(definition.id, definition)
  for (const definition of byId.values()) {
    const controller = new AbortController()
    const api = {
      document,
      window,
      signal: controller.signal,
      host: {
        invoke: async () => undefined,
        fetch: async () => new Response('', { status: 404 }),
        assetUrl: value => String(value),
      },
      ui: {
        registerSurface: () => ({ dispose() {} }),
        open: () => undefined,
        close: () => undefined,
        toast: () => undefined,
      },
      native: {
        capabilities: async () => [],
        invoke: async () => undefined,
      },
    }
    try {
      const cleanup = await definition.activate(api)
      results.push({
        id: definition.id,
        apiVersion: definition.apiVersion,
        activate: 'resolved',
        cleanup: typeof cleanup === 'function',
      })
    } catch (error) {
      results.push({
        id: definition.id,
        apiVersion: definition.apiVersion,
        activate: 'threw',
        error: String(error instanceof Error ? error.message : error),
      })
    }
  }
  return results
}

/** Runs inside the page; returns every number the assertions and tables use. */
function measurePage() {
  const round = value => Math.round(value * 10) / 10
  const rect = element => {
    if (element === null || element === undefined) return null
    const box = element.getBoundingClientRect()
    return {
      left: round(box.left),
      right: round(box.right),
      top: round(box.top),
      bottom: round(box.bottom),
      width: round(box.width),
      height: round(box.height),
    }
  }
  const visible = element => {
    if (element === null) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  const panel = document.querySelector('[data-slot="main"] > *')
  const controlSelector = '[data-slot="main"] :is(button, [role="button"], select, input, textarea)'
  const visibleControls = [...document.querySelectorAll(controlSelector)].filter(visible)
  const controls = visibleControls.map(element => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    type: (element.getAttribute('type') ?? 'text').toLowerCase(),
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    minHeight: getComputedStyle(element).minHeight,
    ...rect(element),
  }))
  // The built-in fixture uses desktop-first classes; a per-pack fixture only has
  // to provide generic elements. Prefer the legacy selectors so the existing
  // numbers stay byte-for-byte identical, then fall back to the first visible
  // button / field / singleton element in the panel.
  const isButton = element => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'
  const fallbackButton = visibleControls.find(isButton) ?? null
  const fallbackIconButton = visibleControls.find(element => isButton(element) === true && (element.textContent ?? '').trim() === '') ?? null
  const fallbackInput = visibleControls.find(element => element.tagName === 'INPUT') ?? null
  const fallbackSelect = visibleControls.find(element => element.tagName === 'SELECT') ?? null
  const floaterNode = document.querySelector('.float-widget') ?? document.querySelector('[data-fixture="floater"]')
  const main = document.querySelector('.dshm-main')
  const content = document.querySelector('.dshm-mainContent')
  const contentStyle = content === null ? null : getComputedStyle(content)
  const sidebarButtons = [...document.querySelectorAll('.dshm-drawer [data-slot="sidebar"] :is(button, [role="button"]):not([data-fixture="drawer-toggle"])')]
    .filter(visible)
    .map(element => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 12),
      ...rect(element),
    }))
  // Collapsed icon rail (visible while the drawer is closed) and docked rows
  // (`role="treeitem"` in the shell's workspace list). They are separate touch
  // surfaces from the expanded drawer's buttons, so they get their own readings.
  const railButtons = [...document.querySelectorAll('.dshm-drawer [data-fixture="rail"] :is(button, [role="button"])')]
    .filter(visible)
    .map(element => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 12),
      ...rect(element),
    }))
  const drawerToggle = rect(document.querySelector('.dshm-drawer [data-fixture="drawer-toggle"]'))
  const sidebarTreeitems = [...document.querySelectorAll('.dshm-drawer [data-slot="sidebar"] [role="treeitem"]')]
    .filter(visible)
    .map(element => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 12),
      ...rect(element),
    }))
  const buttonNode = document.querySelector('.plugin-btn') ?? fallbackButton
  const iconButtonNode = document.querySelector('.plugin-iconbtn') ?? fallbackIconButton
  const inputNode = document.querySelector('.plugin-input') ?? fallbackInput
  const selectNode = document.querySelector('.plugin-select') ?? fallbackSelect
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    coarse: window.matchMedia('(pointer: coarse)').matches,
    panel: rect(panel),
    button: rect(buttonNode),
    iconButton: rect(iconButtonNode),
    input: rect(inputNode),
    select: rect(selectNode),
    panelNavButton: rect(document.querySelector('.dshm-panelNav button')),
    sidebarButtons,
    drawerToggle,
    railButtons,
    sidebarTreeitems,
    drawer: rect(document.querySelector('.dshm-drawer')),
    controls,
    panelState: main === null ? null : main.getAttribute('data-dsh-panel'),
    ownPanelState: main === null ? null : main.getAttribute('data-dshm-adapt-panel'),
    floater: rect(floaterNode),
    floatersVar: getComputedStyle(document.documentElement).getPropertyValue('--dshm-floaters').trim(),
    floatersFlag: document.documentElement.getAttribute('data-dsh-floaters'),
    panelMarginBottom: panel === null ? null : getComputedStyle(panel).marginBottom,
    mainContent: contentStyle === null ? null : {
      paddingLeft: contentStyle.paddingLeft,
      marginLeft: contentStyle.marginLeft,
      overflowX: contentStyle.overflowX,
      overflowY: contentStyle.overflowY,
    },
    scrollWidth: document.documentElement.scrollWidth,
    styleNodeCount: document.querySelectorAll('style').length,
  }
}

async function runFixture(browser, options) {
  const { device, pack, optOut, fixture } = options
  const custom = fixture !== null && fixture !== undefined && fixture.kind === 'custom'
  const viewport = device === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT
  const context = await browser.newContext({
    viewport,
    hasTouch: device === 'mobile',
    isMobile: device === 'mobile',
    deviceScaleFactor: device === 'mobile' ? 2 : 1,
  })
  const errors = []
  try {
    const page = await context.newPage()
    await page.setContent(custom === true ? fixture.source : FIXTURE(optOut), { waitUntil: 'load' })
    // The built-in fixture bakes the opt-out marker into its markup; a per-pack
    // fixture stays generic, so the checker applies the documented opt-out itself
    // (document root + panel root) before the pack's CSS/JS is injected.
    if (custom === true && optOut === true) {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-dsh-adapt', 'off')
        const panelRoot = document.querySelector('[data-slot="main"] > *')
        if (panelRoot !== null) panelRoot.setAttribute('data-dsh-adapt', 'off')
      })
    }

    if (pack !== null && pack.css !== null) {
      try {
        await page.addStyleTag({ content: pack.css })
      } catch (error) {
        errors.push(`加载 mobile.css 失败：${error instanceof Error ? error.message : error}`)
      }
    }

    let activation = []
    if (pack !== null && pack.js !== null) {
      await page.evaluate(() => {
        window.__checkPackDefinitions = []
        window.dshMobile = {
          define(definition) { window.__checkPackDefinitions.push(definition) },
          register() {},
        }
      })
      try {
        await page.addScriptTag({ content: pack.js })
      } catch (error) {
        errors.push(`执行 mobile.js 失败：${error instanceof Error ? error.message : error}`)
      }
      if (errors.length === 0) {
        activation = await page.evaluate(installPack, {})
        if (activation.length > 0) {
          // Wait for whatever marker the pack writes (its own `data-dsh*` state, the
          // host's panel state, or a floater flag) instead of one pack's attribute name.
          await page.waitForFunction(
            () => {
              const main = document.querySelector('.dshm-main')
              if (main !== null && (main.hasAttribute('data-dsh-panel') || main.hasAttribute('data-dshm-adapt-panel'))) return true
              if (document.documentElement.hasAttribute('data-dsh-floaters')) return true
              const slot = document.querySelector('[data-slot="main"]')
              if (slot === null) return false
              // The slot root itself may carry the pack's marker too.
              for (const element of [slot, ...slot.querySelectorAll('*')]) {
                for (const attribute of element.attributes) {
                  if (attribute.name.startsWith('data-dsh')) return true
                }
              }
              return false
            },
            undefined,
            { timeout: 1500 },
          ).catch(() => undefined)
          await page.waitForTimeout(350)
        }
      }
    }

    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const metrics = await page.evaluate(measurePage)

    // A pack that gates rules on the host's own `data-dsh-panel` (dsh-mobile #319)
    // must back off once the host owns that attribute — and must never write it
    // itself. Two readings, both restored before the later measurements:
    //   A. sentinel value, no host CSS: proves the shim leaves the host attribute
    //      alone and the pack's own 44px floor is gone. "Gone" is read from the
    //      computed min-height (back to the no-pack value), because a rendered
    //      height below 44px could equally come from an unrelated 40px rule.
    //   B. `data-dsh-panel="1"` plus the host's own 0.8.1 floor: proves the pack
    //      does not shrink the floor the host provides (rendered height stays ≥44).
    let hostOwned = null
    if (options.probeHostGate === true && device === 'mobile') {
      const staged = await page.evaluate(async () => {
        const main = document.querySelector('.dshm-main')
        if (main === null) return false
        main.setAttribute('data-dsh-panel', 'host-probe')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return true
      })
      if (staged === true) {
        const retreated = await page.evaluate(measurePage)
        const stagedHost = await page.evaluate(async css => {
          const main = document.querySelector('.dshm-main')
          if (main === null) return false
          main.setAttribute('data-dsh-panel', '1')
          const style = document.createElement('style')
          style.setAttribute('data-checkpack-host-floor', '1')
          style.textContent = css
          document.head.append(style)
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return true
        }, HOST_FLOOR_CSS)
        const withHost = stagedHost === true ? await page.evaluate(measurePage) : null
        await page.evaluate(() => {
          document.querySelector('style[data-checkpack-host-floor]')?.remove()
          document.querySelector('.dshm-main')?.removeAttribute('data-dsh-panel')
        })
        hostOwned = { retreated, withHost }
      }
    }

    // The drawer is a rail when collapsed and an overlay when open; a shell pack
    // targets the open state (the thumb is what taps those rows), so measure it
    // with the drawer open as a second reading of the same page.
    let scrolled = null
    if (device === 'mobile') {
      scrolled = await page.evaluate(() => {
        const content = document.querySelector('.dshm-mainContent')
        if (content === null) return null
        content.scrollTop = content.scrollHeight
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const panel = document.querySelector('[data-slot="main"] > *')
          const floater = document.querySelector('.float-widget') ?? document.querySelector('[data-fixture="floater"]')
          resolve({
            contentScrollTop: Math.round(content.scrollTop),
            contentScrollable: content.scrollHeight > content.clientHeight + 1,
            panelBottom: panel === null ? null : Math.round(panel.getBoundingClientRect().bottom),
            floaterTop: floater === null ? null : Math.round(floater.getBoundingClientRect().top),
          })
        })))
      })
    }

    let openMetrics = null
    {
      const opened = await page.evaluate(() => {
        const drawer = document.querySelector('.dshm-drawer')
        if (drawer === null) return false
        drawer.setAttribute('data-open', 'true')
        return true
      })
      if (opened === true) {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        openMetrics = await page.evaluate(measurePage)
      }
    }
    return { metrics, openMetrics, scrolled, activation, errors, viewport, hostOwned }
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------- runtime assertions

const near = (left, right, epsilon = EPSILON) => Math.abs(left - right) <= epsilon
const fmt = value => (value === null || value === undefined ? '—' : `${value}px`)

/** Computed `min-height` as a number; `auto`/missing becomes null. */
function minHeightPx(value) {
  if (value === null || value === undefined) return null
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/** Whether the dsh-mobile >=0.8.1 host floor targets this control (lib:507). */
function hostFloorCovers(control) {
  if (NON_FLOOR_ROLES.has(control.role ?? '')) return false
  if (control.tag === 'button' || control.tag === 'select' || control.role === 'button') return true
  if (control.tag === 'input') return NON_FLOOR_INPUT_TYPES.has(control.type) === false
  return false
}

function checkDefinition(report, layer, fixture, packId) {
  const { activation, errors } = fixture
  if (errors.length > 0) {
    for (const message of errors) report.fail(layer, 'runtime.script', message)
    return
  }
  if (activation.length === 0) {
    report.fail(layer, 'runtime.define', 'mobile.js 执行后没有调用 window.dshMobile.define，包不会激活')
    return
  }
  if (activation.length > 1) {
    report.fail(layer, 'runtime.define', `mobile.js 注册了 ${activation.length} 个不同 id 的定义，一个包只能注册一个`)
    return
  }
  const [definition] = activation
  if (definition.apiVersion !== 1) {
    report.fail(layer, 'runtime.definition', `define 的 apiVersion 是 ${definition.apiVersion}，必须为 1`)
  } else if (definition.id !== packId) {
    report.fail(layer, 'runtime.definition', `define 的 id（${definition.id}）与目录名（${packId}）不一致`)
  } else if (definition.activate !== 'resolved') {
    report.fail(layer, 'runtime.definition', `activate 抛出异常：${definition.error ?? '未知错误'}`)
  } else {
    report.pass(layer, 'runtime.definition', `define 已注册 id=${definition.id}，activate 已执行${definition.cleanup ? '并返回清理函数' : ''}`)
  }
}

function validateBaseline(report, fixture, device, fixtureInfo) {
  const metrics = fixture.metrics
  const viewport = device === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT
  const label = `${viewport.width}×${viewport.height}`
  const custom = fixtureInfo !== null && fixtureInfo !== undefined && fixtureInfo.kind === 'custom'
  const openRows = fixture.openMetrics?.sidebarButtons ?? []
  const failures = []
  if (metrics.viewport.width !== viewport.width || metrics.viewport.height !== viewport.height) {
    failures.push(`视口是 ${metrics.viewport.width}×${metrics.viewport.height}，期望 ${viewport.width}×${viewport.height}`)
  }
  if (device === 'mobile' && metrics.coarse !== true) failures.push('粗指针环境没有生效（(pointer: coarse) 为 false）')
  if (device === 'desktop' && metrics.coarse !== false) failures.push('精指针环境没有生效（(pointer: coarse) 为 true）')
  if (custom === true) {
    // A per-pack fixture does not have to mimic the built-in desktop-first pixel
    // values, but it must expose the DOM the declared capabilities are asserted
    // against — otherwise the runtime layer would "pass" with nothing to measure.
    if (metrics.panel === null) failures.push('定向 fixture 里没有面板根（[data-slot="main"] > *）')
    if (metrics.controls.length === 0) failures.push('定向 fixture 里没有可测控件（[data-slot="main"] 内的 button/select/input/textarea）')
    if (covers(report, 'shell-hit-target')) {
      if (metrics.panelNavButton === null) failures.push('定向 fixture 缺少 .dshm-panelNav button（pack 声明了 shell-hit-target）')
      if (openRows.length === 0) failures.push('定向 fixture 缺少展开抽屉侧栏按钮（pack 声明了 shell-hit-target）')
    }
    if (covers(report, 'floater-clearance') && metrics.floater === null) {
      failures.push('定向 fixture 缺少浮动控件（加 [data-fixture="floater"]，pack 声明了 floater-clearance）')
    }
  } else {
    if (metrics.button === null || metrics.button.height > 30) failures.push(`基线按钮高度 ${fmt(metrics.button?.height)}，期望桌面优先的 28px`)
    if (metrics.input === null || metrics.input.height > 34) failures.push(`基线输入高度 ${fmt(metrics.input?.height)}，期望桌面优先的 32px`)
    if (metrics.panel === null || metrics.panel.left > 1) failures.push(`基线面板左缘 ${fmt(metrics.panel?.left)}，期望 0`)
    // Shell chrome must start below the floor too, otherwise a shell pack would
    // "pass" without having changed anything.
    if (metrics.panelNavButton === null || metrics.panelNavButton.height > 32) {
      failures.push(`基线返回栏按钮高度 ${fmt(metrics.panelNavButton?.height)}，期望桌面优先的 28px`)
    }
    if (openRows.length === 0) {
      failures.push('抽屉展开后没有可测的侧栏按钮')
    } else if (openRows.some(row => row.height > 32)) {
      failures.push(`基线抽屉侧栏按钮高度 ${fmt(openRows[0].height)}，期望桌面优先的 28px`)
    }
  }
  // Shell packs also need the two sidebar surfaces the harness now measures: the
  // collapsed rail's icon buttons and the docked list's `role="treeitem"` rows. Both
  // must start below the 44px floor, otherwise the pack would "pass" without lifting
  // anything.
  if (covers(report, 'shell-hit-target')) {
    const rail = metrics.railButtons ?? []
    const rows = fixture.openMetrics?.sidebarTreeitems ?? []
    if (rail.length === 0) failures.push('侧栏折叠轨道里没有可测按钮（[data-fixture="rail"] button）')
    if (rows.length === 0) failures.push('侧栏没有 docked 行（[data-slot="sidebar"] [role="treeitem"]）')
    if (rail.some(button => button.height >= HIT_TARGET - EPSILON)) {
      failures.push(`侧栏轨道按钮基线高度 ${fmt(rail[0].height)}，期望 < ${HIT_TARGET}px`)
    }
    if (rail.some(button => button.width >= HIT_TARGET - EPSILON)) {
      failures.push(`侧栏轨道按钮基线宽度 ${fmt(rail[0].width)}，期望 < ${HIT_TARGET}px`)
    }
    if (rows.some(row => row.height >= HIT_TARGET - EPSILON)) {
      failures.push(`侧栏 docked 行基线高度 ${fmt(rows[0].height)}，期望 < ${HIT_TARGET}px`)
    }
    // The drawer's own toggle is 28x28 collapsed / 36x36 expanded on the device
    // (t17); both states must start below the floor so the pack has to lift them.
    const toggle = metrics.drawerToggle
    const openToggle = fixture.openMetrics?.drawerToggle ?? null
    if (toggle === null || toggle === undefined || openToggle === null || openToggle === undefined) {
      failures.push('侧栏没有 drawerToggle（[data-fixture="drawer-toggle"]）')
    } else if (toggle.width >= HIT_TARGET - EPSILON || toggle.height >= HIT_TARGET - EPSILON
      || openToggle.width >= HIT_TARGET - EPSILON || openToggle.height >= HIT_TARGET - EPSILON) {
      failures.push(`drawerToggle 基线 ${fmt(toggle.width)}×${fmt(toggle.height)}（展开 ${fmt(openToggle.width)}×${fmt(openToggle.height)}），期望都 < ${HIT_TARGET}px`)
    }
  }
  for (const failure of failures) report.fail('runtime', `runtime.${device}.fixture`, `${label} fixture 基线不成立：${failure}`)
  if (failures.length === 0) {
    if (custom === true) {
      report.pass('runtime', `runtime.${device}.fixture`, `${label} 定向 fixture 基线成立（${fixtureInfo.path}：面板左缘 ${fmt(metrics.panel?.left)} / 控件 ${metrics.controls.length} 个 / 抽屉行 ${fmt(openRows[0]?.height)}）`)
    } else {
      report.pass('runtime', `runtime.${device}.fixture`, `${label} fixture 基线成立（按钮 ${fmt(metrics.button.height)} / 输入 ${fmt(metrics.input.height)} / 面板左缘 ${fmt(metrics.panel.left)} / 返回栏 ${fmt(metrics.panelNavButton?.height)} / 抽屉行 ${fmt(openRows[0]?.height)}）`)
    }
  }
  return failures.length === 0
}

function checkMobileAssertions(report, baseline, after, packId, hasScript, fixtureInfo) {
  const layer = 'runtime'
  if (after.metrics.coarse !== true) {
    report.fail(layer, 'runtime.mobile.pointer', '390×844 环境没有报告粗指针，媒体查询不会生效')
  } else {
    report.pass(layer, 'runtime.mobile.pointer', '390×844 · (pointer: coarse) 生效')
  }
  if (hasScript === true) checkDefinition(report, layer, after, packId)
  else report.skip(layer, 'runtime.define', '没有 mobile.js（纯 CSS 包）：跳过 define 校验')

  // Each group runs only when the catalog says the pack claims that capability,
  // so a shell-only pack is not failed for leaving plugin panels alone.
  const grew = []
  const buttons = after.metrics.controls.filter(control => control.tag === 'button' || control.role === 'button')
  const fields = after.metrics.controls.filter(control => control.tag !== 'button' && control.role !== 'button')
  const customFixture = fixtureInfo !== null && fixtureInfo !== undefined && fixtureInfo.kind === 'custom'
  if (covers(report, 'hit-target')) {
    const buttonFailures = buttons.filter(control => Math.min(control.width, control.height) < HIT_TARGET - EPSILON)
    if (buttons.length === 0) {
      report.fail(layer, 'runtime.mobile.button', 'fixture 面板里没有可测按钮')
    } else if (buttonFailures.length > 0) {
      report.fail(layer, 'runtime.mobile.button', `面板内有 ${buttonFailures.length}/${buttons.length} 个按钮小于 ${HIT_TARGET}px：${summarizeControls(buttonFailures)}`)
    } else {
      report.pass(layer, 'runtime.mobile.button', `面板内 ${buttons.length} 个按钮的最小边 ≥ ${HIT_TARGET}px`)
    }

    const fieldFailures = fields.filter(control => control.height < HIT_TARGET - EPSILON)
    if (fields.length === 0) {
      report.fail(layer, 'runtime.mobile.input', 'fixture 面板里没有可测输入控件')
    } else if (fieldFailures.length > 0) {
      report.fail(layer, 'runtime.mobile.input', `面板内有 ${fieldFailures.length}/${fields.length} 个输入控件小于 ${HIT_TARGET}px：${summarizeControls(fieldFailures)}`)
    } else {
      report.pass(layer, 'runtime.mobile.input', `面板内 ${fields.length} 个输入控件高度 ≥ ${HIT_TARGET}px`)
    }

    // iOS zooms the page when a focused text field's computed font-size is
    // below 16px; dsh-mobile sets that on its own inputs, and a pack must not
    // override it downwards. Non-text inputs (checkbox/radio/...) are not
    // affected by the focus-zoom rule and are not asserted here.
    const textFields = after.metrics.controls.filter(control =>
      control.tag === 'textarea'
      || (control.tag === 'input' && NON_TEXT_INPUT_TYPES.has(control.type) === false))
    if (textFields.length === 0) {
      report.skip(layer, 'runtime.mobile.inputFontSize', 'fixture 面板里没有可见文本输入（input/textarea）：跳过字号断言')
    } else {
      const smallFonts = textFields.filter(control => Number.isFinite(control.fontSize) === false || control.fontSize < INPUT_FONT_SIZE)
      if (smallFonts.length > 0) {
        const detail = smallFonts.map(control => `${control.tag}[${control.ariaLabel ?? control.type}] ${Number.isFinite(control.fontSize) ? `${control.fontSize}px` : '字号未知'}`).join('、')
        report.fail(layer, 'runtime.mobile.inputFontSize', `面板内有 ${smallFonts.length}/${textFields.length} 个文本输入的 computed font-size 小于 ${INPUT_FONT_SIZE}px：${detail}`)
      } else {
        report.pass(layer, 'runtime.mobile.inputFontSize', `面板内 ${textFields.length} 个文本输入的 computed font-size ≥ ${INPUT_FONT_SIZE}px`)
      }
    }

    if (after.metrics.iconButton !== null && after.metrics.iconButton.width < HIT_TARGET - EPSILON) {
      report.fail(layer, 'runtime.mobile.iconButton', `图标按钮宽 ${fmt(after.metrics.iconButton.width)}，小于 ${HIT_TARGET}px（svg-only 按钮要 ≥ ${HIT_TARGET}×${HIT_TARGET}）`)
    } else if (after.metrics.iconButton !== null) {
      report.pass(layer, 'runtime.mobile.iconButton', `图标按钮 ${fmt(after.metrics.iconButton.width)}×${fmt(after.metrics.iconButton.height)}`)
    }
    if (after.metrics.button.height > baseline.metrics.button.height + 1) grew.push('按钮')
  } else {
    report.skip(layer, 'runtime.mobile.button', 'catalog 未声明 hit-target：跳过面板命中下限')
  }

  // `width-reclaim` is an opt-in capability, but a directed fixture is a concrete
  // page layout: any pack rule (including the 44px min-width floor) can overflow
  // its 334px panel. So for custom fixtures the overflow pair always runs; the
  // built-in fixture keeps the capability gate.
  const reclaimGated = covers(report, 'width-reclaim')
  if (reclaimGated || customFixture) {
    const panel = after.metrics.panel
    const note = reclaimGated === false ? '（定向 fixture 无条件断言）' : ''
    if (panel !== null && panel.right > MOBILE_VIEWPORT.width + EPSILON) {
      report.fail(layer, 'runtime.mobile.panel.right', `面板右缘 x=${fmt(panel.right)}，超出 ${MOBILE_VIEWPORT.width}px 视口`)
    } else if (panel !== null) {
      report.pass(layer, 'runtime.mobile.panel.right', `面板右缘 x=${fmt(panel.right)}（≤ ${MOBILE_VIEWPORT.width}px）${note}`)
    }
    if (after.metrics.scrollWidth > MOBILE_VIEWPORT.width + EPSILON) {
      report.fail(layer, 'runtime.mobile.overflow', `页面 scrollWidth=${after.metrics.scrollWidth}，横向被撑宽`)
    } else {
      report.pass(layer, 'runtime.mobile.overflow', `页面 scrollWidth=${after.metrics.scrollWidth}（无横向溢出）${note}`)
    }
  } else {
    report.skip(layer, 'runtime.mobile.overflow', 'catalog 未声明 width-reclaim：跳过宽度回收')
  }

  if (covers(report, 'shell-hit-target') && checkShellAssertions(report, baseline, after) === true) grew.push('外壳')
  if (covers(report, 'floater-clearance') && checkFloaterAssertions(report, baseline, after) === true) grew.push('浮动控件让位')

  if (grew.length === 0) {
    report.fail(layer, 'runtime.mobile.applied', '适配没有改变任何基线数值：规则没有生效（或作用域不对）')
  } else {
    report.pass(layer, 'runtime.mobile.applied', `适配生效：${grew.join(' / ')}`)
  }
  return { buttons, fields }
}

/**
 * Host-owned panel state (`data-dsh-panel`, dsh-mobile #319). A pack that gates its
 * rules on the host's attribute must:
 *   - leave that attribute alone (the host owns it; a pack that also writes it
 *     would fight the host on every sync),
 *   - actually remove its own floor when the host takes over — read from **every**
 *     control's computed `min-height`, back to the no-pack value. A rendered height
 *     below 44px is not enough: an unrelated ungated 40px rule would satisfy that
 *     while still shrinking the host's floor,
 *   - never shrink any control below its no-pack baseline (a 16px input font may
 *     grow the intrinsic height; ±2px is tolerated, shrinking is not),
 *   - leave the host's own floor intact: with the 0.8.1 floor injected, every
 *     control the floor covers must still render at ≥ HIT_TARGET - EPSILON and
 *     above `baseline - 2`; controls the floor does not cover (textarea, switch…)
 *     must at least not shrink.
 * `after.hostOwned` carries both readings (`retreated`, `withHost`), each with the
 * full `controls` list measured on the same DOM.
 */
function checkHostGate(report, baseline, after) {
  const layer = 'runtime'
  const probe = after.hostOwned
  if (probe === null || probe === undefined || probe.retreated === undefined || probe.withHost === null || probe.withHost === undefined) {
    report.fail(layer, 'runtime.hostGate.probe', '无法模拟宿主自管面板状态（页面里没有 .dshm-main）')
    return
  }
  const retreated = probe.retreated
  const withHost = probe.withHost

  if (retreated.panelState === 'host-probe') {
    report.pass(layer, 'runtime.hostGate.untouched', '宿主自管的 data-dsh-panel 未被 shim 改写（两帧后仍是 host-probe）')
  } else {
    report.fail(layer, 'runtime.hostGate.untouched', `shim 改写了宿主的 data-dsh-panel：期望 host-probe，实际 ${retreated.panelState ?? 'null'}`)
  }

  if (retreated.ownPanelState === '1') {
    report.pass(layer, 'runtime.hostGate.own-state', '本包自己的 data-dshm-adapt-panel 仍由 shim 维护（=1）')
  } else if (retreated.ownPanelState === null) {
    // A pack may use its own marker name (e.g. data-dshm-context-panel on the panel
    // root). The gate itself is still proven by the two floor assertions below.
    report.skip(layer, 'runtime.hostGate.own-state', '本包不使用 data-dshm-adapt-panel：跳过自有状态断言（门阀退让仍会验证）')
  } else {
    report.fail(layer, 'runtime.hostGate.own-state', `本包自己的面板状态没有写对：data-dshm-adapt-panel=${retreated.ownPanelState}`)
  }

  const baselineControls = Array.isArray(baseline.controls) ? baseline.controls : []
  const retreatedControls = Array.isArray(retreated.controls) ? retreated.controls : []
  const hostControls = Array.isArray(withHost.controls) ? withHost.controls : []
  if (baselineControls.length === 0 || retreatedControls.length !== baselineControls.length || hostControls.length !== baselineControls.length) {
    report.fail(layer, 'runtime.hostGate.probe', `控件集合不一致：基线 ${baselineControls.length} / sentinel ${retreatedControls.length} / 宿主地板 ${hostControls.length}（同一 fixture 应当同序同量）`)
    return
  }

  const labelOf = (control, index) => `${control.tag}${control.role === null || control.role === undefined ? '' : `[role=${control.role}]`}${control.ariaLabel === null || control.ariaLabel === undefined ? '' : `[${control.ariaLabel}]`} #${index + 1}`
  const smallest = values => (values.length === 0 ? null : Math.min(...values))
  const firstFew = failures => failures.slice(0, 3).join('；')

  // The direct evidence that the gated floor is gone: every control's computed
  // min-height returns to the value the page had before the pack loaded. A residual
  // ungated `min-height` (e.g. 40px on one group) fails here even when the rendered
  // height is < 44px — and no control can hide by not being the "first" one.
  const minHeightFailures = []
  const probeMinHeights = []
  for (let index = 0; index < baselineControls.length; index += 1) {
    const base = baselineControls[index]
    const now = retreatedControls[index]
    const left = minHeightPx(now.minHeight)
    const right = minHeightPx(base.minHeight)
    if (left !== null) probeMinHeights.push(left)
    const same = (left === null && right === null) || (left !== null && right !== null && Math.abs(left - right) <= EPSILON)
    if (same === false) minHeightFailures.push(`${labelOf(now, index)} min-height ${now.minHeight ?? '—'} ≠ 基线 ${base.minHeight ?? '—'}`)
  }
  if (minHeightFailures.length > 0) {
    report.fail(layer, 'runtime.hostGate.floor-retreated', `宿主接管后 ${minHeightFailures.length}/${baselineControls.length} 个控件的 min-height 没有回到基线（最小 ${fmt(smallest(probeMinHeights))}）：${firstFew(minHeightFailures)}`)
  } else {
    report.pass(layer, 'runtime.hostGate.floor-retreated', `宿主接管后全部 ${baselineControls.length} 个控件的 min-height 回到基线（最小 ${fmt(smallest(probeMinHeights))}，容差 ${EPSILON}px）`)
  }

  // A gated-off pack must not make any control smaller than the page without it.
  const shrinkFailures = []
  const probeHeights = []
  for (let index = 0; index < baselineControls.length; index += 1) {
    const base = baselineControls[index]
    const now = retreatedControls[index]
    probeHeights.push(now.height)
    if (now.height < base.height - 2) shrinkFailures.push(`${labelOf(now, index)} ${fmt(now.height)} < 基线 ${fmt(base.height)} - 2`)
  }
  if (shrinkFailures.length > 0) {
    report.fail(layer, 'runtime.hostGate.no-shrink', `宿主接管后 ${shrinkFailures.length}/${baselineControls.length} 个控件被压得比无包基线更小：${firstFew(shrinkFailures)}`)
  } else {
    report.pass(layer, 'runtime.hostGate.no-shrink', `宿主接管后全部 ${baselineControls.length} 个控件不小于无包基线（最小高度 ${fmt(smallest(probeHeights))}，允许 ±2px 字号固有高度差）`)
  }

  // With the host's own floor on the page, the pack must still leave it at ≥44px for
  // every control the floor covers; anything else must at least not shrink.
  const keptFailures = []
  const keptHeights = []
  let coveredCount = 0
  for (let index = 0; index < baselineControls.length; index += 1) {
    const base = baselineControls[index]
    const now = hostControls[index]
    if (hostFloorCovers(now)) {
      coveredCount += 1
      keptHeights.push(now.height)
      if (now.height < HIT_TARGET - EPSILON) {
        keptFailures.push(`${labelOf(now, index)} ${fmt(now.height)} < ${HIT_TARGET}px`)
      } else if (now.height < base.height - 2) {
        keptFailures.push(`${labelOf(now, index)} ${fmt(now.height)} < 基线 ${fmt(base.height)} - 2`)
      }
    } else if (now.height < base.height - 2) {
      keptFailures.push(`${labelOf(now, index)} ${fmt(now.height)} < 基线 ${fmt(base.height)} - 2（宿主地板不覆盖此控件，也不得压小）`)
    }
  }
  if (keptFailures.length > 0) {
    report.fail(layer, 'runtime.hostGate.host-floor-kept', `本包把宿主的地板压小了：${keptFailures.length} 个不达标（覆盖 ${coveredCount}/${baselineControls.length} 个控件，最小高度 ${fmt(smallest(keptHeights))}）：${firstFew(keptFailures)}`)
  } else {
    report.pass(layer, 'runtime.hostGate.host-floor-kept', `注入 0.8.1 宿主地板后 ${coveredCount} 个受覆盖控件仍 ≥ ${HIT_TARGET}px（最小高度 ${fmt(smallest(keptHeights))}），其余控件未压小`)
  }
}

/**
 * Floating widgets: a fixed, bottom-right element sits over the panel. The pack
 * must not move it (that would need the third party's own class names); it has to
 * measure the space and give the panel room to scroll clear of it.
 */
function checkFloaterAssertions(report, baseline, after) {
  const layer = 'runtime'
  const floater = after.metrics.floater ?? baseline.metrics.floater
  if (floater === null || floater === undefined) {
    report.fail(layer, 'runtime.floater.fixture', 'fixture 里没有右下角浮动控件，无法验证让位')
    return false
  }
  let changed = false

  const declared = Number.parseFloat(after.metrics.floatersVar ?? '')
  if (!Number.isFinite(declared) || declared <= 0) {
    report.fail(layer, 'runtime.floater.measure', `没有量出浮动控件高度（--dshm-floaters = ${after.metrics.floatersVar || '未设置'}）`)
  } else if (declared < floater.height - 1) {
    report.fail(layer, 'runtime.floater.measure', `量出的让位 ${declared}px 小于浮动控件高度 ${floater.height}px`)
  } else {
    changed = true
    report.pass(layer, 'runtime.floater.measure', `量出浮动控件 ${floater.width}×${floater.height}，写入 --dshm-floaters=${declared}px`)
  }

  const overflowY = after.metrics.mainContent?.overflowY ?? ''
  if (overflowY !== 'auto' && overflowY !== 'scroll') {
    report.fail(layer, 'runtime.floater.scroll', `面板状态下 mainContent 的 overflow-y 是 ${overflowY || '—'}，内容无法滚到浮动控件上方`)
  } else {
    report.pass(layer, 'runtime.floater.scroll', `mainContent overflow-y=${overflowY}，可把末尾内容滚到控件上方`)
  }

  const margin = Number.parseFloat(after.metrics.panelMarginBottom ?? '')
  if (!Number.isFinite(margin) || margin < floater.height - 1) {
    report.fail(layer, 'runtime.floater.gap', `面板根 margin-bottom = ${after.metrics.panelMarginBottom || '—'}，没有留出 ${floater.height}px`)
  } else {
    report.pass(layer, 'runtime.floater.gap', `面板根 margin-bottom = ${after.metrics.panelMarginBottom}`)
  }

  const scrolled = after.scrolled
  if (scrolled === null || scrolled === undefined) {
    report.fail(layer, 'runtime.floater.reach', '无法读取滚动到底后的位置')
  } else if (scrolled.panelBottom === null || scrolled.floaterTop === null) {
    report.fail(layer, 'runtime.floater.reach', '滚动到底后找不到面板根或浮动控件')
  } else if (scrolled.panelBottom > scrolled.floaterTop + 1) {
    report.fail(layer, 'runtime.floater.reach', `滚到底后面板底部 y=${scrolled.panelBottom} 仍在浮动控件顶部 y=${scrolled.floaterTop} 之下（内容仍被压住）`)
  } else {
    report.pass(layer, 'runtime.floater.reach', `滚到底后面板底部 y=${scrolled.panelBottom} ≤ 控件顶部 y=${scrolled.floaterTop}`)
  }
  return changed
}

/**
 * Shell chrome: the panel's return bar and the open navigation drawer. Both are
 * always on screen, so they are gated by the coarse pointer alone rather than by
 * a panel state. `after.openMetrics` is the same page with the drawer open.
 */
function checkShellAssertions(report, baseline, after) {
  const layer = 'runtime'
  let changed = false
  const bar = after.metrics.panelNavButton
  if (bar === null) {
    report.fail(layer, 'runtime.shell.returnBar', 'fixture 里没有返回栏按钮（.dshm-panelNav button）')
  } else if (bar.height < HIT_TARGET - EPSILON || bar.width < HIT_TARGET - EPSILON) {
    report.fail(layer, 'runtime.shell.returnBar', `返回栏按钮 ${fmt(bar.width)}×${fmt(bar.height)}，小于 ${HIT_TARGET}px`)
  } else {
    const before = baseline.metrics.panelNavButton
    if (before === null || bar.height > before.height + 1) changed = true
    report.pass(layer, 'runtime.shell.returnBar', `返回栏按钮 ${fmt(bar.width)}×${fmt(bar.height)}${before === null ? '' : `（基线 ${fmt(before.width)}×${fmt(before.height)}）`}`)
  }

  const open = after.openMetrics
  const rows = open === null || open === undefined ? [] : open.sidebarButtons
  if (rows.length === 0) {
    report.fail(layer, 'runtime.shell.drawer', 'fixture 里没有抽屉侧栏按钮（.dshm-drawer [data-slot="sidebar"] button）')
  } else {
    const tooSmall = rows.filter(row => row.height < HIT_TARGET - EPSILON)
    if (tooSmall.length > 0) {
      report.fail(layer, 'runtime.shell.drawer', `抽屉展开后 ${tooSmall.length}/${rows.length} 个侧栏按钮高度小于 ${HIT_TARGET}px：${tooSmall.map(row => `${row.text} ${row.height}px`).join('、')}`)
    } else {
      const baseRows = baseline.openMetrics?.sidebarButtons ?? []
      if (baseRows.length > 0 && rows[0].height > baseRows[0].height + 1) changed = true
      report.pass(layer, 'runtime.shell.drawer', `抽屉展开后 ${rows.length} 个侧栏按钮高度 ≥ ${HIT_TARGET}px${baseRows.length > 0 ? `（基线 ${fmt(baseRows[0].height)}）` : ''}`)
    }
  }

  // Collapsed icon rail (visible while the drawer is closed): the host floor only
  // covers the main slot, so these icons are a real gap on both release lines.
  const rail = after.metrics.railButtons ?? []
  if (rail.length === 0) {
    report.fail(layer, 'runtime.shell.rail', 'fixture 里没有折叠轨道按钮（[data-fixture="rail"] button）')
  } else {
    const tooSmall = rail.filter(button => button.height < HIT_TARGET - EPSILON || button.width < HIT_TARGET - EPSILON)
    if (tooSmall.length > 0) {
      report.fail(layer, 'runtime.shell.rail', `折叠轨道 ${tooSmall.length}/${rail.length} 个图标按钮最小边小于 ${HIT_TARGET}px：${tooSmall.map(button => `${button.text || button.tag} ${button.width}×${button.height}px`).join('、')}`)
    } else {
      const baseRail = baseline.metrics.railButtons ?? []
      if (baseRail.length > 0 && (rail[0].height > baseRail[0].height + 1 || rail[0].width > baseRail[0].width + 1)) changed = true
      report.pass(layer, 'runtime.shell.rail', `折叠轨道 ${rail.length} 个图标按钮 ${fmt(rail[0].width)}×${fmt(rail[0].height)}（≥ ${HIT_TARGET}px）${baseRail.length > 0 ? `，基线 ${fmt(baseRail[0].width)}×${fmt(baseRail[0].height)}` : ''}`)
    }
  }

  // The drawer's own expand/collapse toggle: measured in both states (28x28 collapsed,
  // 36x36 expanded on the device). Width matters as much as height (t15 F1).
  const toggle = after.metrics.drawerToggle
  const openToggle = open === null || open === undefined ? null : open.drawerToggle
  if (toggle === null || toggle === undefined || openToggle === null || openToggle === undefined) {
    report.fail(layer, 'runtime.shell.drawerToggle', 'fixture 里没有 drawerToggle（[data-fixture="drawer-toggle"]）')
  } else if (toggle.width < HIT_TARGET - EPSILON || toggle.height < HIT_TARGET - EPSILON
    || openToggle.width < HIT_TARGET - EPSILON || openToggle.height < HIT_TARGET - EPSILON) {
    report.fail(layer, 'runtime.shell.drawerToggle', `drawerToggle ${fmt(toggle.width)}×${fmt(toggle.height)}（展开 ${fmt(openToggle.width)}×${fmt(openToggle.height)}），最小边小于 ${HIT_TARGET}px`)
  } else {
    const baseToggle = baseline.metrics.drawerToggle
    const baseOpen = baseline.openMetrics?.drawerToggle
    if (baseToggle !== null && baseToggle !== undefined && (toggle.width > baseToggle.width + 1 || toggle.height > baseToggle.height + 1)) changed = true
    if (baseOpen !== null && baseOpen !== undefined && (openToggle.width > baseOpen.width + 1 || openToggle.height > baseOpen.height + 1)) changed = true
    report.pass(layer, 'runtime.shell.drawerToggle', `drawerToggle 收起 ${fmt(toggle.width)}×${fmt(toggle.height)} / 展开 ${fmt(openToggle.width)}×${fmt(openToggle.height)}（≥ ${HIT_TARGET}px）`)
  }

  // Docked sidebar rows (`role="treeitem"`, the shell's own workspace list). Same
  // story: not in the host floor's scope, and the drawer's `data-open` state must not
  // decide whether they get a floor.
  const docked = open === null || open === undefined ? [] : open.sidebarTreeitems ?? []
  if (docked.length === 0) {
    report.fail(layer, 'runtime.shell.dockedRows', 'fixture 里没有 docked 侧栏行（[data-slot="sidebar"] [role="treeitem"]）')
  } else {
    const tooSmall = docked.filter(row => row.height < HIT_TARGET - EPSILON || row.width < HIT_TARGET - EPSILON)
    if (tooSmall.length > 0) {
      report.fail(layer, 'runtime.shell.dockedRows', `停靠侧栏 ${tooSmall.length}/${docked.length} 行高度小于 ${HIT_TARGET}px：${tooSmall.map(row => `${row.text} ${row.height}px`).join('、')}`)
    } else {
      const baseRows = baseline.openMetrics?.sidebarTreeitems ?? []
      if (baseRows.length > 0 && docked[0].height > baseRows[0].height + 1) changed = true
      report.pass(layer, 'runtime.shell.dockedRows', `停靠侧栏 ${docked.length} 行高度 ≥ ${HIT_TARGET}px${baseRows.length > 0 ? `（基线 ${fmt(baseRows[0].height)}）` : ''}`)
    }
  }
  return changed
}

function checkOptOut(report, baseline, optOut) {
  const layer = 'runtime'
  const failures = []
  const compare = (label, actual, expected) => {
    // A targeted fixture may legitimately omit an element the built-in fixture has
    // (e.g. no svg-only icon button). "absent on both sides" is not a regression;
    // "changed" or "present on one side only" still fails.
    const absent = value => value === null || value === undefined
    if (absent(actual) === true && absent(expected) === true) return
    if (absent(actual) === true || absent(expected) === true || near(actual, expected) === false) {
      failures.push(`${label} ${fmt(actual)} ≠ 基线 ${fmt(expected)}`)
    }
  }
  compare('按钮高度', optOut.metrics.button?.height, baseline.metrics.button?.height)
  compare('图标按钮宽度', optOut.metrics.iconButton?.width, baseline.metrics.iconButton?.width)
  compare('输入高度', optOut.metrics.input?.height, baseline.metrics.input?.height)
  compare('下拉高度', optOut.metrics.select?.height, baseline.metrics.select?.height)
  compare('面板左缘', optOut.metrics.panel?.left, baseline.metrics.panel?.left)
  compare('面板右缘', optOut.metrics.panel?.right, baseline.metrics.panel?.right)
  compare('面板宽度', optOut.metrics.panel?.width, baseline.metrics.panel?.width)
  // The opt-out marker sits on the document element in this fixture, so it has
  // to silence shell rules too — a shell pack that only looks at the panel root
  // would keep patting the thumb while the user asked it to stop.
  compare('返回栏按钮高度', optOut.metrics.panelNavButton?.height, baseline.metrics.panelNavButton?.height)
  compare('折叠轨道按钮高度', optOut.metrics.railButtons?.[0]?.height, baseline.metrics.railButtons?.[0]?.height)
  compare('折叠轨道按钮宽度', optOut.metrics.railButtons?.[0]?.width, baseline.metrics.railButtons?.[0]?.width)
  compare('drawerToggle 收起宽度', optOut.metrics.drawerToggle?.width, baseline.metrics.drawerToggle?.width)
  compare('drawerToggle 收起高度', optOut.metrics.drawerToggle?.height, baseline.metrics.drawerToggle?.height)
  compare('drawerToggle 展开宽度', optOut.openMetrics?.drawerToggle?.width, baseline.openMetrics?.drawerToggle?.width)
  compare('drawerToggle 展开高度', optOut.openMetrics?.drawerToggle?.height, baseline.openMetrics?.drawerToggle?.height)
  compare('停靠侧栏行高度', optOut.openMetrics?.sidebarTreeitems?.[0]?.height, baseline.openMetrics?.sidebarTreeitems?.[0]?.height)
  compare('面板根 margin-bottom', Number.parseFloat(optOut.metrics.panelMarginBottom ?? '0'), Number.parseFloat(baseline.metrics.panelMarginBottom ?? '0'))
  compare('--dshm-floaters', Number.parseFloat(optOut.metrics.floatersVar || '0') || 0, 0)
  compare('抽屉侧栏按钮高度', optOut.openMetrics?.sidebarButtons?.[0]?.height, baseline.openMetrics?.sidebarButtons?.[0]?.height)
  if (failures.length > 0) {
    report.fail(layer, 'runtime.optOut', `data-dsh-adapt="off" 没有让适配完全失效：${failures.join('；')}`)
  } else {
    report.pass(layer, 'runtime.optOut', 'data-dsh-adapt="off" 时面板与外壳数值全部回落到基线')
  }
}

function checkDesktop(report, baseline, after, strict) {
  const layer = 'runtime'
  const failures = []
  const compare = (label, actual, expected) => {
    // Elements absent from a targeted fixture must be absent on both sides; the
    // built-in fixture always has them, so its behaviour is unchanged.
    const absent = value => value === null || value === undefined
    if (absent(actual) === true && absent(expected) === true) return
    if (absent(actual) === true || absent(expected) === true || near(actual, expected) === false) {
      failures.push(`${label} ${fmt(actual)} ≠ ${fmt(expected)}`)
    }
  }
  compare('按钮高度', after.metrics.button?.height, baseline.metrics.button?.height)
  compare('输入高度', after.metrics.input?.height, baseline.metrics.input?.height)
  compare('面板左缘', after.metrics.panel?.left, baseline.metrics.panel?.left)
  compare('面板右缘', after.metrics.panel?.right, baseline.metrics.panel?.right)
  compare('面板宽度', after.metrics.panel?.width, baseline.metrics.panel?.width)
  compare('scrollWidth', after.metrics.scrollWidth, baseline.metrics.scrollWidth)
  compare('返回栏按钮', after.metrics.panelNavButton?.height, baseline.metrics.panelNavButton?.height)
  compare('抽屉侧栏按钮', after.openMetrics?.sidebarButtons?.[0]?.height, baseline.openMetrics?.sidebarButtons?.[0]?.height)
  compare('折叠轨道按钮高度', after.metrics.railButtons?.[0]?.height, baseline.metrics.railButtons?.[0]?.height)
  compare('折叠轨道按钮宽度', after.metrics.railButtons?.[0]?.width, baseline.metrics.railButtons?.[0]?.width)
  compare('drawerToggle 收起', after.metrics.drawerToggle?.width, baseline.metrics.drawerToggle?.width)
  compare('drawerToggle 展开', after.openMetrics?.drawerToggle?.width, baseline.openMetrics?.drawerToggle?.width)
  compare('停靠侧栏行', after.openMetrics?.sidebarTreeitems?.[0]?.height, baseline.openMetrics?.sidebarTreeitems?.[0]?.height)
  if (failures.length > 0) {
    report.fail(layer, 'runtime.desktop.zero-change', `1280×800 精指针下适配改动了桌面：${failures.join('；')}`)
  } else {
    report.pass(layer, 'runtime.desktop.zero-change', '1280×800 精指针下按钮 / 输入 / 面板几何与基线逐项一致')
  }

  if (strict === true) {
    const strictFailures = []
    if (after.metrics.mainContent?.paddingLeft !== baseline.metrics.mainContent?.paddingLeft) {
      strictFailures.push(`mainContent padding-left ${after.metrics.mainContent?.paddingLeft} ≠ ${baseline.metrics.mainContent?.paddingLeft}`)
    }
    if (after.metrics.mainContent?.marginLeft !== baseline.metrics.mainContent?.marginLeft) {
      strictFailures.push(`mainContent margin-left ${after.metrics.mainContent?.marginLeft} ≠ ${baseline.metrics.mainContent?.marginLeft}`)
    }
    if (after.metrics.mainContent?.overflowX !== baseline.metrics.mainContent?.overflowX) {
      strictFailures.push(`mainContent overflow-x ${after.metrics.mainContent?.overflowX} ≠ ${baseline.metrics.mainContent?.overflowX}`)
    }
    if (after.metrics.mainContent?.overflowY !== baseline.metrics.mainContent?.overflowY) {
      strictFailures.push(`mainContent overflow-y ${after.metrics.mainContent?.overflowY} ≠ ${baseline.metrics.mainContent?.overflowY}`)
    }
    const beforeControls = baseline.metrics.controls
    const afterControls = after.metrics.controls
    if (beforeControls.length !== afterControls.length) {
      strictFailures.push(`控件数量 ${afterControls.length} ≠ ${beforeControls.length}`)
    } else {
      for (let index = 0; index < beforeControls.length; index += 1) {
        const before = beforeControls[index]
        const now = afterControls[index]
        for (const side of ['width', 'height', 'left', 'right']) {
          if (near(now[side], before[side]) === false) {
            strictFailures.push(`第 ${index + 1} 个控件（${before.tag}）${side} ${now[side]} ≠ ${before[side]}`)
          }
        }
      }
    }
    if (strictFailures.length > 0) {
      report.fail(layer, 'runtime.desktop.strict', `--desktop 严格零回归失败：${strictFailures.slice(0, 6).join('；')}`)
    } else {
      report.pass(layer, 'runtime.desktop.strict', '--desktop 严格零回归：mainContent 盒模型与全部控件矩形均未改动')
    }
  }
}

function summarizeControls(controls) {
  return controls
    .slice(0, 4)
    .map(control => `${control.tag}${control.ariaLabel === null ? '' : `[${control.ariaLabel}]`} ${control.width}×${control.height}`)
    .join('、')
}

// ---------------------------------------------------------------- Playwright

/**
 * Playwright is a CommonJS package: `import('…/index.js')` gives a namespace whose
 * `chromium` may live on `default` (Windows/macOS included), while `createRequire`
 * returns the package object directly. Normalise both shapes.
 */
function unwrapPlaywright(moduleValue) {
  if (moduleValue !== null && typeof moduleValue === 'object' && moduleValue.chromium !== undefined) return moduleValue
  const fallback = moduleValue?.default
  if (fallback !== null && typeof fallback === 'object' && fallback.chromium !== undefined) return fallback
  throw new Error('模块没有导出 chromium')
}

/**
 * Resolution order: `DSH_PLAYWRIGHT` (index.js or package directory) →
 * `$DSH_HOME/profiles/{web,desktop,headless}/node_modules` → this repo → module
 * resolution. The failure lists every path tried so a Windows user can see which
 * `DSH_HOME` was used and what to install.
 */
async function loadPlaywright() {
  const tried = []
  const configured = process.env.DSH_PLAYWRIGHT?.trim()
  if (configured !== undefined && configured !== '') {
    const target = onDiskPath(path.resolve(expandHome(configured)))
    tried.push(`DSH_PLAYWRIGHT=${target}`)
    try {
      if (existsSync(target) === true && statSync(target).isDirectory() === true) {
        return unwrapPlaywright(createRequire(path.join(target, 'package.json'))(target))
      }
      return unwrapPlaywright(await import(pathToFileURL(target).href))
    } catch (error) {
      throw new Error([
        `DSH_PLAYWRIGHT 指向的 Playwright 无法加载：${target}`,
        error instanceof Error ? error.message : String(error),
        '它可以指向 playwright 的 index.js，也可以指向 playwright 包目录。',
      ].join('\n'))
    }
  }
  const home = resolveDshHome()
  for (const profile of ['web', 'desktop', 'headless']) {
    const anchor = path.join(home, 'profiles', profile, 'package.json')
    tried.push(anchor)
    if (existsSync(anchor) === false) continue
    try {
      return createRequire(anchor)('playwright')
    } catch {
      // next profile
    }
  }
  const repoAnchor = path.join(REPO, 'package.json')
  tried.push(repoAnchor)
  try {
    return createRequire(repoAnchor)('playwright')
  } catch {
    // fall through to module resolution
  }
  try {
    return await import('playwright')
  } catch {
    // report everything below
  }
  throw new Error([
    'Playwright 未找到：check-pack 需要 Playwright + Chromium 做夹具测量。',
    `DSH_HOME：${home}`,
    '已尝试：',
    ...tried.map(item => `  - ${item}`),
    '安装（在仓库根目录）：',
    '  npm install --no-save --no-package-lock playwright',
    '  npx playwright install chromium',
    WINDOWS ? 'Windows 的浏览器默认下载到 %LOCALAPPDATA%\\ms-playwright。' : 'Linux 的浏览器默认下载到 ~/.cache/ms-playwright。',
    '也可以用 DSH_PLAYWRIGHT 指向已有的 playwright（index.js 或包目录）。',
  ].join('\n'))
}

function describeChromiumLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || (WINDOWS ? '%LOCALAPPDATA%\\ms-playwright' : '~/.cache/ms-playwright')
  return [
    `Chromium 无法启动：${message}`,
    `Playwright 浏览器缓存：${browsersPath}`,
    '请在仓库根目录执行：npx playwright install chromium',
    '离线环境可把 PLAYWRIGHT_BROWSERS_PATH 指向已有的浏览器目录；DSH 自带的 Playwright 通常也自带浏览器。',
  ].join('\n')
}

// ---------------------------------------------------------------- driver

async function checkPack(browser, pathArgument, skip, options) {
  const report = new PackReport(pathArgument.id, pathArgument.path)
  if (skip !== null) {
    report.skip('static', 'pack.skipped', skip)
    return report
  }
  const staticData = inspectStatic(report)
  const fixtureInfo = staticData.fixture
  // A missing or broken manifest still runs the runtime layers, so the author
  // sees every layer in one run instead of one error at a time. A custom fixture
  // that failed the static safety checks is different: never load it (or the
  // pack) at runtime, or a fixture script would bypass the activation shim.
  if (fixtureInfo !== null) await inspectFixtureInBrowser(report, browser, fixtureInfo)
  if (fixtureInfo !== null && fixtureInfo.loadable === false) {
    report.skip('runtime', 'runtime.skipped', '定向 fixture 未通过静态安全检查：跳过全部运行时断言（不加载 fixture 或 pack 脚本）')
    return report
  }

  let baselineMetrics = null
  try {
    const baselineMobile = await runFixture(browser, { device: 'mobile', pack: null, optOut: false, fixture: fixtureInfo })
    const baselineDesktop = await runFixture(browser, { device: 'desktop', pack: null, optOut: false, fixture: fixtureInfo })
    baselineMetrics = {
      mobile: baselineMobile.metrics,
      desktop: baselineDesktop.metrics,
    }
    validateBaseline(report, baselineMobile, 'mobile', fixtureInfo)
    validateBaseline(report, baselineDesktop, 'desktop', fixtureInfo)

    const pack = { css: staticData.css, js: staticData.js === null ? null : staticData.js.source }
    const mobile = await runFixture(browser, {
      device: 'mobile',
      pack,
      optOut: false,
      fixture: fixtureInfo,
      probeHostGate: report.hostGate === true,
    })
    const optOut = await runFixture(browser, { device: 'mobile', pack, optOut: true, fixture: fixtureInfo })
    const desktop = await runFixture(browser, { device: 'desktop', pack, optOut: false, fixture: fixtureInfo })

    report.measurements = {
      mobile: { baseline: baselineMetrics.mobile, pack: mobile.metrics, optOut: optOut.metrics },
      desktop: { baseline: baselineMetrics.desktop, pack: desktop.metrics },
    }
    checkMobileAssertions(report, baselineMobile, mobile, report.id, staticData.js !== null, fixtureInfo)
    if (report.hostGate === true) checkHostGate(report, baselineMetrics.mobile, mobile)
    checkOptOut(report, baselineMobile, optOut)
    checkDesktop(report, baselineDesktop, desktop, options.desktop)
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    report.fail('runtime', 'runtime.error', `实测阶段失败：${error instanceof Error ? error.message : error}`)
  }
  return report
}

function listPackDirectories() {
  if (existsSync(PACKS_DIR) === false) return []
  return readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('_') === false)
    .map(entry => path.join(PACKS_DIR, entry.name))
}

function usage() {
  return [
    '用法：node tools/check-pack.mjs [packs/<id> ...] [--json] [--desktop]',
    '',
    '  packs/<id>   要校验的包目录（可多个；缺省校验 packs/ 下全部非下划线目录）',
    '  packs/<id>/fixture.html  可选：存在时替代内置 fixture（见 docs/定向-fixture.md）',
    '  --json       输出机器可读 JSON（stdout 只有 JSON）',
    '  --desktop    额外断言桌面严格零回归（mainContent 盒模型与全部控件矩形）',
  ].join('\n')
}

function writeHuman(report) {
  const lines = []
  const counts = report.counts()
  lines.push(`pack ${report.relative}（id ${report.id}）`)
  if (report.fixture !== null) {
    lines.push(report.fixture.kind === 'custom'
      ? `fixture：定向 ${report.fixture.path}（${report.fixture.bytes} 字节）`
      : 'fixture：内置（未提供 packs/<id>/fixture.html，回退内置 fixture）')
  }
  const order = ['static', 'runtime']
  for (const layer of order) {
    const entries = report.assertions.filter(entry => entry.layer === layer)
    if (entries.length === 0) continue
    lines.push('')
    lines.push(layer === 'static' ? 'STATIC' : 'RUNTIME')
    for (const entry of entries) {
      const label = entry.status === 'passed' ? 'PASS'
        : entry.status === 'failed' ? 'FAIL'
          : entry.status === 'warning' ? 'WARN'
            : 'SKIP'
      lines.push(`  ${label}  ${entry.message}`)
    }
  }

  const measurements = report.measurements
  if (measurements.mobile !== undefined) {
    lines.push('')
    lines.push('390×844 · coarse pointer')
    lines.push(renderMetricTable([
      ['按钮高度', measurements.mobile.baseline.button?.height, measurements.mobile.pack.button?.height, `≥ ${HIT_TARGET}px`],
      ['图标按钮宽度', measurements.mobile.baseline.iconButton?.width, measurements.mobile.pack.iconButton?.width, `≥ ${HIT_TARGET}px`],
      ['输入高度', measurements.mobile.baseline.input?.height, measurements.mobile.pack.input?.height, `≥ ${HIT_TARGET}px`],
      ['下拉高度', measurements.mobile.baseline.select?.height, measurements.mobile.pack.select?.height, `≥ ${HIT_TARGET}px`],
      ['面板左缘', measurements.mobile.baseline.panel?.left, measurements.mobile.pack.panel?.left, '= 基线'],
      ['面板右缘', measurements.mobile.baseline.panel?.right, measurements.mobile.pack.panel?.right, `≤ 390px`],
    ]))

    lines.push('')
    lines.push('OPT-OUT · 面板根 data-dsh-adapt="off"')
    lines.push(renderMetricTable([
      ['按钮高度', measurements.mobile.baseline.button?.height, measurements.mobile.optOut.button?.height, '= 基线'],
      ['输入高度', measurements.mobile.baseline.input?.height, measurements.mobile.optOut.input?.height, '= 基线'],
      ['面板左缘', measurements.mobile.baseline.panel?.left, measurements.mobile.optOut.panel?.left, '= 基线'],
      ['面板右缘', measurements.mobile.baseline.panel?.right, measurements.mobile.optOut.panel?.right, '= 基线'],
    ]))

    lines.push('')
    lines.push('1280×800 · fine pointer')
    lines.push(renderMetricTable([
      ['按钮高度', measurements.desktop.baseline.button?.height, measurements.desktop.pack.button?.height, '= 基线'],
      ['输入高度', measurements.desktop.baseline.input?.height, measurements.desktop.pack.input?.height, '= 基线'],
      ['面板左缘', measurements.desktop.baseline.panel?.left, measurements.desktop.pack.panel?.left, '= 基线'],
      ['面板右缘', measurements.desktop.baseline.panel?.right, measurements.desktop.pack.panel?.right, '= 基线'],
    ]))
  }

  lines.push('')
  const summary = `${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped${counts.warning === 0 ? '' : ` · ${counts.warning} warning`}`
  lines.push(report.ok ? `RESULT PASS（${summary}）` : `RESULT FAIL（${summary}）`)
  if (report.error !== null) lines.push(report.error)
  return lines.join('\n')
}

function renderMetricTable(rows) {
  const width = value => [...String(value)].reduce((total, character) => total + (character.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
  const padEnd = (value, size) => String(value) + ' '.repeat(Math.max(0, size - width(value)))
  const padStart = (value, size) => ' '.repeat(Math.max(0, size - width(value))) + String(value)
  const header = `${padEnd('  指标', 18)}${padStart('基线', 10)}${padStart('实测', 10)}${padStart('判据', 12)}`
  const body = rows.map(([label, baseline, actual, rule]) => [
    padEnd(`  ${label}`, 18),
    padStart(fmt(baseline), 10),
    padStart(fmt(actual), 10),
    padStart(rule, 12),
  ].join(''))
  return [header, ...body].join('\n')
}

async function main() {
  const reports = []
  let browser = null
  let fatal = null
  try {
    const { chromium } = await loadPlaywright()
    try {
      browser = await chromium.launch({
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
      })
    } catch (error) {
      throw new Error(describeChromiumLaunchFailure(error))
    }
    for (const selection of selected) {
      const report = await checkPack(browser, selection, selection.skip, flags)
      reports.push(report)
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error)
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined)
  }

  if (fatal !== null) {
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify({ tool: 'check-pack', version: 1, ok: false, error: fatal, packs: reports.map(serialize) }, null, 2)}\n`)
    } else {
      console.error(`check-pack 无法运行：${fatal}`)
      console.error('需要 Playwright + Chromium；详见 README 的「Windows」/「Install」段落，或用 DSH_PLAYWRIGHT 指向已安装的 playwright。')
    }
    process.exit(1)
  }

  const ok = reports.every(report => report.ok)
  if (flags.json === true) {
    const payload = {
      tool: 'check-pack',
      version: 1,
      ok,
      generatedAt: new Date().toISOString(),
      flags: { ...flags },
      packs: reports.map(serialize),
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    for (const report of reports) {
      console.log(writeHuman(report))
      console.log('')
    }
    const counts = reports.reduce((total, report) => {
      const current = report.counts()
      return {
        passed: total.passed + current.passed,
        failed: total.failed + current.failed,
        skipped: total.skipped + current.skipped,
        warning: total.warning + current.warning,
      }
    }, { passed: 0, failed: 0, skipped: 0, warning: 0 })
    console.log(`check-pack · ${reports.length} pack(s) · ${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped${counts.warning === 0 ? '' : ` · ${counts.warning} warning`}`)
  }
  process.exit(ok ? 0 : 1)
}

function serialize(report) {
  return {
    id: report.id,
    path: report.relative,
    fixture: report.fixture,
    ok: report.ok,
    error: report.error,
    counts: report.counts(),
    assertions: report.assertions,
    measurements: report.measurements,
  }
}

await main()
