/**
 * dsh-device-verify · shared, DOM-free logic (v2).
 *
 * This file is concatenated *after* a generated `window.__dvConfig = {...}` block
 * and *before* overlay.js, then written to <DSH_HOME>/mobile-access/mobile.js by
 * run.mjs. It must therefore stay a plain classic script: no `import`, no
 * `export`, no top-level `await`. Everything lives on `globalThis.DshVerifyLib`
 * so `node --test` can load it with `new Function(source)` and test it without a
 * browser.
 *
 * Nothing here touches the DOM, the network or storage; overlay.js does that.
 */
(function (global) {
  'use strict'

  const VERSION = 2
  const SCHEMA = 'dsh-device-verify/2'
  const TITLE_PREFIX = 'DVJSON:'
  const TITLE_TRUNCATED_PREFIX = 'DVJSON-TRUNCATED:'
  /** The floor every pack and the 0.8.1 host aim at. */
  const TOUCH_FLOOR_PX = 44
  /** Sub-pixel tolerance: 43.5..44 is a rounded 44, not a miss. */
  const UNDER_FLOOR_PX = 43.5

  const DEFAULT_SCENARIOS = Object.freeze([
    { name: 'context-insights', panel: 'context-insights', labels: Object.freeze(['上下文洞察', 'Context Insights']) },
    { name: 'todos', panel: 'todos', labels: Object.freeze(['待办', 'Todos']) },
    { name: 'plugins', panel: 'plugins', labels: Object.freeze(['插件', 'Plugins']) },
    // Unverified row label; `optional` keeps a missing row out of the failure column.
    { name: 'memory', panel: 'memory', labels: Object.freeze(['记忆系统', '记忆', 'Memory', 'Memory system']), optional: true },
  ])

  /** Every failure/shape code the overlay or the driver can emit. */
  const REASONS = Object.freeze({
    'page-not-loaded': {
      message: '页面没有挂载出来：等不到 .dshm-shell / [data-slot="main"]。',
      hint: '确认手机连的是 dsh-mobile 专用页（不是 /?frontend=stock 桌面布局），并检查网关与配对是否还在。',
    },
    'overlay-error': {
      message: '覆盖层自己抛错了，报告可能不完整。',
      hint: '看 window.__dvError 与 `adb logcat | grep -i chromium` 里的 [dsh-verify] 行。',
    },
    'sidebar-unreachable': {
      message: '侧栏展开不了，也找不到任何场景入口。',
      hint: '面板名可能变了（本地化或插件改名）；用 `run.mjs scenarios` 改 scenarios.json 的 labels。',
    },
    'sidebar-row-missing': {
      message: '侧栏里没有这个场景的入口按钮。',
      hint: '该面板没装/没启用，或 aria-label 变了；这条会写成 skipped（optional）或失败（必测）。',
    },
    'panel-not-opened': {
      message: '点了侧栏，但面板没有打开。',
      hint: '看 0.8.0 无 data-dsh-panel：这里用 .dshm-panelNav 兜底；若两者都没有，可能是点击命中了折叠抽屉里的隐藏节点。',
    },
    'panel-not-closed': {
      message: '（旧码，只用于读历史报告；当前代码不再 emit）面板没关回去。',
      hint: '现行实现改为 panel-not-closeable，且不再中止整轮；见 README §8.1。',
      legacy: true,
    },
    'panel-not-closeable': {
      message: '所有关闭策略都失败了：面板仍开着。',
      hint: '平板 ≥900px 时宿主不渲染 .dshm-panelNav，靠 dsh-mobile:native-back 事件关闭；若宿主改了这个事件名或加了守卫，需要更新 overlay.js 的 closeStrategies()。',
    },
    'native-back-unhandled': {
      message: '派发了 dsh-mobile:native-back，但宿主没有处理（可能是 App 侧监听、或事件名变了）。',
      hint: '0.8.1 的 lib/mobile-layout.js 在 window 上监听 dsh-mobile:native-back；用 `grep -n "native-back" mobile-layout.js` 复核。',
    },
    unstable: {
      message: '主槽控件在超时内没有稳定下来（数量/最小边一直在变）。',
      hint: '多半是虚拟滚动或骨架屏还在填充；调大 config.timeoutMs 或 settlePolls。',
    },
    timeout: {
      message: '等待超时。',
      hint: '调大 config.timeoutMs；慢设备上 9s 可能不够。',
    },
    'opt-out-no-effect': {
      message: '切了 html[data-dsh-adapt=off] 但尺寸没有任何变化。',
      hint: '可能本来就没有包在生效（基线态），也可能包的 opt-out 守卫写的是别的属性。',
    },
    'keyboard-probe-no-input': {
      message: '键盘探针找不到可聚焦的输入框。',
      hint: '面板都关掉、回到对话页再测；或改 config.keyboardProbeSelectors。',
    },
    'sink-failed': {
      message: 'POST 报告到宿主机失败（fetch 抛错或被拦）。',
      hint: '确认 `run.mjs report` 在跑、adb reverse 已建立、端口一致；不影响 document.title / 可复制区域。',
    },
    'title-truncated': {
      message: '报告超过 title 上限，title 里只有前半段。',
      hint: '用 sink（run.mjs report）或可复制区域拿完整 JSON。',
    },
    skipped: {
      message: '场景被跳过（optional 且侧栏没有入口）。',
      hint: '不需要处理；想强制测就给该场景去掉 optional。',
    },
  })

  function reason(code) {
    const entry = REASONS[code]
    return entry ?? { message: String(code), hint: '' }
  }

  function describeReason(code) {
    const entry = reason(code)
    return `${code}: ${entry.message}`
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && Array.isArray(value) === false
  }

  function clampInt(value, fallback, min, max) {
    const number = Number(value)
    if (Number.isFinite(number) === false) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }

  function uniqueStrings(list, limit) {
    const seen = new Set()
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item !== 'string') continue
      const text = item.trim()
      if (text === '' || seen.has(text)) continue
      seen.add(text)
      out.push(text)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Turn an arbitrary scenario list into a validated one.
   * Unknown keys are dropped, duplicated names keep the first definition.
   *
   * @param {unknown} raw
   * @returns {{ scenarios: Array<{name: string, panel: string, labels: string[], marker: string|null, optional: boolean}>, dropped: Array<{index: number, reason: string}> }}
   */
  function normalizeScenarios(raw) {
    if (Array.isArray(raw) === false) return { scenarios: DEFAULT_SCENARIOS.map(copyScenario), dropped: [] }
    const scenarios = []
    const dropped = []
    const seen = new Set()
    raw.forEach((item, index) => {
      if (isPlainObject(item) === false) { dropped.push({ index, reason: 'not-an-object' }); return }
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (name === '') { dropped.push({ index, reason: 'missing-name' }); return }
      if (seen.has(name)) { dropped.push({ index, reason: `duplicate-name:${name}` }); return }
      const labels = uniqueStrings(item.labels, 8)
      if (labels.length === 0) { dropped.push({ index, reason: `no-labels:${name}` }); return }
      seen.add(name)
      scenarios.push({
        name,
        panel: typeof item.panel === 'string' && item.panel.trim() !== '' ? item.panel.trim() : name,
        labels,
        marker: typeof item.marker === 'string' && item.marker.trim() !== '' ? item.marker.trim() : null,
        optional: item.optional === true,
      })
    })
    if (scenarios.length === 0) return { scenarios: DEFAULT_SCENARIOS.map(copyScenario), dropped }
    return { scenarios, dropped }
  }

  function copyScenario(scenario) {
    return { name: scenario.name, panel: scenario.panel, labels: [...scenario.labels], marker: scenario.marker ?? null, optional: scenario.optional === true }
  }

  /**
   * @param {unknown} raw
   * @returns {object} a fully populated config; every field is safe to use as-is
   */
  function normalizeConfig(raw) {
    const source = isPlainObject(raw) ? raw : {}
    const { scenarios, dropped } = normalizeScenarios(source.scenarios)
    const sinkUrl = typeof source.sinkUrl === 'string' ? source.sinkUrl.trim() : ''
    return {
      version: VERSION,
      autoStart: source.autoStart !== false,
      // `--no-pilot`: inject the overlay but leave the page on the conversation so
      // a finger can open the keyboard and the tool can measure it.
      noPilot: source.noPilot === true,
      startDelayMs: clampInt(source.startDelayMs, 2500, 0, 60_000),
      pollIntervalMs: clampInt(source.pollIntervalMs, 120, 20, 2_000),
      timeoutMs: clampInt(source.timeoutMs, 9_000, 500, 120_000),
      // How long one close strategy gets before the next one is tried.
      closeTimeoutMs: clampInt(source.closeTimeoutMs, 1_200, 100, 10_000),
      // history.back() is the last resort and can navigate away; opt out if the
      // page keeps a real history entry.
      allowHistoryBack: source.allowHistoryBack !== false,
      settlePolls: clampInt(source.settlePolls, 3, 2, 20),
      // Minimum wall-clock stability before a panel counts as settled: async
      // panel content (virtual lists, streamed rows) arrives after the first
      // identical samples and would otherwise be measured half-rendered.
      settleWindowMs: clampInt(source.settleWindowMs, 900, 0, 30_000),
      hitCheckLimit: clampInt(source.hitCheckLimit, 200, 0, 2_000),
      titleMaxChars: clampInt(source.titleMaxChars, 20_000, 500, 200_000),
      maxStates: clampInt(source.maxStates, 40, 2, 200),
      keyboardProbe: source.keyboardProbe !== false,
      // A viewport shrink of at least this many CSS px counts as "keyboard-like".
      keyboardThreshold: clampInt(source.keyboardThreshold, 80, 20, 2000),
      maxViewportEvents: clampInt(source.maxViewportEvents, 40, 2, 200),
      exportLogcat: source.exportLogcat !== false,
      keyboardProbeSelectors: uniqueStrings(
        Array.isArray(source.keyboardProbeSelectors) && source.keyboardProbeSelectors.length > 0
          ? source.keyboardProbeSelectors
          : ['[data-slot="main"] textarea', '[data-slot="main"] input[type="text"]', '[data-slot="main"] [contenteditable="true"]'],
        8,
      ),
      // Default true: the overlay's own copy area sits above the page and would
      // otherwise be reported as the element covering real controls.
      hideDuringMeasure: source.hideDuringMeasure !== false,
      sinkUrl: sinkUrl === '' || sinkUrl === 'off' || sinkUrl === 'false' ? null : sinkUrl,
      scenarios,
      dropped,
    }
  }

  /**
   * Size statistics over already-measured control boxes.
   * @param {number[]} sizes `min(width, height)` in CSS px
   */
  function classifySizes(sizes) {
    const values = (Array.isArray(sizes) ? sizes : []).filter(value => Number.isFinite(value) && value > 0)
    if (values.length === 0) return { count: 0, min: null, under44: 0, floor: TOUCH_FLOOR_PX }
    return {
      count: values.length,
      min: Math.round(Math.min(...values) * 10) / 10,
      under44: values.filter(value => value < UNDER_FLOOR_PX).length,
      floor: TOUCH_FLOOR_PX,
    }
  }

  /**
   * Extended settle signature: control sizes *and* how much text the panel
   * renders. A skeleton that gets replaced by real content usually changes the
   * text a lot while its control count barely moves.
   * @param {object} touch result of the size measurement
   * @param {number} textLength visible text length of the measured root
   */
  function panelSignature(touch, textLength, extra) {
    const length = Number.isFinite(textLength) ? Math.max(0, textLength) : 0
    // 40-char buckets are enough to notice skeleton → content without making the
    // signature flaky on a live counter.
    const bucket = length < 40 ? 0 : Math.round(length / 40)
    // `extra` carries things that settle independently of the panel content,
    // e.g. the drawer rows when the drawer is open (`d:67` vs `d:60`).
    return `${touchSignature(touch)}|t${bucket}${typeof extra === 'string' && extra !== '' ? `|${extra}` : ''}`
  }

  /**
   * One diagnostic string per control whose hit test missed.
   * F7: the verifier could not tell *which* probe point missed (a 4/5 sample),
   * so the point and the element covering it are both recorded.
   *
   * @param {{tag: string, width: number, height: number, hit: number, probed: number, misses: Array<{point: string, x: number, y: number, by: string|null}>, blocker?: string|null}} raw
   */
  function hitSample(raw) {
    const source = isPlainObject(raw) ? raw : {}
    const width = Number.isFinite(source.width) ? Math.round(source.width) : 0
    const height = Number.isFinite(source.height) ? Math.round(source.height) : 0
    const misses = (Array.isArray(source.misses) ? source.misses : [])
      .map(item => {
        const point = typeof item?.point === 'string' ? item.point : 'unknown'
        const x = Number.isFinite(item?.x) ? Math.round(item.x) : 0
        const y = Number.isFinite(item?.y) ? Math.round(item.y) : 0
        const by = typeof item?.by === 'string' && item.by !== '' ? item.by : 'none'
        return `${point}(${x},${y})→${by}`
      })
    return `${source.tag ?? 'node'} ${width}x${height} ${source.hit ?? 0}/${source.probed ?? 0}${misses.length === 0 ? '' : ` miss=${misses.join(' ')}`}`
  }

  /** Cheap, hit-test-free signature used to decide "the panel has settled". */
  function touchSignature(touch) {
    if (touch === null || typeof touch !== 'object') return 'none'
    const sizes = Array.isArray(touch.sizes) ? touch.sizes : []
    const head = sizes.slice(0, 12).map(value => Math.round(value)).join('.')
    return `${touch.count}|${touch.min}|${touch.under44}|${head}`
  }

  function keyboardOf(baseline, current, options) {
    const threshold = Number.isFinite(options?.threshold) ? Math.round(options.threshold) : 80
    const base = { inner: baseline?.inner?.height ?? null, visual: baseline?.visual?.height ?? null }
    const now = { inner: current?.inner?.height ?? null, visual: current?.visual?.height ?? null }
    const innerDelta = base.inner !== null && now.inner !== null ? now.inner - base.inner : null
    const visualDelta = base.visual !== null && now.visual !== null ? now.visual - base.visual : null
    const shrank = delta => delta !== null && delta <= -threshold
    return {
      open: shrank(innerDelta) || shrank(visualDelta),
      threshold,
      baseline: base,
      current: now,
      innerDelta,
      visualDelta,
    }
  }

  function viewportOf(source) {
    const inner = source?.inner ?? {}
    const visual = source?.visual ?? {}
    return {
      inner: { width: Number.isFinite(inner.width) ? inner.width : null, height: Number.isFinite(inner.height) ? inner.height : null },
      visual: { width: Number.isFinite(visual.width) ? visual.width : null, height: Number.isFinite(visual.height) ? visual.height : null },
    }
  }

  /**
   * Why did the viewport change? The shell can shrink for three reasons:
   * the soft keyboard (adjustResize), a rotation, or a pinch/page zoom. Only the
   * first one is a keyboard, and rotation must never be reported as one — on a
   * 909x1314 tablet, rotating to 1363x860 also shrinks the height by 454px.
   *
   * @param {{inner?: {width?: number|null, height?: number|null}, visual?: {width?: number|null, height?: number|null}, orientation?: string}} previous
   * @param {{inner?: {width?: number|null, height?: number|null}, visual?: {width?: number|null, height?: number|null}, orientation?: string}} next
   * @param {{threshold?: number, editableFocused?: boolean, scale?: number|null}} facts
   */
  function classifyViewportChange(previous, next, facts) {
    const threshold = Number.isFinite(facts?.threshold) ? Math.round(facts.threshold) : 80
    const before = viewportOf(previous)
    const now = viewportOf(next)
    const deltaInner = Number.isFinite(before.inner.height) && Number.isFinite(now.inner.height) ? now.inner.height - before.inner.height : null
    const deltaVisual = Number.isFinite(before.visual.height) && Number.isFinite(now.visual.height) ? now.visual.height - before.visual.height : null
    const widthDelta = Number.isFinite(before.inner.width) && Number.isFinite(now.inner.width) ? now.inner.width - before.inner.width : null
    const orientationChanged = typeof previous?.orientation === 'string' && typeof next?.orientation === 'string'
      ? previous.orientation !== next.orientation
      : (Number.isFinite(widthDelta) && Math.abs(widthDelta) > 50)
    const scale = Number.isFinite(facts?.scale) ? facts.scale : null
    const zoom = scale !== null && Math.abs(scale - 1) > 0.01
    const shrank = (deltaInner !== null && deltaInner <= -threshold) || (deltaVisual !== null && deltaVisual <= -threshold)
    const grew = (deltaInner !== null && deltaInner >= threshold) || (deltaVisual !== null && deltaVisual >= threshold)
    let source = 'none'
    if (orientationChanged) source = 'rotation'
    else if (zoom) source = 'zoom'
    else if (shrank && facts?.editableFocused !== false) source = 'keyboard'
    else if (shrank) source = 'viewport-shrink'
    else if (grew) source = 'viewport-grow'
    else if ((deltaInner !== null && deltaInner !== 0) || (deltaVisual !== null && deltaVisual !== 0)) source = 'resize'
    return {
      source,
      keyboardLike: source === 'keyboard',
      deltaInner,
      deltaVisual,
      widthDelta,
      orientationChanged,
      zoom,
      shrank,
      threshold,
    }
  }

  /**
   * The `report.keyboard` block, computed at report time from the *live*
   * viewport and the latest keyboard-closed baseline. Never cached: the whole
   * point is that a finger can raise the keyboard after the pilot finished.
   *
   * @param {{current: object, baseline: object|null, editableFocused?: boolean, threshold?: number, scale?: number|null, previous?: object|null, at?: string}} facts
   */
  function keyboardReport(facts) {
    const threshold = Number.isFinite(facts?.threshold) ? Math.round(facts.threshold) : 80
    const current = viewportOf(facts?.current)
    const baseline = viewportOf(facts?.baseline ?? facts?.current)
    const change = classifyViewportChange(
      { ...baseline, orientation: facts?.baselineOrientation },
      { ...current, orientation: facts?.currentOrientation },
      { threshold, editableFocused: facts?.editableFocused, scale: facts?.scale },
    )
    // The keyboard is the only shrink we report as open: a rotation changes the
    // orientation, and a zoom changes visualViewport.scale.
    const open = change.shrank === true && change.source !== 'rotation' && change.source !== 'zoom'
    return {
      open,
      threshold,
      baseline: { inner: baseline.inner.height, visual: baseline.visual.height },
      current: { inner: current.inner.height, visual: current.visual.height },
      innerDelta: change.deltaInner,
      visualDelta: change.deltaVisual,
      source: change.source,
      keyboardLike: open,
      editableFocused: facts?.editableFocused === true,
      at: typeof facts?.at === 'string' ? facts.at : null,
    }
  }

  /**
   * `scenario?.labels`, but always a string array. The cleanup path runs with
   * `state.currentScenario === null` (after the pilot loop) and used to crash on
   * `null.labels` — every caller must go through this.
   */
  function scenarioLabels(scenario) {
    if (isPlainObject(scenario) === false) return []
    return uniqueStrings(scenario.labels, 8)
  }

  /** Sidebar entries worth trying when we have no scenario to toggle. */
  function scenarioEntryLabels(scenarios, limit) {
    const out = []
    for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
      for (const label of scenarioLabels(scenario)) {
        if (out.includes(label) === false) out.push(label)
        if (out.length >= (limit ?? 12)) return out
      }
    }
    return out
  }

  function normalizeViewportEvent(raw) {
    if (isPlainObject(raw) === false) return null
    return {
      at: typeof raw.at === 'string' ? raw.at : '',
      phase: typeof raw.phase === 'string' ? raw.phase : 'resize',
      trigger: typeof raw.trigger === 'string' ? raw.trigger : 'unknown',
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      inner: { width: raw.inner?.width ?? null, height: raw.inner?.height ?? null },
      visual: { width: raw.visual?.width ?? null, height: raw.visual?.height ?? null },
      deltaInner: Number.isFinite(raw.deltaInner) ? raw.deltaInner : null,
      deltaVisual: Number.isFinite(raw.deltaVisual) ? raw.deltaVisual : null,
      orientation: typeof raw.orientation === 'string' ? raw.orientation : null,
      editableFocused: raw.editableFocused === true,
    }
  }

  function orientationOf(sizes) {
    const width = sizes?.innerWidth ?? 0
    const height = sizes?.innerHeight ?? 0
    return width > height ? 'landscape' : 'portrait'
  }

  function stateSignature(state) {
    if (state === null || typeof state !== 'object') return 'none'
    return [
      state.phase ?? '-',
      `${state.inner?.width ?? '?'}x${state.inner?.height ?? '?'}`,
      `${state.visual?.width ?? '?'}x${state.visual?.height ?? '?'}`,
      state.floaters?.attr ?? '-',
      state.panel?.id ?? '-',
      state.overflow === true ? 'ovf' : 'ok',
    ].join('|')
  }

  function normalizeTouch(raw) {
    if (isPlainObject(raw) === false) return { count: 0, min: null, under44: null, checked: 0, miss: 0, samples: [] }
    return {
      count: Number.isFinite(raw.count) ? raw.count : 0,
      min: Number.isFinite(raw.min) ? raw.min : null,
      under44: Number.isFinite(raw.under44) ? raw.under44 : null,
      checked: Number.isFinite(raw.checked) ? raw.checked : 0,
      miss: Number.isFinite(raw.miss) ? raw.miss : 0,
      samples: Array.isArray(raw.samples) ? raw.samples.slice(0, 4) : [],
      truncated: raw.truncated === true,
    }
  }

  function normalizeFloat(raw) {
    if (isPlainObject(raw) === false) return { raw: '', attr: null, applied: false }
    const attr = raw.attr === null || raw.attr === undefined ? null : String(raw.attr)
    return { raw: typeof raw.raw === 'string' ? raw.raw : '', attr, applied: attr === '1' }
  }

  /** Deterministic shape for one scenario result, whatever the pilot produced. */
  function normalizeScenarioResult(raw, scenario) {
    const source = isPlainObject(raw) ? raw : {}
    const base = scenario ?? {}
    const touch = normalizeTouch(source.touch)
    const hit = isPlainObject(source.hit) ? source.hit : { checked: touch.checked, miss: touch.miss }
    const optOut = isPlainObject(source.optOut)
      ? {
        applied: source.optOut.applied === true,
        changed: source.optOut.changed === true,
        reason: source.optOut.reason ?? null,
        touch: normalizeTouch(source.optOut.touch),
      }
      : { applied: false, changed: false, reason: null, touch: { count: 0, min: null, under44: null, checked: 0, miss: 0, samples: [] } }
    return {
      name: typeof source.name === 'string' ? source.name : (base.name ?? 'unknown'),
      panel: source.panel ?? base.panel ?? null,
      status: source.status === 'ok' || source.status === 'skipped' || source.status === 'failed' ? source.status : 'failed',
      reason: source.reason ?? null,
      ok: source.ok === true,
      ms: Number.isFinite(source.ms) ? source.ms : null,
      touch,
      hit: {
        checked: Number.isFinite(hit.checked) ? hit.checked : touch.checked,
        miss: Number.isFinite(hit.miss) ? hit.miss : touch.miss,
        samples: Array.isArray(hit.samples) ? hit.samples.slice(0, 4) : [],
      },
      optOut,
      floaters: normalizeFloat(source.floaters),
      overflow: source.overflow === true,
      nav: Array.isArray(source.nav) ? source.nav : [],
      drawerRows: Array.isArray(source.drawerRows) ? source.drawerRows : [],
      panelOpen: source.panelOpen === true,
      waitedMs: Number.isFinite(source.waitedMs) ? source.waitedMs : null,
      // Diagnostics: which row was clicked, which labels were tried, close details.
      detail: isPlainObject(source.detail) ? source.detail : null,
    }
  }

  function normalizeState(raw) {
    if (isPlainObject(raw) === false) return null
    return {
      at: typeof raw.at === 'string' ? raw.at : '',
      phase: typeof raw.phase === 'string' ? raw.phase : 'unknown',
      inner: { width: raw.inner?.width ?? null, height: raw.inner?.height ?? null },
      visual: { width: raw.visual?.width ?? null, height: raw.visual?.height ?? null },
      floaters: normalizeFloat(raw.floaters),
      panel: { id: raw.panel?.id ?? null, open: raw.panel?.open === true },
      overflow: raw.overflow === true,
      keyboard: raw.keyboard === true,
    }
  }

  /**
   * Ordered close strategies. The host itself closes a main panel from
   * `dsh-mobile:native-back` (0.8.1 lib/mobile-layout.js, `onNativeBack`), which
   * is the only path that works on tablets: at >=900px the shell does not render
   * `.dshm-panelNav`, so there is no back button to click.
   *
   * @param {{hasPanelNav?: boolean, panelNavDisabled?: boolean, hasSidebarEntry?: boolean, allowHistoryBack?: boolean, historyLength?: number}} facts
   * @returns {string[]} strategy names, most likely first
   */
  function planClose(facts) {
    const source = isPlainObject(facts) ? facts : {}
    const plan = []
    if (source.hasPanelNav === true && source.panelNavDisabled !== true) plan.push('panelNav-back')
    plan.push('native-back-event')
    if (source.hasSidebarEntry === true) plan.push('sidebar-toggle')
    plan.push('escape-key')
    if (source.allowHistoryBack !== false && (Number(source.historyLength) || 0) > 1) plan.push('history-back')
    return plan
  }

  function normalizeCleanup(raw) {
    if (isPlainObject(raw) === false) return null
    const steps = Array.isArray(raw.attempted) ? raw.attempted : []
    return {
      ok: raw.ok === true,
      cause: raw.cause ?? null,
      panelOpen: raw.panelOpen === true,
      drawerOpen: raw.drawerOpen === true,
      optOutRestored: raw.optOutRestored === true,
      attempted: steps.map(step => ({
        step: typeof step?.step === 'string' ? step.step : 'unknown',
        ok: step?.ok === true,
        strategy: step?.strategy ?? null,
        attempts: Array.isArray(step?.attempts)
          ? step.attempts.map(item => ({ name: item?.name ?? 'unknown', ok: item?.ok === true, waitedMs: Number.isFinite(item?.waitedMs) ? item.waitedMs : null, error: item?.error ?? null }))
          : [],
      })),
    }
  }

  const REPORT_KEYS = Object.freeze([
    'schema', 'version', 'at', 'durationMs', 'started', 'aborted', 'cleanup', 'env', 'keyboard', 'viewportEvents', 'rotation', 'states', 'scenarios', 'config',
  ])

  /**
   * Assemble the final report. Field order is fixed so two runs are diffable.
   * @param {object} parts
   */
  function buildReport(parts) {
    const source = isPlainObject(parts) ? parts : {}
    const scenarios = Array.isArray(source.scenarios) ? source.scenarios.map(item => normalizeScenarioResult(item)) : []
    const states = (Array.isArray(source.states) ? source.states : []).map(normalizeState).filter(item => item !== null)
    return {
      schema: SCHEMA,
      version: VERSION,
      at: typeof source.at === 'string' ? source.at : new Date().toISOString(),
      durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
      started: source.started === true,
      aborted: isPlainObject(source.aborted) ? { reason: source.aborted.reason ?? null, scenario: source.aborted.scenario ?? null, message: source.aborted.message ?? null } : null,
      cleanup: normalizeCleanup(source.cleanup),
      env: isPlainObject(source.env) ? source.env : {},
      keyboard: isPlainObject(source.keyboard) ? source.keyboard : null,
      viewportEvents: (Array.isArray(source.viewportEvents) ? source.viewportEvents : []).map(normalizeViewportEvent).filter(item => item !== null),
      rotation: isPlainObject(source.rotation) ? source.rotation : null,
      states,
      scenarios,
      config: isPlainObject(source.config) ? source.config : {},
    }
  }

  /** Cheap structural check the driver uses to reject a stray POST. */
  function isReport(value) {
    return isPlainObject(value) && value.schema === SCHEMA && Array.isArray(value.scenarios)
  }

  function encodeTitle(report, maxChars) {
    const json = JSON.stringify(report)
    const limit = Number.isFinite(maxChars) ? Math.max(64, maxChars) : 20_000
    if (json.length <= limit) return { title: TITLE_PREFIX + json, truncated: false, bytes: json.length }
    return { title: TITLE_TRUNCATED_PREFIX + json.slice(0, limit), truncated: true, bytes: json.length }
  }

  /**
   * Read a report back out of document.title (used by run-lib and the smoke run).
   * @returns {{truncated: boolean, report: object|null, raw?: string, error?: string}|null}
   */
  function decodeTitle(title) {
    const text = typeof title === 'string' ? title : ''
    if (text.startsWith(TITLE_TRUNCATED_PREFIX)) {
      return { truncated: true, report: null, raw: text.slice(TITLE_TRUNCATED_PREFIX.length) }
    }
    if (text.startsWith(TITLE_PREFIX) === false) return null
    try {
      const parsed = JSON.parse(text.slice(TITLE_PREFIX.length))
      return { truncated: false, report: isPlainObject(parsed) ? parsed : null, error: isPlainObject(parsed) ? undefined : 'not-an-object' }
    } catch {
      return { truncated: false, report: null, error: 'parse-error' }
    }
  }

  /**
   * Poll `probe` until `accept(value)` is true or `settlePolls` consecutive
   * probes returned the same signature. Injected clock/sleep keep it testable.
   */
  async function pollValue(options) {
    const config = isPlainObject(options) ? options : {}
    const probe = config.probe
    if (typeof probe !== 'function') throw new TypeError('pollValue: probe must be a function')
    const clock = typeof config.now === 'function' ? config.now : () => Date.now()
    const wait = typeof config.sleep === 'function' ? config.sleep : ms => new Promise(resolve => global.setTimeout(resolve, ms))
    const timeoutMs = clampInt(config.timeoutMs, 9_000, 1, 600_000)
    const intervalMs = clampInt(config.intervalMs, 120, 0, 10_000)
    const settlePolls = clampInt(config.settlePolls, 0, 0, 50)
    const accept = typeof config.accept === 'function' ? config.accept : null
    const minWaitMs = clampInt(config.minWaitMs, 0, 0, 60_000)
    const started = clock()
    let lastSignature = null
    let stable = 0
    let polls = 0
    let value
    for (;;) {
      value = probe()
      polls += 1
      const elapsed = clock() - started
      if (accept !== null && accept(value) && elapsed >= minWaitMs) {
        return { ok: true, value, polls, waitedMs: elapsed, settled: true }
      }
      const signature = typeof value === 'string' ? value : JSON.stringify(value)
      if (signature === lastSignature) stable += 1
      else {
        stable = 0
        lastSignature = signature
      }
      if (settlePolls > 0 && stable + 1 >= settlePolls && elapsed >= minWaitMs) {
        return { ok: true, value, polls, waitedMs: elapsed, settled: true }
      }
      if (elapsed >= timeoutMs) {
        return { ok: false, value, polls, waitedMs: elapsed, settled: false, reason: config.reason ?? 'timeout' }
      }
      await wait(intervalMs)
    }
  }

  function waitFor(probe, options) {
    return pollValue({ ...(options ?? {}), probe, settlePolls: 0, reason: options?.reason ?? 'timeout' })
  }

  function waitStable(probe, options) {
    return pollValue({ ...(options ?? {}), probe, settlePolls: options?.settlePolls ?? 3, reason: options?.reason ?? 'unstable' })
  }

  function summarize(report) {
    if (isReport(report) === false) return ['not a device-verify report']
    const lines = []
    const env = report.env ?? {}
    lines.push(`DV${report.version} ${env.inner?.width ?? '?'}x${env.inner?.height ?? '?'} dpr=${env.dpr ?? '?'} vv=${env.visual?.width ?? '?'}x${env.visual?.height ?? '?'} shell=${report.started === true ? 'yes' : 'no'}`)
    for (const scenario of report.scenarios) {
      const flag = scenario.status === 'ok' ? 'ok ' : (scenario.status === 'skipped' ? 'skip' : 'FAIL')
      lines.push(
        `${flag} ${scenario.name} n=${scenario.touch.count} min=${scenario.touch.min} <44=${scenario.touch.under44} ` +
        `hit=${scenario.touch.checked - scenario.touch.miss}/${scenario.touch.checked} ` +
        `optout=${scenario.optOut.changed === true ? `<44=${scenario.optOut.touch.under44}` : 'no-change'} ` +
        `flo=${scenario.floaters.attr ?? '-'} ovf=${scenario.overflow === true ? 1 : 0}${scenario.reason === null ? '' : ` ${scenario.reason}`}`,
      )
    }
    if (report.cleanup !== null) {
      const tried = report.cleanup.attempted.map(step => `${step.step}=${step.ok ? 'ok' : 'fail'}${step.strategy === null ? '' : `(${step.strategy})`}`).join(' ')
      lines.push(`cleanup ok=${report.cleanup.ok} panelOpen=${report.cleanup.panelOpen} ${tried}`)
    }
    if (report.keyboard !== null) {
      lines.push(`keyboard open=${report.keyboard.open === true} inner ${report.keyboard.baseline?.inner}->${report.keyboard.current?.inner} (Δ${report.keyboard.innerDelta ?? '?'}, ${report.keyboard.source ?? '?'})`)
    }
    if (report.viewportEvents.length > 0) {
      const last = report.viewportEvents[report.viewportEvents.length - 1]
      lines.push(`viewportEvents ${report.viewportEvents.length} (last ${last.source} Δ${last.deltaInner ?? '?'})`)
    }
    if (report.aborted !== null) lines.push(`aborted ${report.aborted.reason}`)
    return lines
  }

  global.DshVerifyLib = {
    VERSION,
    SCHEMA,
    TITLE_PREFIX,
    TITLE_TRUNCATED_PREFIX,
    TOUCH_FLOOR_PX,
    UNDER_FLOOR_PX,
    REASONS,
    DEFAULT_SCENARIOS,
    REPORT_KEYS,
    reason,
    describeReason,
    normalizeConfig,
    normalizeScenarios,
    classifySizes,
    touchSignature,
    panelSignature,
    hitSample,
    keyboardOf,
    classifyViewportChange,
    keyboardReport,
    normalizeViewportEvent,
    orientationOf,
    stateSignature,
    normalizeTouch,
    normalizeFloat,
    normalizeScenarioResult,
    normalizeState,
    buildReport,
    planClose,
    normalizeCleanup,
    scenarioLabels,
    scenarioEntryLabels,
    isReport,
    encodeTitle,
    decodeTitle,
    pollValue,
    waitFor,
    waitStable,
    summarize,
    clampInt,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
