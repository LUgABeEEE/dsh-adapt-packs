# shell-chrome — 外壳自身的触控下限

`shell-chrome` 管的是 **dsh-mobile 外壳自己**的触控面，不是插件面板：

| 位置 | 为什么归外壳 | fixture 基线 | 装包后 | 真实设备 / 0.8.1 依据 |
|---|---|---|---|---|
| 面板顶部「返回会话」栏 | 外壳渲染的 `.dshm-panelNav`，插件碰不到 | 25px | **44px** | 0.8.0 实测 48px → **48px**（rise-only，不压小宿主更大的值） |
| 抽屉**展开/停靠**态：行内按钮 / 链接 | `[data-slot="sidebar"]` | 28px | **44px** | 0.8.0 实测 36 → 44 |
| 抽屉**展开/停靠**态：会话行、项目行 | `role="treeitem"` 的 div（`dsh-client-ui-workspace` 的稳定 ARIA 契约） | 32 / 34px | **44px** | t12（2026-11-02，平板 0.8.1 真机）：旧包只有 32×31 / 34×21，没抬；见 `测试-适配矩阵-20261102.md` BUG-03 |
| 抽屉**折叠**态：56px 图标轨里的按钮 | `[data-slot="sidebar"]` 内的 icon button | 36×36 | **44×44** | t12：旧包 36×15 未抬；t17 真机（14:07 包）36×36→**36×44**（只抬高度）；本轮补 `min-width:44` |
| 抽屉**收起/展开**开关（drawerToggle） | 侧栏自己的收起/展开按钮 | 收起 28×28 / 展开 36×36 | **44×44**（两种状态） | t17 真机：28×28→28×44、36×36→36×44（宽都没动）；本轮补 `min-width:44` |

## 2026-11-02 扩到停靠/折叠态（t12 BUG-03）

旧规则只匹配 `.dshm-drawer[data-open="true"]`，于是平板停靠侧栏的 `role="treeitem"` 行
（32/34px）与折叠轨道图标（36px）都没被覆盖 —— 声明里的「抽屉行 44px」与实测不符。

现在：

- **两种状态都覆盖**：`data-open` 不再是规则的开关；
- **会话/项目行用 `role="treeitem"`**：这是 DSH 工作区列表（`dsh-client-ui-workspace`）自己
  给的 ARIA 角色，不是第三方类名，也不是我们造的标记。源码位置：
  `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1969`（`ProjectRowItem`）、
  `:2185`（`SearchResultItem`）、`:2278`（`SessionNodeItem`）的 `role: "treeitem"`；
- **宽度也抬到 44**（t15 F1 / t17 真机）：`min-width:44` 与 `min-height:44` 一起写在
  `[data-slot="sidebar"] :where(button, [role="button"], a)` 上，两种抽屉状态都生效。
  它只会抬高、不会压小——展开态的行式按钮本来就是 280/312/320px，不受影响；
  真正变宽的是折叠轨道 icon（36×36）、drawerToggle（收起 28×28 / 展开 36×36）与行内动作按钮。
  56px 轨道放得下 44px（每侧余 6px）。
- **宿主地板不覆盖侧栏**：0.8.1 的 #319 地板选择器以 `[data-slot="main"]` 为根
  （`lib/mobile-layout.js:507`），侧栏是外壳自己的 UI，所以这里没有「宿主接管后退让」的门阀，
  0.8.0 / 0.8.1 都需要本包补；
- **`role="treeitem"` 的源码位置**（t15 F6）：`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1969`
  （`ProjectRowItem`）、`:2185`（`SearchResultItem`）、`:2278`（`SessionNodeItem`）；
- **opt-out 语义见下**。

> 风险登记：折叠轨道是 56px 宽、`overflow:hidden` 的列，图标从 36 抬到 44 后纵向更占空间；
> 真机上轨道内容是否会出现裁切尚未复测（t12 只量了「装包前」的 36px，未装新版包）。
> 停靠行只抬 `min-height`，行内右侧动作按钮同样被抬到 44——若视觉过挤，需要上游把行高
> 与动作按钮分开处理。

## 2026-10-31 收口：返回栏规则从 `!important` 改成 rise-only

旧规则是 `min-height:44px !important`。它在 0.8.0 上是**负收益**：宿主的
`.dshm-panelBack{min-width:48px;min-height:48px}`（`lib/mobile-layout.js:449`）本来给的是
48px，被这条 `!important` 压成 **48 → 44**，panelNav 高度 57 → 56（实测，见
`实测-0.8.0-20261031.md` §4.1）。`min-height` 是地板，但它会**替换**宿主自己的
`min-height`（宿主那条不是 `!important`）。

现在这条规则：

```css
:where(:root:not([data-dsh-adapt="off"]) .dshm-panelNav) :where(button, [role="button"]) {
  min-height: 44px;   /* 没有 !important */
  min-width: 44px;
}
```

选择器整体放进 `:where()`，特异性为 **0**，于是级联顺序变成：

| 宿主给的 | 结果 |
|---|---|
| `min-height:48px`（0.8.0 的真实情况） | 宿主特异性更高 → 48px 保留，**不压小** |
| 只有 `height:25px` 或没有任何高度规则 | `min-height:44px` 生效 → 抬到 44px（`height` 不能抵消 `min-height`） |

侧栏规则仍然用 `!important`：宿主没有给侧栏任何触控下限，32/34/36px 是内容自然高度，
44px 是唯一生效的抬升。

## 为什么和 `core-panel` 分开

`core-panel` 只管插件面板**里面**的东西（它的状态属性是 `data-dshm-adapt-panel`）。侧栏在
「没打开任何插件面板」时也在屏幕上，用户照样要按。把它塞进 `core-panel` 会让那张包在面板
关闭时失效，而侧栏恰恰是常驻的。分开的另一个好处是风险可分。

## 生效条件

- **粗指针**（`(pointer: coarse)`）—— 桌面与触控板设备完全不受影响；
- 两种抽屉状态都生效（展开/停靠、折叠轨道）；
- 1280×800 精指针下逐项零改动（`check-pack` 断言，含轨道与停靠行）。

## opt-out（重要，t12 BUG-04）

```html
<html data-dsh-adapt="off">
```

**这个属性同时是宿主 0.8.1 移动地板的门阀**（`lib/mobile-layout.js:507` 的
`:not([data-dsh-adapt="off"])`）。所以加上它**不是「恢复官方原状」**，而是：

- 本包的全部规则失效；
- **宿主自己的 44px 面板地板也一起失效** —— 实测 Context Insights 从 min 44 / <44 0
  变成 min 19.8 / <44 115，比「不装包」更差（t12 BUG-04）。

只想关本包、保留宿主地板时，请**卸载/停用扩展**（`node tools/install.mjs --uninstall shell-chrome --yes`），
不要用 `data-dsh-adapt="off"`。面板级的「只有某个插件面板例外」不适用于这张包。

## 代价

- 侧栏行用 `!important` 会压过外壳/插件自己的紧凑行设计；这是「宿主下限」的代价。
- 行内 `a` 只抬 `min-height`、不加 `min-width`（长标题会自己撑开）。
- 只覆盖 `.dshm-panelNav`、展开/停靠态侧栏与折叠轨道；右侧详情面板、弹层
  （`[role="dialog"]`）不在本包范围 —— 后者是 DSH 自己的设置页，强行撑大会把开关变成大方块
  （2026-10-30 真机反馈）。

## 回滚

```bash
node tools/install.mjs --uninstall shell-chrome --yes   # 移走目录，2 秒生效
```

## 证据

```bash
node tools/check-pack.mjs packs/shell-chrome          # 25 passed / 0 failed / 4 skipped
node tools/check-pack.mjs packs/shell-chrome --desktop
```

跳过的是面板三组断言（本包只声明 `shell-hit-target`）。fixture 基线：返回栏 25 / 抽屉按钮 28 /
折叠轨道 36×36 / drawerToggle 28×28 / 停靠行 32；装包后：返回栏 44、抽屉按钮 44×44、
折叠轨道 44×44、drawerToggle 44×44、停靠行 44。断言 `runtime.shell.rail` /
`runtime.shell.drawerToggle` / `runtime.shell.dockedRows` 都检查宽与高（t15 F1）。

## 真实运行时取证

**0.8.0（2026-10-31，390×844 粗指针，真实网关）**：抽屉展开行 36 → 44；返回栏 48 保持 48
（旧规则会压成 44）。

**0.8.1 平板真机（t12，2026-11-02）**：旧包装包后展开/停靠侧栏仍有 32×31 条会话行、34×21 条
项目行、折叠轨道 36×15 个图标 —— 这是本规则的**修前**证据（`测试-适配矩阵-20261102.md`
BUG-03）。

**0.8.1 平板真机（t17，2026-11-02 14:07 包）**：treeitem 会话/项目行 **32/34 → 44**（已修好）；
折叠轨道 icon **36×36 → 36×44**、drawerToggle 收起 **28×28 → 28×44**、展开 **36×36 → 36×44** ——
只抬了高度、宽度没动（t15 F1）。本轮补 `min-width:44` 后，fixture 断言为 44×44；
**整机装新包复测仍未做**。
