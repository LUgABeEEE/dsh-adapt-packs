/**
 * dsh-device-verify · in-page overlay (v2), diagnostic only.
 *
 * Injected by run.mjs as <DSH_HOME>/mobile-access/mobile.js (with a generated
 * `window.__dvConfig` block and overlay-lib.js in front of it) and restored by
 * `run.mjs overlay off`. It drives the real mobile page from inside — expanding
 * the drawer, opening each configured panel, waiting for the main slot to settle
 * instead of sleeping, measuring touch sizes / hit-testing / floating-widget
 * state with and without `html[data-dsh-adapt="off"]` — then publishes one JSON
 * report through four channels:
 *
 *   1. window.__dvReport            (for a browser console / this tool's smoke run)
 *   2. document.title = "DVJSON:…"  (small, greppable, readable by run.mjs/smoke)
 *   3. a selectable <textarea> + Copy button in the panel (on-device fallback)
 *   4. POST to window.__dvConfig.sinkUrl (run.mjs `report`; needs adb reverse)
 *
 * plus localStorage["dsh-device-verify:last"] as a last resort.
 *
 * No data leaves the page except the optional POST to the local sink. Nothing
 * here simulates a pass: every number is measured, every failure carries a
 * reason code from overlay-lib.js REASONS.
 */
(function () {
  'use strict'

  const PANEL_ID = 'dsh-verify-overlay'
  const LINES_ID = 'dsh-verify-lines'
  const JSON_ID = 'dsh-verify-json'
  const COPY_ID = 'dsh-verify-copy'
  const CONTROL_SELECTOR = ':is(button, [role="button"], input, select, textarea)'
  const PROBES = [[0, 0, 'center'], [20, 0, 'right'], [-20, 0, 'left'], [0, 20, 'bottom'], [0, -20, 'top']]
  const STORAGE_KEY = 'dsh-device-verify:last'
  const TITLE_FLAG = '[dsh-verify]'

  boot()

  function boot() {
    const LIB = window.DshVerifyLib
    if (LIB === undefined) {
      window.__dvError = 'overlay-lib.js missing: the injected mobile.js is incomplete'
      console.error(`${TITLE_FLAG} ${window.__dvError}`)
      return
    }
    if (document.getElementById(PANEL_ID) !== null) return
    const session = createSession(LIB, LIB.normalizeConfig(window.__dvConfig))
    window.__dshVerify = session
    window.__dvRun = () => session.pilot()
    window.__dvSnapshot = label => session.markState(label)
    window.__dvHide = () => session.setHidden(true)
    window.__dvShow = () => session.setHidden(false)
    session.start()
  }

  /**
   * @param {object} LIB window.DshVerifyLib
   * @param {object} config normalized config
   */
  function createSession(LIB, config) {
    const startedAt = Date.now()
    const startedIso = new Date(startedAt).toISOString()

    const state = {
      config,
      phase: 'booting',
      started: false,
      piloting: false,
      aborted: null,
      cleanup: null,
      degraded: null,
      currentScenario: null,
      initialOptOut: undefined,
      scenarios: [],
      states: [],
      keyboard: null,
      keyboardProbe: null,
      keyboardBaseline: null,
      baselineByOrientation: {},
      viewportEvents: [],
      lastViewport: null,
      editableFocused: false,
      rotation: null,
      env: {},
      report: null,
      export: { title: 'pending', bytes: 0, truncated: false, sink: 'pending', logcat: null, logcatSignature: null, at: null },
    }

    let hidden = false
    let pendingTrigger = 'resize'
    let sinkTimer = null
    let resizeTimer = null
    let panelEl = null
    let linesEl = null
    let jsonEl = null

    function ready() {
      return document.body !== null
    }

    function delay(milliseconds) {
      return new Promise(resolve => window.setTimeout(resolve, milliseconds))
    }

    // ---------------------------------------------------------------- measure

    function isVisible(node) {
      if (node === null || node.isConnected !== true) return false
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const box = node.getBoundingClientRect()
      return box.width > 0.5 || box.height > 0.5
    }

    function safeArea() {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);'
      document.body.append(probe)
      const style = window.getComputedStyle(probe)
      const values = ['Top', 'Right', 'Bottom', 'Left'].map(side => Math.round(parseFloat(style[`padding${side}`]) || 0))
      probe.remove()
      return values
    }

    /** @returns {object} control sizes for `root`, plus hit-test misses */
    function measureTouch(root, options) {
      const limit = Number.isFinite(options?.hitCheckLimit) ? options.hitCheckLimit : config.hitCheckLimit
      const empty = { count: 0, min: null, under44: null, checked: 0, miss: 0, samples: [], sizes: [], truncated: false, hitSkipped: true, floor: LIB.TOUCH_FLOOR_PX }
      if (root === null) return empty
      const nodes = [...root.querySelectorAll(CONTROL_SELECTOR)]
      const sizes = []
      const samples = []
      let checked = 0
      let probed = 0
      let miss = 0
      const width = window.innerWidth
      const height = window.innerHeight
      for (const node of nodes) {
        if (isVisible(node) === false) continue
        const box = node.getBoundingClientRect()
        sizes.push(Math.round(Math.min(box.width, box.height) * 10) / 10)
        checked += 1
        if (probed >= limit) continue
        probed += 1
        const centreX = box.left + box.width / 2
        const centreY = box.top + box.height / 2
        let hit = 0
        let local = 0
        const misses = []
        for (const [dx, dy, point] of PROBES) {
          const x = centreX + dx
          const y = centreY + dy
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          local += 1
          const element = document.elementFromPoint(x, y)
          const inside = element !== null && (element === node || node.contains(element))
          if (inside) hit += 1
          else if (misses.length < 5) misses.push({ point, x, y, by: element === null ? null : describeBlocker(element) })
        }
        if (local < 3 || hit === local) continue
        miss += 1
        if (samples.length < 6) {
          samples.push(LIB.hitSample({
            tag: node.tagName.toLowerCase(),
            width: box.width,
            height: box.height,
            hit,
            probed: local,
            misses,
          }))
        }
      }
      const stats = LIB.classifySizes(sizes)
      return { ...stats, checked, miss, samples, sizes, truncated: probed < checked, hitSkipped: probed === 0 }
    }

    function floaters() {
      const attribute = document.documentElement.getAttribute('data-dsh-floaters')
      let computed = ''
      try { computed = window.getComputedStyle(document.documentElement).getPropertyValue('--dshm-floaters').trim() } catch { computed = '' }
      return { raw: computed, attr: attribute, applied: attribute === '1' }
    }

    function panelInfo() {
      const main = document.querySelector('.dshm-main')
      const nav = document.querySelector('.dshm-panelNav')
      const attr = main === null ? null : main.getAttribute('data-dsh-panel')
      const open = nav !== null || (attr !== null && attr !== '0') || (attr === null && document.querySelector('[data-slot="main"] [data-dshm-adapt-panel]') !== null)
      return { id: attr, open, nav: nav !== null, adaptPanel: main === null ? null : main.getAttribute('data-dshm-adapt-panel') }
    }

    function drawerInfo() {
      const drawer = document.querySelector('.dshm-drawer')
      if (drawer === null) return { present: false, open: false }
      return { present: true, open: drawer.getAttribute('data-open') === 'true', collapsed: drawer.hasAttribute('data-sidebar-collapsed') }
    }

    function chromeMetrics() {
      const nav = [...document.querySelectorAll('.dshm-panelNav :is(button, [role="button"])')].map(node => Math.round(node.getBoundingClientRect().height))
      const drawer = document.querySelector('.dshm-drawer[data-open="true"] [data-slot="sidebar"]')
      const rows = drawer === null
        ? []
        : [...drawer.querySelectorAll('button, [role="button"], a')]
          .map(node => Math.round(node.getBoundingClientRect().height))
          .filter(height => height > 0)
      return { nav, rows }
    }

    function overflowOf() {
      const root = document.documentElement
      return { overflow: root.scrollWidth > root.clientWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
    }

    function snapshot(phase, options) {
      const main = document.querySelector('[data-slot="main"]')
      const market = document.querySelector('[data-dsh-market-root]')
      const viewport = window.visualViewport
      const scroll = overflowOf()
      return {
        phase,
        at: new Date().toISOString(),
        inner: { width: window.innerWidth, height: window.innerHeight },
        visual: viewport === null ? null : { width: Math.round(viewport.width), height: Math.round(viewport.height) },
        dpr: window.devicePixelRatio,
        safe: safeArea(),
        shell: document.querySelector('.dshm-shell') !== null,
        panel: panelInfo(),
        drawer: drawerInfo(),
        optOut: document.documentElement.getAttribute('data-dsh-adapt'),
        touch: measureTouch(main, options?.hit === false ? { hitCheckLimit: 0 } : undefined),
        market: market === null ? null : measureTouch(market, options?.hit === false ? { hitCheckLimit: 0 } : undefined),
        chrome: chromeMetrics(),
        floaters: floaters(),
        overflow: scroll.overflow,
        scroll,
      }
    }

    /** Short, human-readable identity for whatever covered a control. */
    function describeBlocker(node) {
      if (node === null) return 'none'
      const tag = node.tagName.toLowerCase()
      const id = node.id === '' ? '' : `#${node.id}`
      const classes = [...node.classList].slice(0, 2).map(name => `.${name}`).join('')
      const slot = node.getAttribute?.('data-slot') === null ? '' : `[data-slot=${node.getAttribute('data-slot')}]`
      return `${tag}${id}${classes}${slot}`
    }

    function describeTarget(node) {
      if (node === null) return null
      const label = node.getAttribute?.('aria-label') ?? node.textContent?.trim() ?? ''
      return `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`} ${label.slice(0, 40)}`.trim()
    }

    // ------------------------------------------------------------------ state

    function liveViewport() {
      const viewport = window.visualViewport
      return {
        inner: { width: window.innerWidth, height: window.innerHeight },
        visual: viewport === null ? { width: null, height: null } : { width: Math.round(viewport.width), height: Math.round(viewport.height) },
        scale: viewport === null ? null : viewport.scale,
        orientation: LIB.orientationOf({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }),
        editableFocused: state.editableFocused === true,
      }
    }

    /**
     * Baseline = the tallest viewport seen in the current orientation. This makes
     * the keyboard delta independent of *when* the finger opened it, and keeps
     * rotation from being reported as a keyboard (each orientation has its own
     * baseline).
     */
    function updateBaseline(current) {
      const key = current.orientation
      const stored = state.baselineByOrientation[key]
      const taller = stored === undefined || current.inner.height > stored.inner.height
      if (taller) state.baselineByOrientation[key] = { inner: current.inner, visual: current.visual }
      state.keyboardBaseline = state.baselineByOrientation[current.orientation] ?? { inner: current.inner, visual: current.visual }
      return state.keyboardBaseline
    }

    /** The keyboard block is recomputed from the live viewport on every publish. */
    function currentKeyboardReport() {
      const current = liveViewport()
      const baseline = updateBaseline(current)
      const report = LIB.keyboardReport({
        current,
        baseline: { inner: baseline.inner, visual: baseline.visual },
        baselineOrientation: current.orientation,
        currentOrientation: current.orientation,
        editableFocused: current.editableFocused,
        threshold: config.keyboardThreshold === undefined ? 80 : config.keyboardThreshold,
        scale: current.scale,
        at: new Date().toISOString(),
      })
      const probe = state.keyboardProbe
      return {
        ...report,
        // The programmatic focus() probe never raises the IME; keep it as
        // diagnostics, never as the verdict.
        probe: probe === null ? null : { target: probe.target ?? null, focused: probe.focused === true, reason: probe.reason ?? null },
        lastEvent: state.viewportEvents.length === 0 ? null : state.viewportEvents[state.viewportEvents.length - 1],
      }
    }

    function recordViewportEvent(trigger) {
      if (ready() === false) return null
      const current = liveViewport()
      const previous = state.lastViewport
      if (previous !== null && previous.inner.height === current.inner.height && previous.inner.width === current.inner.width
        && previous.visual.height === current.visual.height && previous.visual.width === current.visual.width) {
        return null
      }
      const change = LIB.classifyViewportChange(previous, current, {
        threshold: config.keyboardThreshold === undefined ? 80 : config.keyboardThreshold,
        editableFocused: current.editableFocused,
        scale: current.scale,
      })
      const event = {
        at: new Date().toISOString(),
        phase: state.phase,
        trigger,
        source: previous === null ? 'initial' : change.source,
        inner: current.inner,
        visual: current.visual,
        deltaInner: previous === null ? null : change.deltaInner,
        deltaVisual: previous === null ? null : change.deltaVisual,
        orientation: current.orientation,
        editableFocused: current.editableFocused,
      }
      state.viewportEvents.push(event)
      if (state.viewportEvents.length > config.maxViewportEvents) state.viewportEvents.shift()
      state.lastViewport = { inner: current.inner, visual: current.visual }
      updateBaseline(current)
      console.info(`${TITLE_FLAG} viewport ${event.source} ${current.inner.width}x${current.inner.height} Δ${event.deltaInner ?? '?'} (${trigger})`)
      return event
    }

    function readEnv() {
      const viewport = window.visualViewport
      const scroll = overflowOf()
      return {
        url: `${window.location.origin}${window.location.pathname}`,
        ua: navigator.userAgent,
        dpr: window.devicePixelRatio,
        screen: { width: window.screen.width, height: window.screen.height },
        inner: { width: window.innerWidth, height: window.innerHeight },
        visual: viewport === null ? null : { width: Math.round(viewport.width), height: Math.round(viewport.height) },
        safe: safeArea(),
        shell: document.querySelector('.dshm-shell') !== null,
        orientation: LIB.orientationOf({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }),
        overflow: scroll.overflow,
        floaters: floaters().attr,
      }
    }

    function pushState(phase) {
      // States only need viewport/floaters/panel, so skip the hit probes here:
      // they cost ~5 elementFromPoint calls per control and are not reported.
      const snap = snapshot(phase, { hit: false })
      const entry = {
        at: snap.at,
        phase,
        inner: snap.inner,
        visual: snap.visual ?? { width: null, height: null },
        floaters: snap.floaters,
        panel: { id: snap.panel.id, open: snap.panel.open },
        overflow: snap.overflow,
        keyboard: window.innerHeight < (state.keyboardBaseline?.inner?.height ?? Number.POSITIVE_INFINITY) - 80,
      }
      const signature = LIB.stateSignature(entry)
      const previous = state.states[state.states.length - 1]
      if (previous !== undefined && LIB.stateSignature(previous) === signature) return entry
      entry.__signature = signature
      state.states.push(entry)
      if (state.states.length > config.maxStates) state.states.shift()
      return entry
    }

    // ----------------------------------------------------------------- export

    function buildReport(aborted) {
      return LIB.buildReport({
        at: startedIso,
        durationMs: Date.now() - startedAt,
        started: state.started,
        aborted: aborted === undefined ? state.aborted : aborted,
        cleanup: state.cleanup,
        env: state.env,
        keyboard: currentKeyboardReport(),
        viewportEvents: state.viewportEvents,
        rotation: state.rotation ?? rotationInfo(),
        states: state.states,
        scenarios: state.scenarios,
        config: {
          version: config.version,
          timeoutMs: config.timeoutMs,
          pollIntervalMs: config.pollIntervalMs,
          settlePolls: config.settlePolls,
          keyboardProbe: config.keyboardProbe,
          sink: config.sinkUrl === null ? 'off' : 'on',
          dropped: config.dropped,
          scenarios: config.scenarios.map(item => ({ name: item.name, panel: item.panel, labels: item.labels, optional: item.optional })),
        },
      })
    }

    function publish() {
      if (ready() === false) return null
      const report = buildReport()
      state.report = report
      window.__dvReport = report

      const encoded = LIB.encodeTitle(report, config.titleMaxChars)
      state.export = {
        title: encoded.truncated ? 'truncated' : 'full',
        bytes: encoded.bytes,
        truncated: encoded.truncated,
        sink: config.sinkUrl === null ? 'disabled' : (state.export.sink === 'pending' ? 'pending' : state.export.sink),
        at: new Date().toISOString(),
      }
      try { document.title = encoded.title } catch { state.export.title = 'blocked' }

      writeJsonField(JSON.stringify(report, null, 2))
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(report)) } catch { /* private mode */ }

      scheduleSink()
      exportLogcat(report)
      render()
      return report
    }

    /**
     * Android WebView forwards console output to logcat, which `adb logcat` can
     * read without adb reverse, USB tethering or devtools. The report goes out as
     * base64 in fixed-size chunks so no line is split and no non-ASCII byte is
     * mangled by the log writer.
     */
    function exportLogcat(report) {
      if (config.exportLogcat !== true) return
      const json = JSON.stringify(report)
      const signature = `${json.length}:${report.states.length}`
      if (state.export.logcatSignature === signature) return
      state.export.logcatSignature = signature
      try {
        const encoded = base64Utf8(json)
        const chunks = encoded.match(/.{1,900}/gu) ?? []
        console.info(`${TITLE_FLAG} REPORT-BEGIN ${chunks.length} ${json.length}`)
        chunks.forEach((chunk, index) => console.info(`${TITLE_FLAG} REPORT ${index} ${chunk}`))
        console.info(`${TITLE_FLAG} REPORT-END`)
        state.export.logcat = 'sent'
      } catch (error) {
        state.export.logcat = 'failed'
        console.info(`${TITLE_FLAG} logcat export failed: ${String(error && error.message ? error.message : error)}`)
      }
    }

    function base64Utf8(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary)
    }

    function sinkBody(report) {
      return JSON.stringify(report)
    }

    async function postToSink(report) {
      const url = config.sinkUrl
      if (url === null) return
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : window.setTimeout(() => controller.abort(), 4000)
      try {
        const response = await fetch(url, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: sinkBody(report),
          signal: controller === null ? undefined : controller.signal,
        })
        state.export.sink = response.ok ? `ok:${response.status}` : `failed:${response.status}`
      } catch (error) {
        state.export.sink = 'failed:fetch'
        console.info(`${TITLE_FLAG} sink failed: ${String(error && error.message ? error.message : error)}`)
      } finally {
        if (timer !== null) window.clearTimeout(timer)
      }
      render()
    }

    function scheduleSink() {
      if (config.sinkUrl === null || sinkTimer !== null) return
      sinkTimer = window.setTimeout(() => {
        sinkTimer = null
        const report = state.report ?? buildReport()
        void postToSink(report)
      }, 1000)
    }

    // -------------------------------------------------------------------- ui

    function ensurePanel() {
      if (panelEl !== null && panelEl.isConnected) return panelEl
      panelEl = document.createElement('div')
      panelEl.id = PANEL_ID
      panelEl.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'left:0', 'right:0', 'top:0',
        'margin:0', 'padding:6px 8px', 'background:rgb(5 46 22 / 94%)', 'color:#86efac',
        'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace', 'white-space:pre-wrap',
        'pointer-events:none', 'box-shadow:0 2px 10px rgb(0 0 0 / 45%)',
        'max-height:52vh', 'overflow:auto', '-webkit-user-select:text', 'user-select:text',
        'overscroll-behavior:contain',
      ].join(';')

      linesEl = document.createElement('pre')
      linesEl.id = LINES_ID
      linesEl.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;'
      panelEl.append(linesEl)

      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0 2px;pointer-events:auto;'
      const copy = document.createElement('button')
      copy.id = COPY_ID
      copy.type = 'button'
      copy.textContent = 'Copy JSON'
      copy.style.cssText = 'font:10px/1.2 ui-monospace,monospace;padding:3px 8px;border:1px solid #16a34a;border-radius:4px;background:#052e16;color:#86efac;pointer-events:auto;'
      copy.addEventListener('click', () => { void copyReport() })
      const hide = document.createElement('button')
      hide.type = 'button'
      hide.textContent = 'Hide'
      hide.style.cssText = copy.style.cssText
      hide.addEventListener('click', () => setHidden(true))
      const label = document.createElement('span')
      label.textContent = 'report JSON ↓ (selectable)'
      label.style.cssText = 'font:10px/1.2 ui-monospace,monospace;color:#4ade80;'
      row.append(copy, hide, label)
      panelEl.append(row)

      jsonEl = document.createElement('textarea')
      jsonEl.id = JSON_ID
      jsonEl.readOnly = true
      jsonEl.spellcheck = false
      jsonEl.value = ''
      jsonEl.style.cssText = [
        'box-sizing:border-box', 'width:100%', 'height:64px', 'margin:0', 'padding:4px',
        'background:#02170c', 'color:#4ade80', 'border:1px solid #14532d', 'border-radius:3px',
        'font:10px/1.25 ui-monospace,monospace', 'pointer-events:auto',
        '-webkit-user-select:text', 'user-select:text', 'resize:vertical',
      ].join(';')
      panelEl.append(jsonEl)

      document.body.append(panelEl)
      panelEl.style.display = hidden ? 'none' : 'block'
      return panelEl
    }

    function writeJsonField(text) {
      if (jsonEl === null || jsonEl.value === text) return
      jsonEl.value = text
    }

    async function copyReport() {
      const text = JSON.stringify(state.report ?? buildReport(), null, 2)
      try {
        if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
        } else {
          jsonEl.focus()
          jsonEl.select()
          document.execCommand('copy')
        }
        if (jsonEl !== null) {
          jsonEl.focus()
          jsonEl.select()
        }
        console.info(`${TITLE_FLAG} report copied (${text.length}B)`)
      } catch (error) {
        console.info(`${TITLE_FLAG} copy failed: ${String(error && error.message ? error.message : error)}`)
        if (jsonEl !== null) { jsonEl.focus(); jsonEl.select() }
      }
      render()
    }

    function setHidden(value) {
      hidden = value === true
      if (panelEl !== null) panelEl.style.display = hidden ? 'none' : 'block'
      render()
    }

    function render() {
      if (ready() === false) return
      ensurePanel()
      const info = panelInfo()
      const drawer = drawerInfo()
      const scroll = overflowOf()
      const lines = [
        `DV${LIB.VERSION} ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} vv=${window.visualViewport === null ? 'n/a' : `${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)}`} safe=${safeArea().join(',')}`,
        `phase=${state.phase} shell=${document.querySelector('.dshm-shell') !== null ? 1 : 0} drawer=${drawer.present ? (drawer.open ? 'open' : 'rail') : 'none'} panel=${info.id ?? '-'}/${info.open ? 'open' : 'closed'} off=${document.documentElement.getAttribute('data-dsh-adapt') ?? '-'} ovf=${scroll.overflow ? 1 : 0}`,
      ]
      if (state.scenarios.length === 0 && state.piloting === false) lines.push('scenarios: none yet — waiting for pilot')
      for (const scenario of state.scenarios) {
        const flag = scenario.status === 'ok' ? 'ok  ' : (scenario.status === 'skipped' ? 'skip' : 'FAIL')
        const optOut = scenario.optOut?.changed === true ? `<44=${scenario.optOut.touch.under44}` : 'no-change'
        lines.push(
          `${flag} ${scenario.name}: n=${scenario.touch.count} min=${scenario.touch.min} <44=${scenario.touch.under44} ` +
          `hit=${scenario.touch.checked - scenario.touch.miss}/${scenario.touch.checked} opt=${optOut} flo=${scenario.floaters?.attr ?? '-'} ovf=${scenario.overflow === true ? 1 : 0} close=${scenario.detail?.close?.strategy ?? '-'} ${scenario.ms ?? '-'}ms`,
        )
        if (scenario.reason !== null) lines.push(`     ↳ ${LIB.describeReason(scenario.reason)}`)
        if (scenario.detail?.label !== undefined && scenario.status !== 'ok') lines.push(`     ↳ clicked ${scenario.detail.label}`)
      }
      {
        const live = currentKeyboardReport()
        lines.push(`keyboard open=${live.open} inner=${live.baseline?.inner ?? '?'}→${live.current?.inner ?? '?'} Δ${live.innerDelta ?? '?'} vv=${live.baseline?.visual ?? '?'}→${live.current?.visual ?? '?'} source=${live.source ?? '?'} ev=${state.viewportEvents.length}${live.probe?.reason === null || live.probe?.reason === undefined ? '' : ` probe=${live.probe.reason}`}`)
      }
      if (state.cleanup !== null) {
        const steps = state.cleanup.attempted.map(step => `${step.step}:${step.ok ? 'ok' : 'fail'}${step.strategy === null || step.strategy === undefined ? '' : `/${step.strategy}`}`).join(' ')
        lines.push(`cleanup ok=${state.cleanup.ok} panelOpen=${state.cleanup.panelOpen === true} ${steps}`)
      }
      lines.push(`export title=${state.export.title} ${state.export.bytes}B sink=${state.export.sink} logcat=${state.export.logcat ?? 'off'}${state.aborted === null ? '' : ` ABORT=${state.aborted.reason}`}`)
      if (String(state.export.sink).startsWith('failed') === true) {
        lines.push('hint: 真机取数用截图（sink 需 HTTPS/同源端点；logcat 取决于 App 是否转发 console）')
      }
      linesEl.textContent = lines.join('\n')
      writeJsonField(JSON.stringify(state.report ?? buildReport(), null, 2))
    }

    // ----------------------------------------------------------------- pilot

    async function waitForShell() {
      return LIB.waitFor(
        () => {
          if (ready() === false) return 'no-body'
          const shell = document.querySelector('.dshm-shell')
          const main = document.querySelector('[data-slot="main"]')
          if (shell === null) return 'no-shell'
          if (main === null) return 'no-main'
          return 'ready'
        },
        {
          accept: value => value === 'ready',
          timeoutMs: Math.max(config.timeoutMs, 15_000),
          intervalMs: config.pollIntervalMs,
          reason: 'page-not-loaded',
        },
      )
    }

    function sidebarScope() {
      return document.querySelector('[data-slot="sidebar"]') ?? document.querySelector('.dshm-drawer')
    }

    function labelOf(node) {
      const aria = node.getAttribute('aria-label')
      if (aria !== null && aria.trim() !== '') return aria.trim()
      const title = node.getAttribute('title')
      if (title !== null && title.trim() !== '') return title.trim()
      if (node.children.length === 0) return (node.textContent ?? '').trim()
      return ''
    }

    function clickableAncestor(node, scope) {
      let current = node
      while (current !== null && current !== scope) {
        if (current.matches('button, [role="button"], a, [tabindex], [data-panel], li')) return current
        current = current.parentElement
      }
      return node
    }

    function findSidebarControl(labels) {
      const scope = sidebarScope()
      if (scope === null) return null
      const wanted = labels.map(item => item.toLowerCase())
      const nodes = [...scope.querySelectorAll('*')]
      // 1. exact aria-label / title / leaf text
      for (const node of nodes) {
        const label = labelOf(node)
        if (label === '') continue
        if (labels.includes(label)) return { node: clickableAncestor(node, scope), matched: 'label', label }
      }
      // 2. case-insensitive fallback (locale casing drift)
      for (const node of nodes) {
        const label = labelOf(node)
        if (label === '') continue
        if (wanted.includes(label.toLowerCase())) return { node: clickableAncestor(node, scope), matched: 'label-ci', label }
      }
      return null
    }

    function drawerToggleCandidates() {
      const scope = document.querySelector('.dshm-drawer') ?? document.body
      const nodes = [...scope.querySelectorAll('button, [role="button"], a, [tabindex]')]
      const matcher = /expand|collapse|sidebar|navigation|展开|收起|侧栏|侧边/u
      const out = []
      for (const node of nodes) {
        const text = `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`.trim()
        if (text === '' || matcher.test(text) === false) continue
        if (out.some(item => item.node === node)) continue
        out.push({ node, label: text })
      }
      return out
    }

    function findDrawerToggle() {
      const [first] = drawerToggleCandidates()
      return first === undefined ? null : first
    }

    function scrim() {
      const node = document.querySelector('.dshm-scrim[data-open="true"]')
      return node === null ? null : node
    }

    async function ensureDrawerOpen() {
      const first = drawerInfo()
      if (first.present === false) return { ok: true, changed: false, note: 'no-drawer' }
      if (first.open === true) return { ok: true, changed: false }
      const candidates = drawerToggleCandidates()
      if (candidates.length === 0) return { ok: false, reason: 'sidebar-unreachable', attempts: [], drawer: first }
      // Try every plausible toggle: just after a panel closes the drawer can be
      // mid-animation and the first candidate may be the wrong control.
      const attempts = []
      for (const candidate of candidates.slice(0, 3)) {
        try {
          candidate.node.click()
        } catch (error) {
          attempts.push({ toggle: candidate.label, ok: false, error: String(error && error.message ? error.message : error) })
          continue
        }
        const poll = await LIB.waitFor(() => drawerInfo().open === true, {
          accept: value => value === true,
          timeoutMs: 1800,
          intervalMs: 100,
          reason: 'sidebar-unreachable',
        })
        attempts.push({ toggle: candidate.label, ok: poll.ok, waitedMs: poll.waitedMs })
        if (poll.ok === true) return { ok: true, changed: true, toggle: candidate.label, attempts }
      }
      return { ok: false, reason: 'sidebar-unreachable', attempts, drawer: drawerInfo() }
    }

    async function ensureDrawerClosed() {
      if (drawerInfo().open === false) return { ok: true, changed: false }
      const dismiss = scrim()
      if (dismiss !== null) dismiss.click()
      else {
        const toggle = findDrawerToggle()
        if (toggle !== null) toggle.node.click()
      }
      const poll = await LIB.waitFor(() => drawerInfo().open === false, { accept: value => value === true, timeoutMs: 4000, intervalMs: 100, reason: 'sidebar-unreachable' })
      return poll.ok ? { ok: true, changed: true } : { ok: false, reason: 'sidebar-unreachable' }
    }

    function backButton() {
      const direct = document.querySelector('.dshm-panelNav .dshm-panelBack')
      if (direct !== null) return direct
      return document.querySelector('.dshm-panelNav :is(button, [role="button"])')
    }

    /**
     * The shell closes a main panel from this DOM event (0.8.1
     * `lib/mobile-layout.js`: `window.addEventListener("dsh-mobile:native-back",
     * onNativeBack)`, which calls `selectPanel(null)`). At >=900px there is no
     * `.dshm-panelNav`, so this is the only in-page path that works on tablets.
     */
    function dispatchNativeBack() {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return true
    }

    function dispatchKey(key) {
      for (const target of [document, window]) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }))
        target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }))
      }
      return true
    }

    /**
     * Sidebar entries to try when there is no scenario at hand (cleanup runs
     * after `state.currentScenario = null`): every configured scenario label, so
     * the toggle strategy still has something to click.
     */
    function fallbackEntry() {
      const labels = LIB.scenarioEntryLabels(config.scenarios, 12)
      const found = findSidebarControl(labels)
      if (found !== null) return found
      // Last resort: the first element in the sidebar that looks like a row.
      const scope = sidebarScope()
      if (scope === null) return null
      const node = [...scope.querySelectorAll('[aria-label], button, [role="button"], a, [tabindex]')]
        .find(candidate => (candidate.getAttribute?.('aria-label') ?? '').trim() !== '')
      return node === undefined ? null : { node, matched: 'fallback', label: describeTarget(node) }
    }

    /** @returns {Array<{name: string, run: () => boolean}>} */
    function closeStrategies(scenario) {
      // `scenario` may be null (cleanup after the pilot loop). Never read
      // `scenario.labels` directly — that was the F1 crash.
      const labels = LIB.scenarioLabels(scenario)
      const current = labels.length > 0 ? findSidebarControl(labels) : fallbackEntry()
      const names = LIB.planClose({
        hasPanelNav: document.querySelector('.dshm-panelNav') !== null,
        panelNavDisabled: backButton()?.disabled === true,
        hasSidebarEntry: current !== null,
        allowHistoryBack: config.allowHistoryBack !== false,
        historyLength: window.history.length,
      })
      const runners = {
        'panelNav-back': () => {
          const back = backButton()
          if (back === null || back.disabled === true) return false
          back.click()
          return true
        },
        'native-back-event': () => dispatchNativeBack(),
        'sidebar-toggle': () => {
          const found = labels.length > 0 ? findSidebarControl(labels) : fallbackEntry()
          if (found === null) return false
          found.node.click()
          return true
        },
        'escape-key': () => dispatchKey('Escape'),
        'history-back': () => {
          if (window.history.length <= 1) return false
          window.history.back()
          return true
        },
      }
      return names.map(name => ({ name, run: runners[name] }))
    }

    async function closePanel(scenario) {
      if (panelInfo().open === false) return { ok: true, alreadyClosed: true, strategy: 'none', attempts: [] }
      // The back control is `disabled` while the drawer is open (0.8.x shell).
      if (drawerInfo().open === true) await ensureDrawerClosed()
      const attempts = []
      for (const strategy of closeStrategies(scenario)) {
        let started = true
        try {
          started = strategy.run() !== false
        } catch (error) {
          attempts.push({ name: strategy.name, ok: false, error: String(error && error.message ? error.message : error) })
          continue
        }
        if (started === false) {
          attempts.push({ name: strategy.name, ok: false, error: 'not-available' })
          continue
        }
        const poll = await LIB.waitFor(() => panelInfo().open === false, {
          accept: value => value === true,
          timeoutMs: config.closeTimeoutMs,
          intervalMs: 100,
          reason: 'panel-not-closeable',
        })
        attempts.push({ name: strategy.name, ok: poll.ok, waitedMs: poll.waitedMs })
        if (poll.ok === true) {
          console.info(`${TITLE_FLAG} closed with ${strategy.name}`)
          if (drawerInfo().open === true) await ensureDrawerClosed()
          return { ok: true, strategy: strategy.name, attempts }
        }
      }
      return { ok: false, strategy: null, attempts }
    }

    /**
     * Best-effort recovery after a failed/aborted run: close whatever panel is
     * open, collapse the drawer we opened, and put `data-dsh-adapt` back.
     * Recorded as `report.cleanup` so the next run starts from a known state.
     */
    async function cleanup(cause) {
      const result = {
        ok: false,
        cause: cause ?? null,
        panelOpen: panelInfo().open,
        drawerOpen: drawerInfo().open,
        optOutRestored: true,
        attempted: [],
      }
      try {
        const initial = state.initialOptOut ?? null
        const current = document.documentElement.getAttribute('data-dsh-adapt')
        if (current !== initial) {
          if (initial === null) document.documentElement.removeAttribute('data-dsh-adapt')
          else document.documentElement.setAttribute('data-dsh-adapt', initial)
        }
        result.optOutRestored = (document.documentElement.getAttribute('data-dsh-adapt') ?? null) === initial
      } catch (error) {
        result.optOutRestored = false
        result.attempted.push({ step: 'restore-opt-out', ok: false, error: String(error && error.message ? error.message : error) })
      }
      if (panelInfo().open === true) {
        const closing = await closePanel(state.currentScenario)
        result.attempted.push({ step: 'close-panel', ok: closing.ok, strategy: closing.strategy, attempts: closing.attempts })
      }
      if (drawerInfo().open === true) {
        const drawer = await ensureDrawerClosed()
        result.attempted.push({ step: 'close-drawer', ok: drawer.ok })
      }
      result.panelOpen = panelInfo().open
      result.drawerOpen = drawerInfo().open
      result.ok = result.panelOpen === false && result.optOutRestored === true
      state.cleanup = result
      return result
    }

    function mainRoot() {
      return document.querySelector('[data-slot="main"]')
    }

    /**
     * Wait for the panel content to stop changing, then confirm it after a short
     * pause. Plugin panels load their data asynchronously: a skeleton can look
     * "stable" for a second and then be replaced by the real list (measured on
     * the Pad 9 Pro Max: the same panel produced n=7 and n=94 in two runs).
     */
    async function settleMainRoot() {
      // Text length is part of the signature: a skeleton → content swap changes
      // the text long before the control count moves. Drawer row heights are too
      // (F4: a half-rendered drawer produced 60 vs 67 rows across runs).
      const signature = () => {
        const root = mainRoot()
        const drawer = drawerInfo()
        const extra = drawer.open ? `d:${chromeMetrics().rows.join(',')}` : 'd:-'
        return LIB.panelSignature(measureTouch(root, { hitCheckLimit: 0 }), root === null ? 0 : (root.innerText ?? '').length, extra)
      }
      let last = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const settle = await LIB.waitStable(signature, {
          timeoutMs: config.timeoutMs,
          intervalMs: config.pollIntervalMs,
          settlePolls: config.settlePolls,
          minWaitMs: config.settleWindowMs,
          reason: 'unstable',
        })
        if (settle.ok === false) return settle
        last = settle
        await delay(400)
        if (signature() === settle.value) return { ...settle, confirmations: attempt + 1 }
        console.info(`${TITLE_FLAG} content changed after settle, re-waiting (${attempt + 1})`)
      }
      return { ...last, ok: true, confirmations: 3 }
    }

    async function measureOptOut(before) {
      const root = document.documentElement
      root.setAttribute('data-dsh-adapt', 'off')
      const settled = await LIB.waitStable(() => LIB.touchSignature(measureTouch(mainRoot(), { hitCheckLimit: 0 })), {
        timeoutMs: 2500,
        intervalMs: config.pollIntervalMs,
        settlePolls: 2,
        minWaitMs: 250,
        reason: 'opt-out-no-effect',
      })
      const snapshotOff = snapshot('opt-out', { hit: false })
      root.removeAttribute('data-dsh-adapt')
      const restored = await LIB.waitStable(() => LIB.touchSignature(measureTouch(mainRoot(), { hitCheckLimit: 0 })), {
        timeoutMs: 2500,
        intervalMs: config.pollIntervalMs,
        settlePolls: 2,
        minWaitMs: 250,
        reason: 'unstable',
      })
      const changed = snapshotOff.touch.count !== before.touch.count
        || snapshotOff.touch.min !== before.touch.min
        || snapshotOff.touch.under44 !== before.touch.under44
      return {
        applied: true,
        changed,
        reason: changed ? null : 'opt-out-no-effect',
        touch: snapshotOff.touch,
        floaters: snapshotOff.floaters,
        overflow: snapshotOff.overflow,
        settledMs: settled.waitedMs,
        restored: restored.ok === true,
      }
    }

    async function runScenario(scenario) {
      const started = Date.now()
      const result = {
        name: scenario.name,
        panel: scenario.panel,
        status: 'failed',
        reason: null,
        ok: false,
        ms: null,
        touch: { count: 0, min: null, under44: null, checked: 0, miss: 0, samples: [] },
        hit: { checked: 0, miss: 0, samples: [] },
        optOut: { applied: false, changed: false, reason: null, touch: { count: 0, min: null, under44: null, checked: 0, miss: 0, samples: [] } },
        floaters: { raw: '', attr: null, applied: false },
        overflow: false,
        nav: [],
        drawerRows: [],
        panelOpen: false,
        waitedMs: null,
        detail: {},
      }
      const finish = (extra) => {
        Object.assign(result, extra)
        result.ms = Date.now() - started
        result.ok = result.status === 'ok'
        console.info(`${TITLE_FLAG} ${scenario.name} ${result.status}${result.reason === null ? '' : ` (${result.reason})`}`, JSON.stringify({ n: result.touch.count, min: result.touch.min, under44: result.touch.under44 }))
        return result
      }

      const drawer = await ensureDrawerOpen()
      if (drawer.ok === false) {
        return finish({
          status: scenario.optional ? 'skipped' : 'failed',
          reason: drawer.reason,
          detail: { drawer: drawer.drawer ?? drawerInfo(), attempts: drawer.attempts ?? [] },
        })
      }
      // Row heights are only meaningful while the drawer is open; wait for the
      // list to stop growing before recording them.
      const rowsStable = await LIB.waitStable(() => chromeMetrics().rows.join(','), {
        timeoutMs: Math.min(config.timeoutMs, 3000),
        intervalMs: config.pollIntervalMs,
        settlePolls: 2,
        minWaitMs: 200,
      })
      const drawerRows = rowsStable.ok === true ? String(rowsStable.value).split(',').filter(item => item !== '').map(Number) : chromeMetrics().rows

      const found = await LIB.waitFor(() => findSidebarControl(scenario.labels), {
        accept: value => value !== null,
        timeoutMs: Math.min(config.timeoutMs, 6000),
        intervalMs: config.pollIntervalMs,
        reason: 'sidebar-row-missing',
      })
      if (found.ok === false || found.value === null) {
        return finish({
          status: scenario.optional ? 'skipped' : 'failed',
          reason: scenario.optional ? 'skipped' : 'sidebar-row-missing',
          detail: { labels: scenario.labels, drawer: drawerInfo() },
        })
      }
      result.detail = { clicked: found.value.matched, label: found.value.label }

      found.value.node.click()
      const openPoll = await LIB.waitFor(() => panelInfo(), {
        accept: value => value.open === true,
        timeoutMs: config.timeoutMs,
        intervalMs: config.pollIntervalMs,
        reason: 'panel-not-opened',
      })
      result.waitedMs = openPoll.waitedMs
      if (openPoll.ok === false) {
        return finish({ reason: 'panel-not-opened', panelOpen: false, detail: { ...result.detail, panel: openPoll.value } })
      }

      if (config.hideDuringMeasure === true) setHidden(true)
      const settle = await settleMainRoot()
      if (settle.ok === false) {
        return finish({ reason: 'unstable', panelOpen: true, detail: { ...result.detail, settle: settle.polls } })
      }

      let snapOn = snapshot('adapt-on')
      const optOut = await measureOptOut(snapOn)
      // The opt-out round trip takes ~1-3s. Data-driven panels often finish
      // loading during it (measured: the same panel showed 13 controls before
      // its data arrived and 127 after), so re-check and re-measure once.
      const late = measureTouch(mainRoot(), { hitCheckLimit: 0 })
      let remeasured = false
      if (late.count !== snapOn.touch.count) {
        const resettle = await settleMainRoot()
        if (resettle.ok === true) {
          snapOn = snapshot('adapt-on-retry')
          remeasured = true
          console.info(`${TITLE_FLAG} ${scenario.name}: re-measured after late content (${late.count} controls)`)
        }
      }
      if (config.hideDuringMeasure === true) setHidden(false)
      pushState(`panel:${scenario.name}`)

      const closing = await closePanel(scenario)
      if (closing.ok === false) {
        state.degraded = `panel-not-closeable@${scenario.name}`
        const recovery = await cleanup(`panel-not-closeable@${scenario.name}`)
        return finish({
          status: 'failed',
          reason: 'panel-not-closeable',
          panelOpen: panelInfo().open,
          touch: snapOn.touch,
          hit: { checked: snapOn.touch.checked, miss: snapOn.touch.miss, samples: snapOn.touch.samples },
          optOut,
          floaters: snapOn.floaters,
          overflow: snapOn.overflow,
          nav: snapOn.chrome.nav,
          drawerRows,
          detail: { ...result.detail, remeasured, close: { strategy: null, attempts: closing.attempts }, recovery: recovery.ok },
        })
      }

      return finish({
        status: 'ok',
        reason: null,
        panelOpen: false,
        touch: snapOn.touch,
        hit: { checked: snapOn.touch.checked, miss: snapOn.touch.miss, samples: snapOn.touch.samples },
        optOut,
        floaters: snapOn.floaters,
        overflow: snapOn.overflow,
        nav: snapOn.chrome.nav,
        drawerRows,
        detail: { ...result.detail, remeasured, close: { strategy: closing.strategy, attempts: closing.attempts } },
      })
    }

    function isEditable(node) {
      if (node === null || node === undefined) return false
      const tag = node.tagName === undefined ? '' : node.tagName.toLowerCase()
      if (node.isContentEditable === true) return true
      if (tag === 'textarea') return true
      if (tag !== 'input') return false
      const type = (node.getAttribute?.('type') ?? 'text').toLowerCase()
      return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(type)
    }

    function findKeyboardTarget() {
      for (const selector of config.keyboardProbeSelectors) {
        const node = [...document.querySelectorAll(selector)].find(candidate => isVisible(candidate) && candidate.disabled !== true)
        if (node !== undefined) return node
      }
      return null
    }

    /**
     * Programmatic focus() does NOT raise the Android IME, so this can only ever
     * confirm "focusing an input does not change the viewport". It is kept as
     * diagnostics (`report.keyboard.probe`) and never decides `open` — that comes
     * from the live viewport in `currentKeyboardReport()`.
     */
    async function probeKeyboard() {
      pushState('keyboard-closed')
      const target = findKeyboardTarget()
      if (target === null) {
        const result = { target: null, focused: false, reason: 'keyboard-probe-no-input' }
        state.keyboardProbe = result
        return result
      }
      const before = liveViewport()
      target.focus()
      await delay(900)
      pushState('keyboard-open')
      const during = liveViewport()
      target.blur()
      await delay(500)
      pushState('keyboard-closed-after')
      const after = liveViewport()
      const result = {
        target: describeTarget(target),
        focused: true,
        reason: null,
        innerBefore: before.inner.height,
        innerDuring: during.inner.height,
        innerAfter: after.inner.height,
        changed: before.inner.height !== during.inner.height,
        note: before.inner.height === during.inner.height ? 'programmatic focus did not raise the IME (expected on Android)' : 'viewport changed on programmatic focus',
      }
      state.keyboardProbe = result
      return result
    }

    function rotationInfo() {
      const orientation = typeof window.screen?.orientation === 'object' && window.screen.orientation !== null ? window.screen.orientation.type : null
      return {
        orientation: LIB.orientationOf({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }),
        screenOrientation: orientation,
        inner: { width: window.innerWidth, height: window.innerHeight },
        visual: window.visualViewport === null ? null : { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height) },
        at: new Date().toISOString(),
      }
    }

    function abort(reason, scenario) {
      state.aborted = { reason, scenario: scenario ?? null, message: reasonCode(reason) }
      state.phase = 'aborted'
      render()
    }

    function reasonCode(code) {
      return LIB.reason(code).message
    }

    async function pilot() {
      if (state.piloting === true) return state.report
      if (ready() === false) {
        abort('page-not-loaded')
        return publish()
      }
      state.piloting = true
      state.started = true
      state.aborted = null
      state.cleanup = null
      state.degraded = null
      state.currentScenario = null
      state.scenarios = []
      state.states = []
      state.keyboardProbe = null
      state.phase = 'waiting-for-shell'
      // Remember the page's own opt-out value so cleanup restores it rather than
      // guessing "unset".
      state.initialOptOut = document.documentElement.getAttribute('data-dsh-adapt')
      if (ready() === true) state.env = readEnv()
      render()

      try {
        const shell = await waitForShell()
        if (shell.ok === false) {
          await cleanup('page-not-loaded')
          abort('page-not-loaded')
          return publish()
        }
        state.env = readEnv()
        state.rotation = rotationInfo()
        pushState('boot')

        for (const scenario of config.scenarios) {
          state.currentScenario = scenario
          state.phase = `scenario:${scenario.name}`
          render()
          const result = await runScenario(scenario)
          state.scenarios.push(result)
          render()
          // A panel that would not close is recorded per scenario and recovered
          // from; it must not stop the remaining scenarios (tablet regression).
          pushState(`after:${scenario.name}`)
        }

        state.currentScenario = null
        if (config.keyboardProbe === true && state.aborted === null) {
          state.phase = 'keyboard-probe'
          render()
          await probeKeyboard()
        }
        // Always record the final state of the page, not only when something is
        // left open: `report.cleanup` should never be a mystery.
        await cleanup('end-of-run')
        state.phase = 'done'
      } catch (error) {
        const message = String(error && error.stack ? error.stack : error)
        window.__dvError = message
        await cleanup('overlay-error').catch(() => {})
        state.aborted = { reason: 'overlay-error', scenario: state.phase, message }
        console.error(`${TITLE_FLAG} ${message}`)
      } finally {
        state.piloting = false
      }
      return publish()
    }

    function scheduleResize(trigger) {
      if (resizeTimer !== null) return
      pendingTrigger = typeof trigger === 'string' ? trigger : 'resize'
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        if (ready() === false) return
        recordViewportEvent(pendingTrigger)
        pushState('resize')
        state.rotation = rotationInfo()
        if (state.env?.inner !== undefined) {
          state.env = { ...state.env, inner: { width: window.innerWidth, height: window.innerHeight }, visual: window.visualViewport === null ? null : { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height) }, orientation: LIB.orientationOf({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }) }
        }
        if (state.report !== null) publish()
        else render()
      }, 300)
    }

    function start() {
      if (ready() === false) {
        document.addEventListener('DOMContentLoaded', start, { once: true })
        return
      }
      ensurePanel()
      render()
      // focusin/focusout tell us whether the shrink belongs to an input, which
      // is what separates "keyboard" from "the page just got shorter".
      document.addEventListener('focusin', event => {
        state.editableFocused = isEditable(event.target)
        state.lastEditableFocusAt = Date.now()
      }, true)
      document.addEventListener('focusout', () => {
        state.editableFocused = false
      }, true)
      state.lastViewport = { inner: { width: window.innerWidth, height: window.innerHeight }, visual: window.visualViewport === null ? { width: null, height: null } : { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height) } }
      updateBaseline(liveViewport())
      recordViewportEvent('boot')
      window.addEventListener('resize', () => scheduleResize('resize'))
      window.addEventListener('orientationchange', () => scheduleResize('orientationchange'))
      if (window.visualViewport !== null) window.visualViewport.addEventListener('resize', () => scheduleResize('visualViewport'))
      window.addEventListener('pagehide', () => { if (state.report !== null) scheduleSink() }, { once: true })
      if (config.autoStart === true && config.noPilot !== true) {
        window.setTimeout(() => { void pilot() }, config.startDelayMs)
      } else {
        state.phase = config.noPilot === true
          ? 'idle (--no-pilot): page left on the conversation; call window.__dvRun() when ready'
          : 'idle (call window.__dvRun())'
        render()
      }
      console.info(`${TITLE_FLAG} v${LIB.VERSION} ready: ${config.scenarios.length} scenario(s), sink=${config.sinkUrl ?? 'off'}, autoStart=${config.autoStart}`)
    }

    return {
      version: LIB.VERSION,
      config,
      state,
      cleanup,
      closeStrategies,
      pilot,
      publish,
      render,
      setHidden,
      markState: label => { pushState(label === undefined ? 'mark' : String(label)); return publish() },
      start,
      stop: () => {
        if (sinkTimer !== null) window.clearTimeout(sinkTimer)
        if (panelEl !== null) panelEl.remove()
        panelEl = null
      },
    }
  }
})()
