# floaters — 让面板内容躲开右下角的浮动控件

## 问题

外壳层会出现固定在右下角的悬浮组件：计费气泡、小助手入口、这类东西。它们
`position: fixed` + 高 z-index，**压在插件面板的最后几行上**。面板自己滚动，滚到底也
还是被盖住 —— 最后一条既看不到、也点不到。

真实测量（dsh-mobile **0.8.0**，390×844，Plugins 面板，2026-10-31；0.7.1 的旧数字相同）：

| | |
|---|---|
| 浮动控件 | `dsh-whale-widget`，`268,722 → 390,844`，高 **122px**，`z-index` 高于面板 |
| 宿主 | 纯宿主 `.dshm-mainContent` 是 `overflow:hidden`（`lib/mobile-layout.js:417`），面板根滚到 844 就结束 |
| 结果 | 滚到底仍停在 y=844，最后一行始终在控件下面；`elementFromPoint(330,784)` 命中控件 |

## 做法：留位置，不搬别人的控件

移动别人的悬浮控件需要在选择器里点名第三方类名 —— 收录标准 §2 禁止，而且每来一个新
控件就得加一条规则。所以这里反过来：**量出控件占了多高，把这块空间从面板里让出来**。

1. `mobile.js` 扫描 `position: fixed`、贴底、落在右下、有实际尺寸、**不在 `.dshm-shell` 里**
   的元素，取最大的占用高度，写进 `--dshm-floaters`，同时给 `<html>` 打 `data-dsh-floaters="1"`；
2. `mobile.css` 把这个值变成面板根的 `margin-bottom`，并让 `.dshm-mainContent` 可滚 —— 于是
   末尾内容能再往上滚 122px，停在控件上方；
3. 没有悬浮控件的页面，`data-dsh-floaters` 不存在，两条规则完全不命中。

量出来的值随页面变化：本机真实页面（三包正常加载）= **122px**；如果只开 floaters、宿主因为
扩展没加载完弹出自己的 “Mobile customization could not be loaded” 提示条，那条提示也是贴底
fixed、不在 `.dshm-shell` 里，会被算进让位量（实测 **159px**）。生产口径取 122px。

**为什么用 margin 不用 padding**：padding 缩小面板自身的内容盒，列表一次少看一百多像素
（实测 273px → 153px）；margin 是往外要空间，由外层滚动吸收，**列表视口尺寸不变**，
只是"能再往下滚一点"。

## 生效条件与边界

- 粗指针（`(pointer: coarse)`）；桌面与触控板不受影响，1280×800 逐项零改动。
- 只在面板状态有价值；没有面板时不产生可视变化（规则依赖 `data-dsh-floaters`，套件里的
  `<html>` 标记与面板状态互不干扰）。
- 让位高度封顶在视口 45%：真遇到占半屏的怪控件，也不会把面板挤没。
- 不移动、不改色、不改 `z-index` —— 别人的控件保持原样，只是内容不再钻到它下面。
- **不解决点击**：浮动控件自身的命中区不在本包范围（t12 BUG-01：`img.dshwv-img` 143×143、`elementFromPoint` 直接命中它）；本包只让面板末尾内容能滚到控件上方，点击被控件吞掉需要上游把浮动控件改成 `pointer-events:none` 的透明区或缩小布局盒。

## opt-out

```html
<html data-dsh-adapt="off">
```

`mobile.js` 监听 `<html>` 的属性变化，切到 off 后立刻清掉 `--dshm-floaters` 与标记；
CSS 也整段不命中，面板回到原来的 margin。

**0.8.1 起注意**：宿主自己的面板地板也以 `data-dsh-adapt="off"` 为门阀（`lib/mobile-layout.js:507`），所以 `off` 会**连宿主地板一起关**，结果可能比「不装包」更差（t12 实测：Context Insights min 44→19.8、<44 0→115）。只关本包请卸载/停用扩展，不要用这个属性。


## 验证

```bash
node tools/check-pack.mjs packs/floaters            # 30 passed / 0 failed / 2 skipped
node tools/check-pack.mjs packs/floaters --desktop  # 含 1280×800 零改动
```

fixture 里放了一个 112×118 的右下角固定控件，断言四条：

| 断言 | 判据 |
|---|---|
| `runtime.floater.measure` | 量出的 `--dshm-floaters` ≥ 控件高度 |
| `runtime.floater.scroll` | 面板状态 `mainContent` 的 `overflow-y` 是 `auto/scroll` |
| `runtime.floater.gap` | 面板根 `margin-bottom` ≥ 控件高度 |
| `runtime.floater.reach` | 滚到底后**面板底部 ≤ 控件顶部**（真的让开了，不只是数字对） |

## 真实运行时取证（0.8.0，2026-10-31）

| 观察项 | 结果 |
|---|---|
| 注入 | `style[data-dsh-mobile-extension-style]` = `core-panel` + `floaters` + `shell-chrome` |
| 量测 | `--dshm-floaters = 122px`（`dsh-whale-widget` 的高度），`data-dsh-floaters="1"` |
| 应用 | 面板根 `margin-bottom: 122px`，`mainContent overflow-y: auto` |
| 滚动余量 | `mainContent` client 788 / scroll **910**（正好多出 122px；纯宿主是 787/787 hidden） |
| 滚到底 | 面板底部 y=**722** == 控件顶部 y=**722**，不再重叠 |
| opt-out | `--dshm-floaters` 清空、标记移除、`margin-bottom: 0px`、`overflow-y: hidden` |

与 #319（main，未发布）的关系：宿主会在面板态把 `.dshm-main` / `.dshm-mainContent` 设为
`overflow-y:auto`，与本包第 1 条同值（**不冲突**，本包只是提前一层保险）；本包独有的
`margin-bottom` 让位、`overscroll-behavior:contain` 与 `-webkit-overflow-scrolling:touch`
宿主没有。含 #319 的发布版未复测【推断：依据 merge diff】。

真机指纹级验证（iOS Safari / Android WebView 的 `visualViewport` 与软键盘弹出）仍未做 ——
悬浮控件在键盘弹出时的位置变化不在本包断言范围内。会话态留白只在空会话量过（无视觉位移，
`mainContent` 844/844），长会话未测。
