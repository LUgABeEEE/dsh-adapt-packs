# dshmarket-mobile · 插件市场主面板的触控下限

> Targeted adaptation pack for `dshmarket` — raises the plugin-market panel's touch
> targets to the 44×44 floor on coarse pointers. Only `hit-target` is claimed;
> nothing else in the panel is touched.

- **目标插件**：`dshmarket`（面板根 `[data-dsh-market-root]`，入口：侧栏「插件市场」）。
  实测版本 **1.73.3**；仓库 HEAD `1.73.6` 未做完整实测（本地仅做过结构抽样，未入库为可复核证据）。
- **实测环境**：① **stock DSH web 挤到 390×844 · `(pointer: coarse)`**（隔离 DSH 实例）；② **dsh-mobile 0.8.0 专用页**（桌面 headless）；③ **Android App 真机**（Redmi K90 Max / Android 17 / App 0.7.1，2026-11-01）。
  真机口径与数据见 [`docs/真机验证.md`](../../docs/真机验证.md)。
- **风险 / 状态**：`safe` / `experimental` — 纯 CSS 命中下限，不改结构、不注入脚本。
- **回滚**：删掉 `$DSH_HOME/mobile-access/extensions/dshmarket-mobile/` 即回滚（2s 内卸载）；
  本包不改任何已安装的 DSH 产物。opt-out 也可用：面板根/文档根带 `data-dsh-adapt="off"`。

## 0. 证据分级：凭什么说这是「真缺口」

作者 review 时最可能问的是这一点，所以先给四级证据。**只有第一级是通用 fixture，本包没有用它跑结论**：

| 证据层 | 状态 | 数字 |
|---|---|---|
| 通用 fixture（`check-pack` 内置） | **未使用/不适用** —— 本包存在 `packs/dshmarket-mobile/fixture.html`，`check-pack` 全轮次都用定向 fixture，不回退内置；内置 fixture 里也没有 `[data-dsh-market-root]`，用它对 dshmarket 断言等于空转 | — |
| **定向 fixture**（`check-pack`，390×844 粗指针） | **通过** | 137 个按钮最小边 **28→44px**、图标按钮宽 **28→44px**、输入框高 **22→44px**；opt-out 全部回落到基线；1280×800 精指针 + `--desktop` 严格零回归。合计 **RESULT PASS（32 passed · 0 failed · 2 skipped；`--desktop` 为 33 / 0 / 2）** |
| **真实面板 / stock DSH web**（隔离实例捕获 + `dsh-ui-lab` 390×844 注入对照） | **通过（stock web 口径）** | 捕获口径：173 个可交互元素中 **172 个 <44px**（98.3%，最小 12.1px）；搜索输入 **154×24px、font-size 14px**。lab 口径：可测控件 138，最小边 **12.1→44px**，<44px 计数 **138→0**，面板盒 334×844 未变、无横向溢出 |
| **dsh-mobile 专用移动页 / 真机**（App 0.7.1 + Android 17，2026-11-01） | **通过** | 无包基线：主槽 141 个控件全部 <44px（最小 **14px**）、市场根 138 个全部 <44px；只装本包后市场根 **137 个控件 / 最小 44px / 0 个 <44px**，主槽其余控件保持 20/3（未越界）；与 `core-panel` 同装时主槽 **141/44/0**。真机 `env(safe-area-inset-*)` 全 0（App 非 edge-to-edge）、软键盘 786→472。详见 [`docs/真机验证.md`](../../docs/真机验证.md) |

两个数字（172/173 与 138/138）不是矛盾，是**口径不同**：

- **173** = 真实面板里全部可交互元素（含 34 个卡片 `<a>` 链接）；
- **138** = `check-pack` 的计量口径（`button` / `[role="button"]` / `select` / `input` / `textarea`，链接不计入），
  即 137 个 button + 1 个 input；两组数字都说明「插件自己的面板在手机上几乎没有可点中 44px 的目标」。
- fixture 里输入框高 22px、真实页面 24px：合成外壳与真实布局的 2px 上下文差异，二者都远低于 44px。

## 1. 它做什么

| # | 规则 | 生效条件 |
|---|---|---|
| 1 | `[data-dsh-market-root]` 内 `button` / `[role="button"]` / `select`：最小边 ≥ 44px（图标按钮只有 svg，宽度也兜住） | 粗指针 |
| 2 | 面板内 `input` / `textarea`：高 ≥ 44px、`font-size` ≥ 16px（避免 iOS 聚焦自动放大） | 粗指针 |
| 3 | 面板内可操作控件 `touch-action: manipulation`（去掉 300ms 双击缩放等待） | 粗指针 |

选择器全部收敛在 `[data-slot="main"] [data-dsh-market-root]` 内；**没有使用任何 dshmarket 的 CSS
Module 哈希类名**（`nUhMVa_*`、`_button_1rv3m_*` 每次构建都会变，fixture 里保留了它们只为还原结构，
pack 不引用）。

## 2. 为什么只勾 `hit-target`

实测基线（stock web 390×844，抽屉收起，面板可用宽 334px）：

| 指标 | 基线 | 装包后 |
|---|---|---|
| 面板内可测控件 | 138（137 button + 1 input） | 138 |
| 最小边 < 44px 的控件 | **138 / 138**（最小 12.1px） | **0**（最小 44px） |
| 按钮高度 / 图标按钮宽度 | 28px / 28px | 44px / 44px |
| 输入框高 | 22px | 44px |
| 面板盒 | `x=56 w=334 right=390`，`scrollWidth=390` | 相同（布局未被改动） |

- **不勾 `width-reclaim`**：390×844 下面板右缘 = 390、`documentElement.scrollWidth = innerWidth`，
  **本来就不溢出**，没有要修的东西；勾了会变成虚报。
- **不勾 `rail-clearance` / `floater-clearance`**：轨道让位与浮动控件让位属于外壳/宿主职责；
  面板内也没有贴右下角的 fixed 浮动控件（安装 toast 走宿主 overlay）。
- **不勾 `chrome-collapse` / `notice-collapse` / `scroll-owner`**：包不改顶栏、提示行与滚动归属。

## 3. 定向 fixture（`fixture.html`）

`fixture.html`（142,712 B，< 256 KB）是 **dshmarket 1.73.3 真实主面板**在 390×844 下的 DOM 快照，
用于让 `check-pack` 在「这个插件自己的面板」上做真实盒模型断言，而不是在通用 fixture 上空转。
文件契约（体积 / 禁用内容 / DOM 最小契约 / evidence 写法）见
[`docs/定向-fixture.md`](../../docs/定向-fixture.md)（独立文档，不占收录标准章节号）：

- 来源：隔离 DSH web 实例（本机 DSH 0.2.1-rc.3 + dshmarket 1.73.3）在 **390×844 @3×** 下打开
  侧栏「插件市场」入口、收起抽屉（stock web 挤压视口下抽屉是挤压式，不收只剩 110px）后捕获；
  入口默认关闭，用 dshmarket 自己的 `POST /dsh-market/sidebar-entry` 在隔离环境开启，
  **没有改真实 `.dsh`**。捕获时 173 个可交互元素、172 个 <44px，搜索输入 154×24 / 14px 字号；
- 处理：只留面板子树；去掉 `href`/`src`/xmlns/外链/`@import`/`url()`；套上 check-pack 要求的
  最小外壳骨架（`.dshm-shell` / `.dshm-main` / `.dshm-mainContent` / `[data-slot="main"]`）；
- 脱敏：不含会话内容、账号、凭据、token、真实路径；面板内是公开插件目录数据；
- 局限：**结构/几何快照，不是像素复刻**；dshmarket 的 CSS Module 哈希类名在 fixture 中保留但
  **不可依赖**（`catalog.json` 的 `usesHostMarkers` 只登记真正用到的稳定标记）。

## 4. opt-out

`data-dsh-adapt="off"` 放在 `<html>` 或面板根上时，本包全部规则失效
（`mobile.css` 用 `:root:not([data-dsh-adapt="off"])` 守卫），面板回到插件自己的尺寸。
`check-pack` 的 opt-out 轮已验证：按钮 44→28、输入 44→22、面板盒回基线。

**0.8.1 起注意**：宿主自己的面板地板也以 `data-dsh-adapt="off"` 为门阀（`lib/mobile-layout.js:507`），所以 `off` 会**连宿主地板一起关**，结果可能比「不装包」更差（t12 实测：Context Insights min 44→19.8、<44 0→115）。只关本包请卸载/停用扩展，不要用这个属性。


## 5. 验证

```bash
node tools/check-pack.mjs packs/dshmarket-mobile --desktop
```

本机实跑（Windows，2026-10-31）：

```
RESULT PASS（32 passed · 0 failed · 2 skipped）
```

- 静态层：5 字段 manifest、3 条选择器全部落在允许作用域、无第三方类名、无 `:has`、
  fixture 142,712 B 且无脚本/外链、浏览器可解析、壳骨架齐全；
- 运行时（390×844 粗指针）：137 个按钮最小边 ≥44、1 个输入控件高 ≥44、图标按钮 44×44、
  适配生效、opt-out 全部回落；
- 1280×800 精指针 + `--desktop` 严格零回归：mainContent 盒模型与全部控件矩形均未改动。

dsh-ui-lab 对照（**stock DSH web 口径**，390×844 @3×，隔离实例 + `--inject` 模拟装包）：

| | 可测控件 | 最小边 | <44px | 面板盒 | 横向溢出 |
|---|---|---|---|---|---|
| before | 138 | **12.1px** | **138 / 138** | 334×844 @x=56 | 无 |
| after | 138 | **44px** | **0 / 138** | 334×844 @x=56（未变） | 无 |

截图：`shots/before-390x844.png`、`shots/after-390x844.png`（同口径，仅注入 CSS 不同）。

真机 App 对照（**Android 17 / dsh-mobile App 0.7.1 / 专用页**，2026-11-01；同一「插件 → 插件市场」路径，只改变安装的包）：

| 状态 | 主槽（n / 最小边 / <44） | 市场根（n / 最小边 / <44） |
|---|---|---|
| 无包（before） | 141 / **14px** / **141** | 138 / **14px** / **138** |
| 仅本包 | 140 / 20 / 3 | 137 / **44px** / **0** |
| 本包 + `core-panel`（after） | 141 / **44px** / **0** | 138 / **44px** / **0** |

与桌面专用页逐项一致；差异只有两处且都不是包的问题：真机无包基线最小边 14px vs 桌面 12.1px（字体渲染差）、虚拟滚动导致单包时 n 少 1。完整方法、`safe-area` 与软键盘数据见 [`docs/真机验证.md`](../../docs/真机验证.md)。
复跑命令（两个面都不装 dsh-mobile；隔离实例 + 临时 inject helper 收起首启弹窗与抽屉）：

```bash
# 起隔离 DSH web（独立 DSH_HOME / 端口），启用 dshmarket 侧栏入口后：
node src/cli.mjs shot --surface web --profile phone-390x844 --url "<token-url>" \
  --open "插件市场" --inject <before|after> --wait 3000 \
  --out .shots/lab-dshmarket-<side> --json
```

注意：stock web 挤压视口下抽屉是挤压式而非覆盖式，截图前需收起抽屉，否则面板只剩 110px 宽；
helper 只存在于测量脚本里，**不随 pack 发布**。

## 6. 未验证 / 边界

1. **dsh-mobile 专用移动页已在桌面 headless 与 Android App 真机上实测**：本包 `surfaces` 声明 `mobile-dedicated`（安装通道所在面），
   数字见 §5（桌面 0.8.0 专用页）与 [`docs/真机验证.md`](../../docs/真机验证.md)（Android App 0.7.1）；stock web 数据只作近似。
2. **真机只覆盖 Android 单机**：Android 17 / App 0.7.1 已实测命中区、safe-area 与软键盘；**iOS、拇指真实触达、edge-to-edge 全屏 App 仍未验证**。
3. **dshmarket 1.73.6 未做完整实测**：fixture 与基线仍来自 1.73.3；本地结构抽样不作为可复核证据。
4. **输入框字号**：规则设为 16px；`check-pack` 自 2026-10-31 起以 `runtime.mobile.inputFontSize` 断言文本输入 computed 字号 ≥16px（工具断言通过；真机本轮未单独记录输入字号），
   后续若宿主改字号，以断言为准。
5. **卡片整卡点击层**：dshmarket 的卡片是 `<a>`，不在 `check-pack` 的控件选择器内；本包只对
   按钮/输入类控件做下限，卡片点击层未改（如需 44px 整卡，应由插件自己或后续 pack 处理）。
6. **themes 全屏预览 / portal 弹层**：`[data-dsh-market-fullscreen]` / `[data-dsh-market-portal]`
   是其他状态且不在六项能力内，本包不覆盖。

## 7. 与上游的关系

这是「上游补 `data-dsh-*` 契约前」的过渡适配：选择器只依赖 dshmarket 自己写的
`[data-dsh-market-root]`（自检钩子也在读它，属于稳定自有契约）和宿主公共标记
`[data-slot="main"]`。若 dshmarket 后续把 44px 做进插件自身，本包应标 `retired`。
