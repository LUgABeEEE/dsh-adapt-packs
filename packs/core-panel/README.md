# core-panel · 第三方插件面板的手机下限

> 把 `移动适配-dsh-mobile补丁/` 里的通用层从**改宿主**迁成一张独立扩展包：触控命中高度下限、图标按钮宽度下限、窄屏宽度回收。不点名任何插件，不改 dsh-mobile 的 `lib/`。
>
> **2026-10-31 收口**：dsh-mobile 的 #319 已合入 main（尚未发布），宿主自己给插件面板 44px 高度地板与面板根宽度收口。本包因此按 **release / main 两条线**改写规则：0.8.x 上仍是唯一来源，宿主接管后对应规则自动退让（见 §2）。

- **目标插件**：无（`target: null` 的通配下限）。这是收录表里唯一被允许的通配例外，因此 `catalog.json` 里 `default: "off"`，由用户点名开启。
- **宿主**：真实运行时实测在 dsh-mobile **0.8.0**（390×844 粗指针，见 `实测-0.8.0-20261031.md`）；本机现已升级 **0.8.1**（含 #319 与 `7f4ea80` 的 `min-width:44`），但**装包后的 0.8.1 真实运行时仍未量**——0.8.1 的宿主规则以安装包源码为准（`lib/mobile-layout.js:459`、`:507`），host-probe 用注入的同一份规则做合成验证。
- **风险 / 状态**：`safe` / `experimental`。全是 CSS 下限 + 一个只写自己属性的 shim，不动插件 DOM 结构、不注入任何脚本到插件上下文。
- **回滚**：删掉 `$DSH_HOME/mobile-access/extensions/core-panel/` 即可（2s 内卸载）；本包不改任何已安装的 DSH 产物。

---

## 1. 它做什么

| # | 规则 | 生效条件 |
|---|---|---|
| 1 | 插件面板内 `button` / `[role="button"]` / `select` / `input`（非 checkbox/radio）/ `textarea` 高度 ≥ 44px | 粗指针 + 面板打开 + **宿主没有 `data-dsh-panel`**（0.8.x 发布线） |
| 1b | `[role="switch"]` / `[role="checkbox"]` 是显式例外：只撤掉 44px 下限、保持插件自己的视觉尺寸（命中区交给控件自己的 label），见 §6 | 同 #1 |
| 2 | `button` / `[role="button"]` 宽度 ≥ 44px（svg-only 图标按钮） | 粗指针 + 面板打开；**0.8.0 需要本包，0.8.1 起宿主也给 `min-width:44`（`lib:507`），本条是与宿主同值的兜底** |
| 3 | ≤720px 上插件根不超出剩余宽度：主槽根节点 `max-width:100%` + `box-sizing:border-box` | ≤720px + 面板打开 + 宿主没有 `data-dsh-panel`（#319 起宿主已写等价规则） |
| 4 | 面板页底部让出 `env(safe-area-inset-bottom)` | ≤720px + 面板打开（宿主不提供；headless 里为 0，真机未验证） |

**版本门阀**：`data-dsh-panel` 是 dsh-mobile #319（main `6c50b13`）起宿主自己写在 `.dshm-main` 上的面板状态属性。本包用 `.dshm-main:not([data-dsh-panel])` 作门阀：

| 宿主 | 高度地板（#1） | 宽度下限（#2） | 宽度回收（#3） | 数据来源 |
|---|---|---|---|---|
| 0.8.0（发布线，**不在**包里） | **本包提供**（唯一来源） | 本包提供 | 本包提供（无触发场景） | 真实运行时实测 |
| main #319（未发布） | 宿主提供 → 本包退让 | 本包提供（宿主没有） | 宿主提供 → 本包退让 | #319 merge diff【推断】 |

**面板状态不用 `:has()`，也不用宿主的属性。** `mobile.js` 用 `MutationObserver` + `requestAnimationFrame` 节流，在外壳 `.dshm-main` 上写 **本包自有** 的 `data-dshm-adapt-panel="1|0"`；CSS 只认这个属性。部分 WebView 没有 `:has()`，第一版补丁在真机上因此整体失效过。之所以不写 `data-dsh-panel`：那是宿主 #319 起自己维护的状态，两个写入方会互相覆盖（见 §5）。

**为什么不注入 `<style>`**：扩展运行时会把 `mobile.css` 自动注入成 `<style data-dsh-mobile-extension-style="core-panel">`（dsh-mobile `src/client.ts`）。`mobile.js` 只写属性和 CSS 变量，所以重复 `activate` 不会产生第二个 `<style>` 节点。重复激活会先执行上一代的 cleanup，observer / rAF / resize 监听不会叠加。

## 2. opt-out 的语义

opt-out 是**面板级**开关：只要主槽 `[data-slot="main"]` 的**子树**里出现 `data-dsh-adapt="off"`，或者主槽 / 外壳祖先（`.dshm-mainContent`、`.dshm-main`、`body` …）带这个属性，shim 就把整个面板状态写成 `data-dshm-adapt-panel="0"`。CSS 的所有规则都只在 `"1"` 下命中，所以 opt-out 是「关掉面板状态」而不是「再用一套规则覆盖回去」：

- 按钮/输入回到插件自己的 28/32px；
- 图标按钮宽度回到 28px；
- 底部安全区也不再追加。

为什么对整棵子树求值：插件经常在 `[data-slot="main"]` 与真正的面板之间再包一层，也可能一次渲染多个根；只认「第一个直接子元素」会让 `off` 静默失效（评审 F3）。代价是：任意后代自己写的 `off` 也会关掉整张面板——这是刻意的面板级语义，不给单个控件开小灶。

opt-out 可以在页面生命周期里切换，`data-dsh-adapt` 的属性变化也在 observer 范围内。

**0.8.1 起注意**：宿主自己的面板地板也以 `data-dsh-adapt="off"` 为门阀（`lib/mobile-layout.js:507`），所以 `off` 会**连宿主地板一起关**，结果可能比「不装包」更差（t12 实测：Context Insights min 44→19.8、<44 0→115）。只关本包请卸载/停用扩展，不要用这个属性。


**注意**：本包的 CSS 与 shim 是同一个状态开关。只加载 `mobile.css` 而没有 `mobile.js` 时，`data-dshm-adapt-panel` 永远不会被写上，规则整体不生效（这是刻意的：没有状态就没有适配）。宿主自己写 `data-dsh-panel` 时，本包的高度地板/宽度回收本来就会退让。

**升级注意**：0.1.0 的旧 shim 也写宿主的 `data-dsh-panel`。升级时必须 CSS 与 JS 一起换（扩展是整目录替换，正常 `install`/覆盖不会出现半套）；如果只换了 `mobile.css`、旧 shim 还在写 `data-dsh-panel`，新 CSS 会把它误当「宿主已接管」而退让。用 `--inject` 在**已装旧扩展**的页面上试新包时也会撞到这个现象。

## 3. 用到的宿主标记（债务登记）

| 标记 | 用途 | 登记位置 |
|---|---|---|
| `.dshm-main` | 写 `data-dshm-adapt-panel`、读宿主的 `data-dsh-panel`（门阀） | `catalog.json` → `usesHostMarkers` |
| `.dshm-mainContent` | 底部安全区 | 同上 |
| `[data-slot="main"]` | 面板内控件 / 面板根的作用域 | 同上 |
| `.dshm-panelNav` / `.dshm-panelBack` | 判断「面板打开」 | 同上（`panelBack` 是同义的备用判据） |

`.dshm-*` 是 dsh-mobile 的内部类名，没有公开契约。任一标记消失，这张包就会失效，CI（`tools/check-pack.mjs`）对 DOM 快照做存在性断言时会红到具体标记，不是静默失效。

## 4. 与上游意图的显式偏离（rail-clearance 已退役）

旧版本在 ≤720px 推 56px 让开折叠轨道（与外壳「保持覆盖」的意图不同）。**2026-10-31 实测后删除**：

- 390×844 面板态下，抽屉是 `data-right-modal` → `display:none`（实测抽屉宽 0），`--dshm-rail` = 0px，让位量乘 0；
- 768×1024 下宿主已经 `margin-left:56px` 让位（`lib/mobile-layout.js:437`，721–899 段），本包的 `@media (max-width:720px)` 根本不命中；
- 两种尺寸下面板左右缘完全一致（0…390 / 56…768），**没有可测量的让位场景**。

因此 `rail-clearance` 能力、`--dshm-rail` 变量与 `measureRail()` 一起移除，`catalog.json` 不再声明该能力。若将来某个宿主在手机上真的露出 56px 轨道且不让位，应当作为新证据重新提案，而不是复活一条没人测到的规则。

## 5. 与宿主 #319 的关系（撞名与退让）

#319（merge `6c50b13`，2026-10-31T08:46Z 合入 main；v0.8.0 发布于 10-30T03:14Z，包里没有）做的是：

- `.dshm-main` 上写 `data-dsh-panel="1|0"`（`activePanelId` 是否为空）；
- 面板内 `button` / `[role="button"]` / `select` / 单行 `input` / `textarea` 在粗指针下 `min-height:44px`；
- 面板根 `max-width:100%;box-sizing:border-box`；面板态 `.dshm-main` / `.dshm-mainContent` `overflow-y:auto`；
- 面板根 `data-dsh-adapt="off"` 是宿主的 opt-out。

本包的处置：

| #319 的东西 | 本包 |
|---|---|
| 写 `data-dsh-panel` | **不写**，改用自有 `data-dshm-adapt-panel`；宿主的属性只读（CSS 门阀 + shim 不碰） |
| 44px 高度地板 | 只在 `:not([data-dsh-panel])` 分支保留（0.8.x 兜底）；宿主接管后不叠加 |
| 面板根宽度收口 | 同上，只作 0.8.x 兜底 |
| 面板态滚动 | 本包不做（`floaters` 因自身需要而做，见那张包的说明） |
| `min-width:44`（图标按钮） | **保留**：0.8.0 上确实需要；0.8.1 起宿主同值（`lib:507`），所以不再算「宿主没有的独有贡献」 |
| 底部安全区 | **保留**：宿主不提供 |

`check-pack` 对声明了门阀的包额外跑一遍 **host-probe**：先伪造宿主只写 `data-dsh-panel`，断言 shim 不改写它、每个控件的 computed `min-height` 回到无包基线、且不小于基线；再注入 0.8.1 宿主地板（`lib:504-513` 的同一份规则），断言每个受覆盖控件仍 ≥44px。这只是合成夹具，不能替代 0.8.1 的真实运行时。

## 6. 代价与边界

- **`!important` 会压过插件自己的紧凑设计**（只在 0.8.x 分支里）。插件若坚持 28px 行，只能在面板根再用 `!important` 反覆盖，或整体 `data-dsh-adapt="off"`。这是「通配下限」的代价，也是它默认关的原因。
- **开关/勾选不放大视觉**：`[role="switch"]` / `[role="checkbox"]` 只撤掉 44px 下限（`min-height/min-width: 0 !important`），保持插件自己的 24/20px 视觉；命中区交给控件自己的 label / 外层可点区域。理由：用伪元素硬扩命中区会覆盖开关自己的 `::before/::after`（轨道/旋钮）。
- **两个写入方已分开**：旧版 shim 写 `data-dsh-panel`，在含 #319 的宿主上会与宿主抢写；现在本包只写自有属性，宿主的状态归宿主（host-probe 断言会守住这一点）。
- **只覆盖粗指针 + 面板打开**：桌面/鼠标不变；没有 `.dshm-panelNav` 的会话页不变。
- **不碰弹层**：portal 到 `<body>` 的 `[role="dialog"]` 不在范围内；DSH 自己的设置页也是 `role="dialog"`，上一版补丁在这里把开关撑成大方块后已撤销。
- **不改排版/字号**：dsh-mobile 自己已对输入框字号用 `font-size: max(16px, …) !important`，本包不重复设置，避免和插件排版打架。
- **宽度回收与安全区在 0.8.0 上是「规则在、场景没有」**：面板态 390/390、768/768 无溢出；`env(safe-area-inset-bottom)` 在 headless 里是 0。两者都算未验证收益，不是已量到的修复。
- 真机仍待验证：拇指准确度、真实 `env(safe-area-inset-*)`、软键盘后的可视区、惯性滚动。`catalog.json` 的 `verifiedWith` 记录的是目标基线 0.8.0，不代表真机已验收。

## 7. 验证

```bash
node tools/check-pack.mjs packs/core-panel --desktop
```

实测（fixture，读真实盒模型）：

| 指标 | 基线 | 装包后 | opt-out |
|---|---|---|---|
| 按钮高度 | 28px | **44px** | 28px |
| 图标按钮 | 28×28 | **44×44** | 28×28 |
| 输入高度 | 32px | **44px** | 32px |
| 下拉高度 | 32px | **44px** | 32px |
| 面板左缘 | 0px | 0px（rail 已退役） | 0px |
| 面板右缘 | 390px | **390px** | 390px |
| 1280×800 桌面 | — | 逐项等于基线（`--desktop` 严格零回归） | — |
| 宿主自管状态（host-probe） | — | 按钮/输入回 28/32、图标按钮仍 44、宿主属性未被改写 | — |

静态层同时断言：`extension.json` 恰好 5 字段、`id === core-panel`、全部 7 条选择器落在 `[data-dsh-panel]` / `[data-dshm-adapt-panel="1"]` / `(pointer: coarse)` / `[data-dsh-adapt="off"]` 作用域、无第三方类名、无 `:has()`、无 `@import`。

## 8. 真实运行时（dsh-mobile 0.8.0，2026-10-31）

| 观察项 | 纯宿主 | 只开 core-panel |
|---|---|---|
| 主槽控件 / <44px | 94 / **94**（最小 20px） | 94 / **41**（抬起 53 个；最小命中仍是 20px，未达标的控件类型 t1 未定性） |
| 图标按钮（fixture 口径） | 28×28 | **44×44** |
| 面板根 | 0…390 | 0…390（不变） |
| `--dshm-rail` | 无 | 0px（rail 已删除，历史值） |
| 横向溢出 | 无 390/390 | 无 390/390 |

测量口径：真实网关 `https://192.168.1.11:3443`，`--open Plugins`，settle 2500ms；纯宿主用请求拦截扩展资源得到（副作用是宿主弹出 “Mobile customization could not be loaded” 提示条）。完整原始数值与命令见工作区 `实测-0.8.0-20261031.md`。

## 9. 与补丁的关系

本包是 `移动适配-dsh-mobile补丁/` 通用层的迁移目标，但**不是逐行复制**：

| 补丁 | 本包 |
|---|---|
| 改 `lib/mobile-layout.js`（安装即改产物） | 扩展目录，删目录即回滚 |
| 一个 IIFE 往 `<head>` 注入 `<style>` | CSS 由扩展运行时注入，`mobile.js` 不创建 style |
| 让位用 `margin-left`（推 56px 轨道） | 已退役：0.8.0/768 上都没有可测场景（§4） |
| 返回栏按钮、抽屉侧栏、reduced-motion | 未收录：返回栏/抽屉是宿主 UI（`shell-chrome` 单独管）；reduced-motion 归宿主 |
| 开关/勾选的视觉复位 | 已迁移：`[role="switch"]` / `[role="checkbox"]` 撤掉 44px 下限，保持原视觉；命中区交给控件自己的 label |
| 通配且默认生效 | 通配但 `default: "off"`、可逐页 opt-out |

补丁等价性实测通过后，再按设计文档 §8 退役补丁；本任务不触碰 `移动适配-dsh-mobile补丁/`。
