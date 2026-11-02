# device-verify · 真机移动页自动测量（v2）

把「打开侧栏 → 进各个面板 → 量触控尺寸/命中/浮动控件 → 退出来」这套动作从 adb 盲点升级成一个可复用工具：
场景可配置、等待靠轮询、结果是一份结构化 JSON，能通过 `adb reverse` 直接拉回宿主机，不再只能读截图。

v2 与 v1 的差别一句话：**v1 是「一条脚本 + 一张截图」，v2 是「一组场景 + 一份报告」**。

- 工具目录：`tools/device-verify/`
- 产物目录（gitignore）：`.cache/device-verify/`
- 不装扩展、不改 DSH 设置、不重启网关；唯一会碰宿主的是 `overlay on|off`（写 `<DSH_HOME>/mobile-access/mobile.js`，自带备份/还原）

---

## 1. 做什么 / 不做什么

做：

1. **场景化**：面板列表写在 `scenarios.json`，可增删（上下文洞察 / 待办 / 插件 / 记忆系统 …），每个场景独立产出 `{ name, panel, touch, hit, optOut, floaters, … }`；
2. **稳定等待**：固定 `sleep` 全部换成轮询 —— 等 `.dshm-shell` 挂载、等侧栏入口、等面板标记、等主槽控件数稳定；失败给出**原因码**，不猜；
3. **可导出**：报告同时放进 `document.title`、覆盖层里的可复制 `textarea`、可选 `POST` 到宿主 sink，外加 `localStorage` 兜底；
4. **键盘与旋转**：同一份报告里带 `innerHeight/visualViewport/floaters` 的键盘前后对比，以及旋转/尺寸变化的状态时间线；
5. **自测**：`node --test` 单测 + 无浏览器的 `--offline` 冒烟 + 可选的真实页面 headless 冒烟。

不做：

- 不判断「通过/不通过」。工具只给数值和原因，判读留给人（和 `check-pack` 的静态断言）；
- 不重启 App、不改设备设置（除了 `rotate` 显式改旋转）、不点盲坐标；
- 不替代真机：headless 冒烟没有软键盘、WebView、safe-area，只能证明流程和导出通路可用。

---

## 2. 前置条件

| 需要 | 说明 |
| --- | --- |
| adb | 默认 `/data/agent/tools/android/platform-tools/adb`，用 `ADB=` 覆盖 |
| 已配对的 dsh-mobile 专用页 | 手机 App 或浏览器都可；网关默认 `https://<lan-ip>:3443` |
| `DSH_HOME` | 默认 `~/.dsh`；`overlay on` 写 `<DSH_HOME>/mobile-access/mobile.js` |
| Node ≥ 20 | 只用标准库；`report/smoke` 不需要额外依赖 |
| （可选）playwright | 只有真实页面冒烟用，复用 dsh-ui-lab 的 `node_modules/playwright` |

---

## 3. 快速开始

```bash
cd dsh-adapt-packs

node tools/device-verify/run.mjs doctor          # 设备/DSH_HOME/覆盖层/reverse/sink 全查一遍
node tools/device-verify/run.mjs channels        # 三条导出通道在本机到底能不能用
node tools/device-verify/run.mjs scenarios       # 看当前场景表
node tools/device-verify/run.mjs overlay on      # 写入覆盖层（配置 + 库 + 页面脚本）
node tools/device-verify/run.mjs reload          # 重启 App 让 WebView 重新加载（--gesture 才是下拉刷新）
node tools/device-verify/run.mjs report --channel screenshot --wait 25
                                                 # 真机：等 pilot 跑完，截图取数（推荐）
node tools/device-verify/run.mjs overlay off     # 还原 mobile.js
```

只想「注入但不自动跑」时（真机键盘验证要用）：`overlay on --no-pilot` —— 覆盖层出现，但页面停在会话页，
场景由 `window.__dvRun()` 手动触发，这样手指点 composer 不会被 pilot 打开的面板挡住。

一次跑完（装 → 刷新 → 收 → 可选还原）：

```bash
node tools/device-verify/run.mjs run --reload --shutdown
```

真机（页面是 https）上 `run` 会自动落到 screenshot 通道：它先 `overlay on`、重启 App、等 25s 再截图，
并告诉你「读覆盖层顶部面板」——这是目前在 WebView 里唯一稳定可用的取数方式（原因见 §6）。

`report` 的产物（`.cache/device-verify/<serial>/<时间戳>/`）：

```
report.json      完整报告（缩进）
report.min.json  同一份，无缩进（方便 diff）
summary.txt      run.mjs 打印的摘要
report.png       --shot 时的截图
```

退出码：有场景 `status=failed`、或 `aborted != null`、或超时收不到报告 → `1`。

---

## 4. 场景配置

默认文件 `tools/device-verify/scenarios.json`，`overlay on` 会把它嵌进注入文件；覆盖方式：

```bash
--config my-scenarios.json          # 换整份配置
--scenarios todos,plugins           # 只跑这几条（名字不在表里就按名字现造一条）
--port 8799                         # 重写 sink 端口
--timeout 120 --poll-interval 150   # 单次等待超时 / 轮询间隔
--no-keyboard                       # 跳过键盘探针
--no-autostart                      # 注入后不自动跑，等手点（或 window.__dvRun()）
```

场景字段：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 报告里的键，重名只保留第一条 |
| `panel` | 否 | 面板标识，默认等于 `name`（目前只写进报告，便于和插件面板 id 对齐） |
| `labels` | 是 | 侧栏入口的候选文案；先按 `aria-label`/`title` 精确匹配，再按叶子文本，最后大小写不敏感 |
| `marker` | 否 | 预留：额外的「面板已打开」选择器；当前用宿主标记判定 |
| `optional` | 否 | `true` 时「找不到入口」记为 `skipped`，不算失败（例如没装某个插件） |

顶层字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `autoStart` | `true` | 注入后自动开跑 |
| `startDelayMs` | `2500` | 自动开跑前的等待（页面脚本装载） |
| `pollIntervalMs` | `120` | 轮询间隔 |
| `timeoutMs` | `9000` | 单次等待上限（面板打开、控件稳定等） |
| `settlePolls` | `3` | 连续多少次采样一致才算「稳定」 |
| `settleWindowMs` | `900`（仓库配置里 `2000`） | 稳定判定的最短观察窗口：面板内容常常是异步/虚拟列表，第一次「连续一致」可能只是半渲染。真机上还额外做一次 400ms 后的复核 |
| `closeTimeoutMs` | `1200` | 单条关闭策略的尝试时长，超时换下一条 |
| `allowHistoryBack` | `true` | 是否把 `history.back()` 作为最后手段（会翻页，谨慎） |
| `hitCheckLimit` | `200` | 最多对多少个控件做命中探针（其余只计尺寸） |
| `titleMaxChars` | `20000` | `document.title` 里的报告上限，超出改为截断前缀 |
| `maxStates` | `40` | 状态时间线长度上限 |
| `keyboardProbe` | `true` | 跑完场景后做一次键盘前后测量 |
| `keyboardProbeSelectors` | 主槽 `textarea` / `input[type=text]` / `contenteditable` | 键盘探针的候选输入框 |
| `hideDuringMeasure` | `false` | 测量窗口内隐藏覆盖层（截图里更干净，但看不到矩阵） |
| `sinkUrl` | `http://127.0.0.1:8799/report` | 报告 POST 目标；`null`/`"off"` 关闭 |

「记忆系统」这类行文案没有稳定依据，默认标 `optional`；装了什么插件、侧栏叫什么，用 `scenarios` 命令和 `report.json` 里的 `detail.labels` 去核对。

---

## 5. 报告结构（`schema: "dsh-device-verify/2"`）

顶层：

| 字段 | 内容 |
| --- | --- |
| `schema` / `version` | `dsh-device-verify/2` / `2` |
| `at` / `durationMs` | 开跑时间（ISO）/ 总耗时 |
| `started` | 是否真的跑过（`false` 表示没等到页面） |
| `aborted` | `{ reason, scenario, message }`；只有 `page-not-loaded` / `overlay-error` 会中断整轮。关闭失败（`panel-not-closeable`）**不中断**：它只让该场景记失败并触发 `cleanup()` |
| `env` | `url, ua, dpr, screen, inner, visual, safe, shell, orientation, overflow` |
| `keyboard` | 见 §7 |
| `rotation` | `{ orientation, screenOrientation, inner, visual, at }` |
| `states` | 状态时间线：`boot / panel:<name> / after:<name> / keyboard-* / resize / 手动 mark`，每条含 `inner/visual/floaters/panel/overflow/keyboard` |
| `scenarios` | 场景结果数组 |
| `config` | 本次生效的配置摘要（含被丢弃的场景） |

单个场景：

```jsonc
{
  "name": "plugins",
  "panel": "plugins",
  "status": "ok",              // ok | skipped | failed
  "reason": null,              // 见 §8 的原因码
  "ok": true,
  "ms": 3120,
  "touch": { "count": 141, "min": 44, "under44": 0, "checked": 141, "miss": 0, "samples": [], "floor": 44 },
  "hit":   { "checked": 141, "miss": 0, "samples": [] },
  "optOut": { "applied": true, "changed": true, "reason": null, "touch": { "count": 141, "min": 14, "under44": 141 } },
  "floaters": { "raw": "1", "attr": "1", "applied": true },
  "overflow": false,
  "nav": [48, 48],             // 面板返回栏按钮高度
  "drawerRows": [56, 56, …],   // 抽屉打开时的行高（取开抽屉那一刻）
  "panelOpen": false,
  "waitedMs": 640,             // 等面板打开花了多久
  "detail": { "clicked": "label", "label": "插件" }
}
```

口径（和 `check-pack` / `docs/收录标准.md` 一致）：

- `touch`：主槽 `[data-slot="main"]` 里所有可见的 `button / [role=button] / input / select / textarea`，取 `min(width, height)`（CSS px，保留 1 位）；`under44` 统计 `< 43.5`（44 的四舍五入容差）；`floor` 恒为 44。
- `hit`：对每个控件在中心 + 上/下/左/右各 20px 共 5 个点做 `elementFromPoint`，命中数 < 实际探针数即记一次 `miss`；
  `samples` 留最多 6 条现场字符串，**每个 miss 点单独记录坐标与被谁挡住**（F7，之前只记中心点，4/5 的样本无法定位）：
  `button 44x44 4/5 miss=left(20,30)→div.dshm-drawer[data-slot=sidebar]` —— 格式是
  `<tag> <w>x<h> <命中>/<探针> miss=<方位>(<绝对坐标>)→<遮挡元素>`，方位是 `center/left/right/top/bottom`，
  遮挡元素给出 tag + id + 前两个 class + `data-slot`。多个 miss 用空格分隔。
  覆盖层本身不干扰命中：整体 `pointer-events:none`，且默认 `hideDuringMeasure: true` —— 否则我们自己的 JSON 复制框会盖住页面顶部控件（v2 早期实测到 `textarea#dsh-verify-json`，已修）。
- `optOut`：切 `html[data-dsh-adapt="off"]` 后再测一遍，再切回；`changed` 表示 `count/min/under44` 有任一变化，没变化记 `opt-out-no-effect`。
  **注意 `optOut.touch.count` 可能和 `touch.count` 不同**：面板里若是虚拟滚动列表，行高变了会渲染出不同数量的行（实测 todos 面板 44px 时 13 个、原生高度时 77 个），所以跨态比较请看 `min` 和 `under44 占比`，不要直接比绝对条数。
- `floaters`：`--dshm-floaters` 的计算值 + `html[data-dsh-floaters]` 属性（包是按 `"1"` 生效的），`applied` = 属性为 `"1"`。
- `overflow`：`documentElement.scrollWidth > clientWidth`（横向溢出）。

---

## 6. 报告怎么取回宿主机

四条通道。`run.mjs report --channel auto|sink|logcat|screenshot` 决定用哪条（默认 `auto`：谁先到用谁）。

1. **sink POST**：`overlay on` 默认把 `sinkUrl` 写成 `http://127.0.0.1:8799/report`；`run.mjs report` 在宿主机监听同一端口并建立 `adb reverse tcp:8799 tcp:8799`，页面的 `fetch` 打到宿主机。页面是 https、目标是 `http://127.0.0.1`，`adb reverse` 让它指向宿主机而不是手机自己。
   *实测提醒*：headless Chromium（及部分新版 Chrome 的本地网络策略）会拒绝这种 https→http loopback 请求（页面里表现为 `sink failed: Failed to fetch`）。这时 `report` 会落到下一条通道，不会干等。
2. **logcat（不依赖网络，推荐给真机）**：覆盖层把报告按 900 字符一段做 base64，用 `[dsh-verify] REPORT-BEGIN n bytes` / `REPORT <i> <chunk>` / `REPORT-END` 打到 `console`；Android WebView 会把 console 转进 logcat，于是 `adb logcat -d` 就能取回整份 JSON，不需要 reverse、不需要 devtools。`report` 每 1.5s 读一次 `adb logcat -d -t 3000` 并拼装；`decodeLogcat()` 会校验分片数、base64、JSON 与 `schema`，缺片直接报 `chunks-missing`。
3. **`document.title`**：`DVJSON:` + 压缩 JSON；超过 `titleMaxChars` 改成 `DVJSON-TRUNCATED:` + 前 N 个字符。headless 冒烟和 `run-lib.decodeTitle()` 直接读这个。
4. **覆盖层里的可复制区域 + `localStorage`**：面板底部是只读 `textarea`（完整 JSON）和 `Copy JSON` 按钮，真机长按/全选即可；`localStorage["dsh-device-verify:last"]` 作为重载后的兜底。

### 6.1 真机上的真实可用性（2026-11-02 实测，Xiaomi Pad 9 Pro Max）

| 通道 | 浏览器/headless | 真机 WebView（https 页面） | 依据 |
| --- | --- | --- | --- |
| **screenshot**（覆盖层文本 + 截图） | 可用 | **可用，真机首选** | `report --channel screenshot`；截图见 `docs/工具-真机修复-20261102.md` |
| sink POST | 可用（headless 另说） | **不可用**：https 页面 → `http://127.0.0.1` 被混合内容策略拦截（页面里 `sink=failed:fetch`） | 覆盖层 `export` 行；`run.mjs channels` |
| logcat | 不适用 | **本机不可用**：App/WebView 没有把 console 转到 logcat（pilot 跑完时 `adb logcat` 里 `[dsh-verify]` 行数为 **0**） | `run.mjs channels`、`adb logcat -d | grep -c dsh-verify` |
| document.title | 可用（`page.title()`） | 读不到：adb 没有 CDP，也没有取标题的命令 | — |
| 复制 textarea | 可用 | 可人工长按复制；**没有** adb 剪贴板命令（`cmd clipboard` 在 Android 17 上返回 `No shell command implementation`） | 实测 |

所以真机取数流程是：

```bash
node tools/device-verify/run.mjs overlay on      # 或 run --reload
node tools/device-verify/run.mjs reload          # 重启 App 触发页面重新加载
node tools/device-verify/run.mjs report --channel screenshot --wait 25
# 打开输出的 PNG，读覆盖层顶部面板：
#   ok  <场景>: n=… min=… <44=… hit=… opt=<44=… flo=… ovf=… close=<策略> …ms
#   cleanup ok=… panelOpen=…      export title=… sink=… logcat=…
```

sink 要能用，需要 HTTPS 端点或与页面同源的地址（另起一个 https 反向代理也可以）；logcat 要能用，需要 App 侧
`WebChromeClient.onConsoleMessage` 真的转发到 logcat —— 这取决于 App 实现，本机实测不转发。

手动抓取（sink 不可用时）：

```bash
adb shell "run-as io.github.sayach.dshmobile ls"   # 一般读不到 WebView 存储，仅作排查
# 更实际：截图（面板顶部第一行就是摘要）
node tools/device-verify/run.mjs shot --label report
```

`report` 收不到报告时，会按顺序打印可能原因（覆盖层没装 / 页面没刷新 / reverse 没建 / 端口不一致 / App 在后台 / logcat 里没有匹配行），
并附 `adb reverse --list`、logcat 行数与覆盖层状态；如果 logcat 行数为 0，会直接写「本机 App 没有转发 console，请用截图通道」，
不会让人误以为 logcat 可用。开场还会先打印通道预检（`describeChannels`），https + http loopback 的组合会被当场点名。

---

## 7. 键盘与旋转

**键盘（实时判定，不是探针终态）**：`report.keyboard` **在每次生成报告时用当时的视口重新计算** ——
读 `innerHeight` / `visualViewport.height`，与「当前方向下见过的最高视口」baseline 比较：

- `open` = 高度缩小 ≥ `keyboardThreshold`（默认 80）**且**成因不是 `rotation`（旋转也会让高度掉 454px）也不是 `zoom`；
- `keyboard.innerDelta` / `visualDelta` 给出精确变化量，`keyboard.source` 说明成因（`keyboard` / `rotation` / `zoom` / `viewport-shrink` / `viewport-grow` / `resize` / `none`）；
- baseline 按方向分别记录（`baselineByOrientation`），所以竖屏 1314→841（Δ-473）与横屏 860→441（Δ-419）互不干扰；
- 页面里的 `focusin`/`focusout` 记下「当前是否有可编辑元素获得焦点」，用来区分「键盘」与「页面自己变矮」；
- **旧版行为已废弃**：以前 `probeKeyboard()` 在 pilot 末尾跑一次、结果写死进报告，手指事后弹键盘时报告仍是 `open=false`，与同屏 DV 行 `909x841` 自相矛盾。现在程序化 `focus()` 的结果只作为 `keyboard.probe` 诊断字段（Android 上它不会弹 IME），永不决定 `open`。

同一份报告还有 **`viewportEvents` 时间线**：每次 `resize` / `visualViewport.resize` / `orientationchange` 都记一条
`{at, phase, trigger, source, inner, visual, deltaInner, deltaVisual, orientation, editableFocused}`，
所以「什么时候变的、变了多少、为什么」都能回看，不必只看终态。

真机键盘验证步骤（**必须真手指或 swipe-as-tap**）：

```bash
node tools/device-verify/run.mjs overlay on
node tools/device-verify/run.mjs reload                        # 重启 App，等 pilot 跑完（约 25-45s）
node tools/device-verify/run.mjs ime status                    # 期望 shown=false
node tools/device-verify/run.mjs tap --finger --x 952 --y 1510 # 极短滑动 = 真手指语义
node tools/device-verify/run.mjs ime status                    # 期望 shown=true
node tools/device-verify/run.mjs shot --label keyboard-open    # 读覆盖层 keyboard 行
```

`--finger` 会把点击实现成 `input swipe X Y X Y+1 120`；**`input tap` / `input motionevent DOWN/UP` 在 Android 17 +
WebView 150 上只会产生 focusin→focusout，不弹 IME**（Pad 9 Pro Max 实测），这也是旧报告一直 `open=false` 的原因之一。
坐标要按当前方向、按物理像素给（`wm size`，竖屏 2272×3408、DPR 2.5），先从截图里量出 composer 的位置。

旧版探针的输出（保留兼容）：

```jsonc
"keyboard": {
  "open": true,                  // 实时视口缩短 ≥ 80px，且不是 rotation/zoom
  "threshold": 80,
  "baseline": { "inner": 1314, "visual": 1314 },
  "current":  { "inner": 841,  "visual": 841  },
  "innerDelta": -473,            // 竖屏实测值
  "visualDelta": -473,
  "source": "keyboard",          // keyboard | rotation | zoom | viewport-shrink | viewport-grow | resize | none
  "keyboardLike": true,
  "editableFocused": true,       // 最近一次 focusin 是否落在可编辑元素上
  "at": "2026-11-02T06:03:24.773Z",
  "probe": { "target": "div Describe what you want to build…", "focused": true, "reason": null },
  "lastEvent": { "source": "keyboard", "deltaInner": -473, "trigger": "visualViewport", "…": "…" }
}
```

判读要点：Android WebView 是 `adjustResize`，键盘直接缩 **layout viewport**（**用户真手指实测**：竖屏 1314 → 841 = **473**、
横屏 860 → 441 = **419**，`mInputShown=true`），`innerDelta` 与 `visualDelta` 通常相同；iOS 上更常见的是只缩 `visualViewport`，
两种都会判 `open`。这两个数字是「键盘真的弹出时视口应该掉多少」的基准；工具侧只要键盘弹出就会算出同样的 delta
（机制已用 headless `page.setViewportSize` 复现：844→444 → `open=true, innerDelta=-400, source=keyboard`）。
**本仓库尚未留下「工具在真机上读到 473/419」的截图**：adb 点击在本机页面里点不开 composer（`mServedInputConnection=null`），
需要持机人用真手指点一次，按上面 5 条命令抓一张 `keyboard-open` 截图即可补齐。
headless 里不会弹 IME，所以真实页面冒烟默认 `open=false`；要验证机制用 `smoke.mjs --keyboard-test`，
它用 `page.setViewportSize()` 模拟 adjustResize 并断言报告立刻变成 `open=true`（实测 Δ-400、`source=keyboard`、`viewportEvents` +1）。

**旋转**：`run.mjs rotate 0|1` 改系统旋转；覆盖层监听 `resize` / `orientationchange` / `visualViewport.resize`，去抖 300ms 后追加一条 `resize` 状态并重发报告。旋转后**再跑一次 `report`** 就能拿到含横屏状态的最新报告（`states` 里两条不同的 `inner`，`rotation.orientation=landscape`）。

---

## 8. 等待与失败原因

**等待口径（F6）**：场景/面板内容相关的等待**全部是轮询**；仍保留少量固定延迟，列在这里免得被当成「全轮询」：

| 位置 | 值 | 为什么仍是固定值 |
| --- | --- | --- |
| `startDelayMs` | 2500ms | 注入后给扩展客户端模块挂载的时间（没有可靠事件） |
| `probeKeyboard` | 900ms / 500ms | 程序化 `focus()` 后等 IME 状态（本来也不弹）；保留用于诊断 |
| `scheduleResize` 去抖 | 300ms | 旋转/resize 事件风暴去抖 |
| `settleMainRoot` 复核 | 400ms | 稳定后再确认一次 |
| `measureOptOut` | 250ms 起 | opt-out 属性切换后等一次重排 |
| `smoke.mjs` | 2000ms | 报告已出现后留给 title/logcat 的收尾宽限 |
| `run.mjs report` 轮询 | 1500ms | 读 sink / logcat 的间隔（不是测量等待） |

v1 是「点完等 2.5s」，面板慢一点就量到空面板。v2 的两种等待：

- `waitFor(probe, accept)`：等到判定为真；
- `waitStable(probe, settlePolls, settleWindowMs)`：连续 `settlePolls` 次采样签名一致（签名 = 控件数 + 最小边 + `<44` 数 + 前 12 个尺寸），**且**已经观察了至少 `settleWindowMs`；
- 面板测量的签名**包含渲染文本长度**（`panelSignature`：控件尺寸 + `innerText` 长度，40 字符一桶），
  骨架屏被真实内容替换时文字量会跳变，只看控件数看不出来；
- 稳定后还有一次 **400ms 复核**，变了就重新等；`opt-out` 回程后再量一次控件数，变了就重测并在 `detail.remeasured` 标记。
  （真机上同一个 context-insights 面板出现过 `n=13 / 94 / 127` 三种值，就是「数据还没到」。）

实测教训：只看「连续 3 次一致」（3 × 120ms ≈ 360ms）会在插件面板还在填充时提前收工 —— 同一台设备、同一个 todos 面板，两次跑分别量到 `n=13` 和 `n=446`。加 900ms 观察窗口后稳定在最终值。

每个失败都带 `reason`，文案与处置建议定义在 `overlay-lib.js` 的 `REASONS`：

| reason | 含义 | 先查什么 |
| --- | --- | --- |
| `page-not-loaded` | 等不到 `.dshm-shell` / `[data-slot="main"]` | 连的是不是专用页？配对还在吗？ |
| `overlay-error` | 覆盖层自己抛错 | `report.json` 的 `aborted.message`、`adb logcat \| grep dsh-verify` |
| `sidebar-unreachable` | 抽屉展开不了（会依次试最多 3 个候选开关，每次 1.8s） | 侧栏 DOM 变了？`detail.attempts` 里有每个候选的 label/耗时 |
| `sidebar-row-missing` | 侧栏没有这个入口 | 插件没装（`optional` 记为 skipped）/ 文案变了 |
| `panel-not-opened` | 点了但没进面板 | 0.8.0 没有 `data-dsh-panel`，靠 `.dshm-panelNav` 兜底，两者都没有就说明没进去 |
| `panel-not-closeable` | 五条关闭策略全失败 | 宿主事件名改了吗？`detail.close.attempts` 里能看每条策略的耗时与错误 |
| `panel-not-closed` | **旧码**，只用于读历史报告（当前代码不再 emit） | 看新报告里的 `panel-not-closeable` |
| `unstable` | 控件数一直在变 | 虚拟滚动/骨架屏；调大 `timeoutMs` 或 `settlePolls` |
| `opt-out-no-effect` | 切了 `data-dsh-adapt=off` 尺寸没变 | 本来就没包在生效，或包的守卫不是这个属性 |
| `keyboard-probe-no-input` | 找不到可聚焦输入框 | 面板都关掉、回到对话页 |
| `sink-failed` | POST 失败 | `report` 在跑吗、reverse 建了吗、端口一致吗 |
| `title-truncated` | 报告超出 title 上限 | 用 sink / 复制区域 |

### 8.1 关闭面板：五条策略 + 收尾复位

平板（≥900px）上宿主**不渲染 `.dshm-panelNav`**（0.8.1 `mobile-layout.js:680` 的 `!wideViewport` 分支），
所以「点返回栏」在平板上必然失败。v2.1 把关闭做成按顺序试的策略链，每条之后都轮询 `data-dsh-panel` 直到变成 `0`：

| 顺序 | 策略 | 触发条件 | 依据 |
| --- | --- | --- | --- |
| 1 | `panelNav-back` | 存在 `.dshm-panelNav` 且按钮未 disabled | 窄屏（<900px）正常路径 |
| 2 | `native-back-event` | 总是尝试 | 宿主自己在 `window` 上监听 `dsh-mobile:native-back` 并 `selectPanel(null)`（0.8.1 `mobile-layout.js` 的 `onNativeBack`）——**平板唯一可用路径** |
| 3 | `sidebar-toggle` | 侧栏里能找到同名入口 | 点同一个入口再切换一次 |
| 4 | `escape-key` | 总是尝试 | document/window 上派发 `Escape` keydown/keyup |
| 5 | `history-back` | `allowHistoryBack` 且 `history.length > 1` | 最后手段，可能翻页 |

- 每条策略的尝试与耗时写进 `scenario.detail.close.attempts`，生效的那条写进 `detail.close.strategy`；
  覆盖层每行也会显示 `close=<策略>`，截图就能看到（真机实测：四个场景全部 `close=native-back-event`）。
- 全部失败才报 `panel-not-closeable`；这时**不再中止整轮**——记录该场景失败、执行一次 `cleanup()`，然后继续后面的场景，
  这样一次运行仍然能拿到其余场景的独立结果。
- 无论成功还是中止，结束时都会执行 `cleanup('end-of-run')` 并写进报告：

```jsonc
"cleanup": { "ok": true, "cause": "end-of-run", "panelOpen": false, "drawerOpen": false,
             "optOutRestored": true, "attempted": [{ "step": "close-panel", "ok": true, "strategy": "native-back-event" }] }
```

`cleanup` 做三件事：把 `html[data-dsh-adapt]` 恢复成**开跑前的值**（不是简单删除）、关闭残留面板（走同一条策略链）、
收起我们打开的抽屉；`ok` 只在这三项都达成时为 `true`。
`cleanup` 允许 `state.currentScenario === null`（pilot 收尾时就是 null）：关闭策略改用「配置里所有场景的入口」做兜底，
不再读 `null.labels`（F1 回归，单测 `cleanup survives currentScenario = null while a panel is still open` 覆盖）。

`aborted` 只在这些情况下中断整轮：`page-not-loaded`、`overlay-error`（关闭失败不再属于中止原因）。

---

## 9. 0.8.0 vs 0.8.1（直接影响判读）

依据：本机 `/data/agent/.dsh/profiles/web/node_modules/dsh-mobile`（**0.8.1**）与
`/data/agent/workspace/dsh 手机应用/backup-dsh-mobile-0.8.0-20261101/dsh-mobile`（**0.8.0**）。

| 项 | 0.8.0 | 0.8.1 | 对 device-verify 的影响 |
| --- | --- | --- | --- |
| 主槽粗指针 44px 地板 | 无（备份里 `data-dsh-panel` / `pointer:coarse` / `text-size-adjust` 共 0 处） | 有：`lib/mobile-layout.js:504` `@media(pointer:coarse)`，`:507` 给面板内控件 `min-width/min-height:44px!important` | 0.8.1 上「不装包也应有 44px 地板」；测到 `<44` 要么是排除项（switch/range/嵌套 opt-out），要么真漏了 |
| 面板打开标记 | 无 | `.dshm-main[data-dsh-panel="0\|1"]`，见 `:679` | 0.8.1 用属性判面板；0.8.0 只能靠 `.dshm-panelNav` 是否存在 → 覆盖层两者都认 |
| WebView 字体放大 | 无 | `.dshm-shell{-webkit-text-size-adjust:100%}`，`:409` | 0.8.0 上插件行盒可能被字体放大撑破，`overflow` 结论不要跨版本套用 |
| opt-out 语义 | 包自己的 `:root:not([data-dsh-adapt="off"])` 守卫 | 宿主也认这个属性：根级 opt-out 连 pane 几何一起还原；嵌套 opt-out 只保留该控件原生尺寸（`:505-508` 的 `:not([data-dsh-adapt="off"] *)`） | 0.8.1 上 `optOut.changed` 通常为 `true`（宿主地板也失效）；0.8.0 上变化完全取决于装了哪个包 |
| 返回栏按钮 | `.dshm-panelNav` 第一个按钮，抽屉打开时 `disabled` | 同上，另有 `.dshm-panelBack`（`:449`，`min 48px`，`:452` 有 `:disabled` 样式） | `closePanel()` 先关抽屉再点返回；0.8.0/0.8.1 都适用 |

结论：**0.8.0 与 0.8.1 的 `touch.under44` 不能横向比较**。0.8.0 上数字反映「包给了什么」，0.8.1 上反映「宿主地板 + 包」的叠加结果，而 `optOut.touch` 才近似 0.8.0 的基线。

---

## 10. 自测

```bash
# 单测：库/驱动/注入文件/logcat 编解码/关闭策略/稳定签名/键盘判定/cleanup-null（无需 adb、浏览器、手机；43 项）
node --test tools/device-verify/test/unit.test.mjs

# 免浏览器冒烟：组装注入文件并检查可解析、报告可往返
node tools/device-verify/smoke.mjs --offline

# 真实页面冒烟：复用 dsh-ui-lab 的配对缓存，headless 打开真移动页并跑完整 pilot
node tools/device-verify/smoke.mjs --gateway https://192.168.1.11:3443 --timeout 180
```

加 `--no-pilot` 会验证「注入但不自动跑」：注入后断言页面停在 `idle (--no-pilot)`，再由 harness 调 `window.__dvRun()` 启动 pilot。

加 `--keyboard-test` 会额外做一次「键盘机制」验证：把视口从 844 缩到 444（等价 adjustResize），
断言 `window.__dvReport.keyboard` 变成 `open=true`、`innerDelta=-400`、`viewportEvents` 增加，产物 `keyboard-test.json`。

真实页面冒烟产物在 `.cache/device-verify/smoke-<时间戳>/`：`report.json`、`mobile.png`、`console.log`、`title.txt`。
失败时（连不上网关 / shell 没挂载 / evaluate 抛错）会写 `diagnostics.json`（`phase/url/error/hint/consoleLines`）并截图，
不再是空目录 + 一段栈；网关不可达会在启动浏览器前就被 `probeGateway` 拦下（F2/F5）。
它**不写 `DSH_HOME`**（注入走 `page.addScriptTag`），也不启停网关；失败时写出 `diagnostics.json` 说明 shell/覆盖层/页面错误。

---

## 11. 边界 / 未验证

1. **headless ≠ 真机**：没有软键盘、WebView 渲染差异、safe-area（headless 里 `env(safe-area-inset-*)` 全 0）。键盘相关结论必须在真机上确认。
2. **单机单系统**：真机结论目前只来自 Android WebView；iOS 完全未测。
3. **0.8.1 只做了源码级核对 + headless 页面冒烟**，没有在 0.8.1 真机上跑过；数字以现场 `report.json` 为准。
4. **面板入口文案**是本地化文本，插件改名就会 `sidebar-row-missing`；这是设计上的显式失败，不要把它当成宿主回归。
5. **`adb reverse` 依赖 USB**；同一 Wi-Fi 直连时把 `sinkUrl` 改成宿主机 LAN 地址也可以（页面是 https、目标是 http 会真的触发混合内容拦截，因此默认仍走 loopback）。
6. **`title` 渠道有上限**：`titleMaxChars` 超出即截断，完整数据只保证在 sink / 复制区域 / localStorage。
7. **命中探针只测 5 个点**（中心 + 四向 20px），能抓「视觉 44px 但可点区域更小/被遮挡」的典型回归，抓不到所有边界像素。
8. **logcat 通道在真机上不可用（已实测）**：Pad 9 Pro Max（Android 17 / WebView 150）在 pilot 跑完时 `adb logcat` 里
   `[dsh-verify]` 行数为 0 —— 这个 App 没有把 WebView console 转进 logcat。解码器本身有单测，换到会转发的 App 上才可能可用。
9. **sink 通道在 https 页面 + http loopback 时不可用**（混合内容），headless 与真机都观测到；真机取数请用 `--channel screenshot`。
10. **扩展挂载有时间差**：`data-dsh-floaters` 这类属性由扩展客户端模块异步写入，页面刚起来时可能还是 `-`。`env.floaters` 记下了开跑那一刻的值；真机上把 `startDelayMs` 留足（默认 2500ms），或先跑一次 `report` 再看，不要用首次结果判定扩展是否生效。
11. **键盘探针在平板上不弹 IME**：程序化 `focus()` 不会让 Android 弹软键盘（实测 `keyboard open=false inner=1314→1314`）。
   真机上要测键盘，得用真实点击把输入框点开：`adb shell input tap <输入框坐标>`；实测平板横屏一次真实点击后
   `innerHeight 860 → 441`（键盘约 **419px**）。
12. **`reload` 默认是重启 App**：WebView 没有地址栏，下拉刷新手势在平板上会点进 composer 并弹出键盘（实测），
   所以默认用 `am force-stop` + launcher 重启；只有显式 `--gesture` 才发下拉手势。

---

## 12. 本轮实测记录（2026-11-02，headless 真页面）

命令：`node tools/device-verify/smoke.mjs --gateway https://192.168.1.11:3443`
环境：HeadlessChrome 156 · 390×844 dpr=3 `hasTouch` · dsh-mobile **0.8.1** 真网关 · 4 个场景全绿，`durationMs≈12.7s`，报告 8.4KB，`document.title` 全文可解，logcat 通道 13 个分片。

| 场景 | n | min | <44 | opt-out `<44`（同一面板） | 命中 |
| --- | --- | --- | --- | --- | --- |
| context-insights | 6 | 44 | 0 | 6（min 17） | 6/6 |
| todos | 446 | 44 | 0 | 80（min 24） | 443/446 |
| plugins | 94 | 20 | **41** | 94（min 20） | 93/94 |
| memory | 11 | 44 | 0 | 2（min 28） | 10/11 |

- 4 个场景都走通了「侧栏入口 → 面板打开 → 稳定 → 量 → opt-out 对照 → 返回」；`memory` 是大小写不敏感匹配（`label-ci: Memory System`），说明 en locale 下配置可用。
- `plugins` 的 41 个 `<44` 在 opt-out 后变成 94 个 —— 宿主 0.8.1 的 44px 地板**确实生效**（`(pointer: coarse)` 在 headless 里匹配上了）；剩下 41 个应是地板排除的类型（`input`/switch/range 等，`:507` 的选择器只管 `button`/`role=button`/`select`）。**这一条是推断**，要按 `blocked-by`/标签逐个确认。
- 命中 miss 现在能归因：`blocked-by=img.dshwv-img`（插件图片压在按钮上）、`blocked-by=div.gt-inner`；57px 的折叠轨道只造成 1/5 边缘 miss。
- 反例记录（已修）：早期版本 `hideDuringMeasure=false` 时，覆盖层自己的 JSON 文本框会被记成遮挡物（`blocked-by=textarea#dsh-verify-json`），把顶部控件的 miss 全部污染。

### 12.1 真机平板（2026-11-02，Xiaomi Pad 9 Pro Max，0.8.1）

修复前（旧 v2 构建）：`context-insights` 量完后 `FAIL … panel-not-closed` → `ABORT=panel-not-closed`，后续场景不再执行。
修复后连续三次运行（每次 `overlay on` → `reload`（重启 App）→ `report --channel screenshot --wait 25~50`）：

| 场景 | n | min | <44 | opt-out `<44` | hit | close 策略 |
| --- | --- | --- | --- | --- | --- | --- |
| context-insights | 127 | 44 | 0 | 115 | 122/127 | `native-back-event` |
| todos | 446 | 44 | 0 | 79 | 444/446 | `native-back-event` |
| plugins | 94 | 20 | 41 | 94 | 88/94 | `native-back-event` |
| memory | 11 | 44 | 0 | 2 | 11/11 | `native-back-event` |

- 全部场景一次跑完，无 `ABORT`；结束时 `panel=0/closed`、`cleanup ok=true panelOpen=false`。
- 竖屏 909×1314（≥900 ⇒ 宽布局 ⇒ 无 `.dshm-panelNav`），正是修复要覆盖的场景。
- `export title=full 8310B sink=failed:fetch logcat=sent` —— sink 与 logcat 在真机上都拿不到（见 §6.1），截图是唯一可用通道。
- 截图（最终构建）：`.cache/device-verify/0983986009983540/2026-11-02T05-43-52-160Z/final-verified-3.png`。
- 稳定性：加固前同一 context-insights 面板出现过 `n=13`（数据未到）；加入文本长度签名 + 400ms 复核 + opt-out 回程重测后，
  稳定在 `127 / 446 / 94 / 11`。反面样本与过程截图见 `docs/工具-真机修复-20261102.md` §4。

