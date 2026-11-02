# dsh-context-mobile · 上下文/成本面板的触控下限（0.8.x 兜底）

> Targeted adaptation pack for **`dsh-context`** (bowenliang123): a 44px touch floor
> for its main panel on dsh-mobile **0.8.x** (where the host has no plugin-panel
> floor). On **0.8.1+** the host already provides the same floor, so this pack backs
> off entirely. Only `hit-target` is claimed. Not a PR; lives in this repository.

- **目标插件**：`dsh-context`，实测版本 **0.79.0**（npm tarball 与安装副本 `lib/client.js` sha256 一致：`bf2295d8…304f69`）。
- **入口**：`conversation.view` 的「上下文」tab（`src/client/index.ts:64-65`）——主槽面板，`check-pack` 能直接量它。composer overlay 与右栏 tab 不在本包范围。
- **面板根**：真实页面上是 **`SECTION.lc-ov-page`**（2026-11-02 verifier 在 0.8.1 + dsh-context 0.79.0 的 live DOM 上复核）；dsh-context 0.79.0 **没有** `data-dsh-*` 根标记。
- **实测环境**：`check-pack` 定向 fixture（390×844 粗指针、1280×800 精指针零回归）。**没有在真实专用页/真机上装包实测**。
- **风险 / 状态**：`safe` / `experimental`。纯 CSS + 一个只写自有标记的 shim；不改插件 DOM、不写宿主属性。
- **opt-out**：`<html data-dsh-adapt="off">` 或面板根/主槽子树带 `data-dsh-adapt="off"`，全部规则失效。注意：0.8.1 起这个属性同时也是宿主地板的门阀（`lib:507`），`off` 会连宿主地板一起关，结果可能比不装包更差；只关本包请停用扩展。
- **回滚**：删掉 `$DSH_HOME/mobile-access/extensions/dsh-context-mobile/`（约 2s 生效）；本包不改任何已安装文件。

## 0. 证据分级（2026-11-02 复核后重写）

| 证据层 | 状态 | 内容 |
|---|---|---|
| 定向 fixture（`check-pack`，390×844 粗指针） | **通过** | 按钮 26/17→44（最矮 17px、设置胶囊 26px）、图标按钮 20×20→44×44、搜索框 32.4→44（字号保持 16px）、下拉 28→44、`role=button` 行 23.4→44；opt-out 全部回落；1280×800 + `--desktop` 严格零回归。**RESULT PASS（42 passed · 0 failed · 1 skipped）** |
| host-probe（伪宿主：先只写 `data-dsh-panel`，再注入 0.8.1 宿主地板） | **通过** | 计算后的 `min-height` 回到基线（`auto`）、按钮/输入不小于无包基线、注入宿主地板后仍 ≥44；宿主属性未被改写 |
| 真实页面结构（verifier 的只读 live DOM 检查，2026-11-02） | **结构核对通过** | 面板根 `SECTION.lc-ov-page`；`data-lc-tip` 在面板子树内，信号桥可落到面板根；真实页还有 24px 的 `<a href>` 余额链接（本包不覆盖） |
| 真实页面上"装包后"的效果 / 真机 | **未做** | 没有把包装进 `$DSH_HOME`（任务边界），因此没有真实页/真机上的装包前后数字 |

## 1. 它做什么（只对 0.8.x 生效）

| # | 规则 | 生效条件 |
|---|---|---|
| 1 | 面板内 `button` / `[role="button"]` / `select`：`min-height:44px` + `min-width:44px` | 粗指针 + 面板打开 + **宿主没有 `data-dsh-panel`**（0.8.x） |
| 2 | 面板内 `input`（非 checkbox/radio）/ `textarea`：`min-height:44px` | 同上 |
| 3 | 面板内 `button` / `[role="button"]` / `a`：`touch-action: manipulation` | 同上 |

**0.8.1 起宿主已接管**：`lib/mobile-layout.js:507` 给 `min-width:44px;min-height:44px`（button/[role=button]/select/input）与 `touch-action`；**0.8.0 与 0.8.1 都**在 `lib:459` 给输入框 `font-size:max(16px,1em,var(--dsh-content-font-size,1em))`。所以：

- 本包**不再**声明 `min-width` / 16px 字号是「宿主没有的东西」——那两条在 0.8.1 上已与宿主重复、字号规则还可能压低用户偏好，**均已删除**；
- 宿主写 `data-dsh-panel`（0.8.1+）时，本包的高度/宽度/touch-action 规则全部退让，宿主地板原样保留（host-probe 断言）；
- 本包的真实价值是 **0.8.0 用户**：那条发布线没有插件面板地板，而这是唯一按面板点名的兜底。

## 2. 为什么要一层定位桥（`mobile.js`）

dsh-context 的面板根没有 `data-dsh-*` 标记，`.lc-*` 类名是第三方私有类（收录标准禁止点名）。它能被外部稳定观测的是**自己的 `data-lc-*` 属性命名空间**：`data-lc-trend` / `data-lc-bars` / `data-lc-tip` / `data-lc-tip-side` / `data-lc-current` / `data-lc-key` / `data-lc-clearable`。

`mobile.js` 只在主槽 `[data-slot="main"]` 里看到这些信号时，给面板根打上**本包自有**的 `data-dshm-context-panel="1"`；CSS 全部收敛在这个标记下：

- 不点名 `.lc-*` 类名（静态层断言）；
- 不写宿主 `data-dsh-panel`（host-probe 断言它未被改写）；
- 信号消失（切到别的面板、插件卸载）时立即摘掉标记，CSS 随之失效；
- 幂等：不建 `<style>`，重复 `activate` 先清理上一代 observer / rAF / resize。

**代价**：耦合依赖 `data-lc-*` 属性名。上游若重命名，本包会**静默失效**（不报错）——`check-pack` 用合成 fixture，测不到真实页面上的信号缺失。这是本包最大的未验证风险，已写进 `catalog.json` 的 `evidence.missing`。

## 3. 定向 fixture：口径、计数与差异（`收录标准.md` §8.1）

### 3.1 捕获 / 构造口径

- **方式**：**源码手工还原 + live DOM 结构核对**，不是像素捕获。类名与盒模型数字取自 npm `dsh-context@0.79.0`（`lib/client.js` sha256 `bf2295d8…`）与 GitHub main 的 `src/client/`；面板根与信号位置由 verifier 在真实 0.8.1 宿主 + dsh-context 0.79.0 页面上只读核对（见 `复核-dsh-context-mobile-20261102.md` §4.2）。
- **表面**：`mobile-dedicated`（`.dshm-*` 外壳），视口 390×844、`(pointer: coarse)`、DPR 2；校验环境为 **headless Chromium 156.0.8078.4**（Playwright 自带，`check-pack` 使用），**不是真机**。
- **日期**：2026-11-02。
- **可复现**：`node tools/check-pack.mjs packs/dsh-context-mobile`；截图由 `node scripts/fixture-shots.mjs packs/dsh-context-mobile` 生成（见 §3.4）。

### 3.2 控件计数（fixture，与 §8.1 A 组对应）

| 类别 | 数量 | 元素 |
|---|---|---|
| `button` / `[role="button"]` | **8** | 粒度 ×4、设置 ×1、搜索清除 ×1（纯图标）、统计行 ×2（`role=button`） |
| `input` / `select` / `textarea` | **2** | 搜索框（`type=search`）、排序下拉 |
| 文本输入（字号断言） | **1** | 搜索框，computed font-size 16px（fixture 模拟宿主；本包不设置字号） |
| `a`（不计入 check-pack 控件） | 1 | 余额占位（fixture 不能写 `href`；真实页是 24px 链接，本包不覆盖） |
| `role="tooltip"` | 1 | `.lc-tip.lc-hovertip`，`position:fixed`、`data-lc-tip`（信号桥用） |

### 3.3 fixture ↔ 真实页差异

| 项 | fixture | 真实页（2026-11-02 verifier live 检查） | 影响 |
|---|---|---|---|
| 面板根 | `SECTION.lc-ov-page` | `SECTION.lc-ov-page` | 一致 |
| 类名 | 仅用真实 build 中存在的类（`lc-ov-page` / `lc-ov-pagehead` / `lc-ov-settings` / `lc-ov-balance` / `lc-stat*` / `lc-gran-btn` / `lc-searchbox` / `lc-clearable` / `lc-settings-select` / `lc-sl-row` / `lc-hovertip`） | 同左（另有 CSS Module 哈希类，本包不引用） | 一致（早先 fixture 自造的 `lc-pagehead` / `lc-toolbar` / `lc-iconbtn` / `lc-ov-sort` 已删除） |
| 余额链接 | `<a role="link">`，**无 href** | `<a href>`，高 24px | fixture 合约禁止 href；本包不覆盖 `a`，真实页仍有 24px 链接缺口 |
| 提示条 | `role="tooltip"` + `data-lc-tip`，fixed | `.lc-tip.lc-hovertip`，fixed，`max-width:min(320px,50vw)` | 一致；本包不碰它 |
| 数据/动态状态 | 静态样例 | 真实 token/成本数据、tab、加载态 | 控件数量与尺寸会变；fixture 只覆盖主视图静态结构 |
| 输入字号 | 16px（模拟宿主） | 宿主 `max(16px,1em,var(--dsh-content-font-size,1em))` | 一致口径；用于断言本包不把字号压小 |
| 面板地板 | **不模拟**宿主地板（模拟 0.8.0） | 0.8.1 宿主给 44px | 故意为之：fixture 量本包自己的 0.8.x 规则；0.8.1 的行为由 host-probe 覆盖 |

### 3.4 几何可移植性声明

fixture 是**合成 DOM**：其中的像素值只用于"同一 fixture 装包前 vs 装包后"的比较，**不可移植**到真实页面或其它视口。真实页的控件数量、动态 tab、加载态、`env(safe-area-inset-*)`、软键盘都未覆盖。

### 3.5 截图（`shots/`）

`shots/before-390x844.png` / `shots/after-390x844.png` 由 `scripts/fixture-shots.mjs` 渲染同一 fixture（390×844、coarse、DPR2）生成：before 不注入包，after 注入 `mobile.css` 并执行 `mobile.js` 的 `activate`。**它们是 fixture 截图，不是真机截图**；真机截图需要先装包（任务边界外），因此这里用 fixture 前后对照 + `check-pack` 数字作为替代证据。

### 3.6 独立复核

- **作者段（t6 原文）**：源码 file:line、控件尺寸与包设计。
- **reviewer 段（t7/t9，`复核-dsh-context-mobile-20261102.md` / `复核修复-dsh-context-mobile-20261102.md`）**：数字重跑一致；作用域/opt-out 干净；源码行号全部正确；live DOM 核对出真实根 `.lc-ov-page`、**6 个可测控件 + 1 个 24px 链接**、fixed tooltip；t7 判 FAIL 的是 host-probe 判据与"宿主没有 min-width/16px"两条声明，t9 追加指出 host-probe 只采样第一个控件（F1）——本文件、`docs/复核修复-20261102.md` 与 `docs/复核修复2-20261102.md` 是修复后的版本。

## 4. 为什么只勾 `hit-target`

基线（定向 fixture，390×844）：

| 指标 | 基线 | 装包后 |
|---|---|---|
| 面板内按钮（8 个） | 最矮 17px；图标按钮 20×20；设置 26px | **44px 高 / 图标按钮 44×44** |
| 搜索框 | 32.4px 高 / 16px 字号 | **44px / 16px（字号不变）** |
| 下拉 | 28px | **44px** |
| 自定义 `role=button` 行 | 23.4px | **44px** |
| 面板左右缘 | 0…390 | 0…390（不变） |

- **不勾 `width-reclaim`**：390 下右缘 = 390、`scrollWidth = innerWidth`，没有要修的横向溢出。
- **不勾其它**：浮动控件/轨道让位属于外壳职责；本面板内没有贴底 fixed 控件（提示条是 fixed，但本包不碰）。
- **热量格子（`role="gridcell"`）不抬到 44px**：数据单元而不是控件。

## 5. 不修的东西（诚实边界）

- **hover-only 提示**：`role="tooltip"` / `data-lc-tip` 在触屏**没有点击入口**，CSS 造不出触发方式；需要上游加 tap/长按入口（`docs/首批高星适配清单.md` §4.3）。
- **真实页 24px 的 `<a href>` 余额链接**：宿主地板不覆盖 `a`，本包也不覆盖（fixture 无法写 href，无法验证）。
- **composer overlay（ContextModal）与右栏 tab**：不在 `[data-slot="main"]`，`check-pack` 的 hit-target 断言量不到。
- **输入框字号**：宿主 0.8.0/0.8.1 都已给 16px 且尊重 `--dsh-content-font-size`，本包不重复设置（避免压回用户偏好）。

## 6. 验收

```bash
node tools/check-pack.mjs packs/dsh-context-mobile          # 42 passed · 0 failed · 1 skipped
node tools/check-pack.mjs packs/dsh-context-mobile --desktop
npm run check                                               # 6 packs · 195/0/11
node --test
node scripts/fixture-shots.mjs packs/dsh-context-mobile      # shots/before|after-390x844.png
```

2026-11-02 实测：`npm run check` 全绿；host-probe 的 4 条断言（untouched / floor-retreated / no-shrink / host-floor-kept）全部通过；1 条 skip 是「本包不使用 `data-dshm-adapt-panel`」。

## 7. 参考

- 复核报告与修复记录：`复核-dsh-context-mobile-20261102.md`、[`docs/复核修复-20261102.md`](../../docs/复核修复-20261102.md)
- 候选评估： [`docs/候选包-20261102.md`](../../docs/候选包-20261102.md)
- 定向 fixture 契约： [`docs/定向-fixture.md`](../../docs/定向-fixture.md)
- 收录标准（含 §8.1 新增定向 fixture 必查）： [`docs/收录标准.md`](../../docs/收录标准.md)
