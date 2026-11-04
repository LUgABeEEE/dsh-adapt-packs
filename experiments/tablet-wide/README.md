# tablet-wide · 宽屏内容居中 + composer 胶囊（实验，不是 catalog 包）

> **状态：实验（experimental），默认关，不进 `catalog.json`。**
> 设计灵感来自 **dsh-go** 的平板/横屏重排（侧栏常驻、内容居中、composer 浮动胶囊）。
> 这里只借鉴**设计意图**，**没有复制** dsh-go 的代码、类名、样式表或截图素材；
> dsh-go 的代码与品牌归其作者（AGPL/品牌保留），本目录全部是独立编写的 CSS 与探针。

## 1. 它做什么

只对 **dsh-mobile 专用页（mobile-dedicated）**、**粗指针**、**视口 ≥1100px** 生效：

| 目标 | 规则 | 实测效果（1363×860，lab） |
|---|---|---|
| 主内容列 | `[data-conversation-scroll] { width:100%; max-width:720px; margin-inline:auto }` | 1021 → **720**，在侧栏右侧居中（x=491.5） |
| composer | `[data-composer-card] { width:100%; max-width:720px; margin-inline:auto }` | 712 → **715**（headless 滚动条占 5px；真机 overlay 滚动条预期 720） |
| 列内留白 | `[data-conversation-scroll] { --dsh-composer-side-clearance:0px }` | 胶囊贴齐列宽；会话列 padding 32→16，正文仍 680 |
| 侧栏 | 不动 | 340 常驻，前后一致 |

- **三重门**：① 所有选择器挂在 `.dshm-shell` 下（stock DSH web / 粗指针桌面没有这个外壳，不会命中）；
  ② `(min-width:1100px) and (pointer: coarse)`；③ `data-dsh-adapt="off"` 可整体回落。
- **<1100px 与桌面（精指针）零改动**：909×1314、834×1194（粗指针）与 1280×800（精指针）
  实测前后完全一致；非 dedicated 的 ≥1100 粗指针反例也不生效。
- **opt-out**：`<html data-dsh-adapt="off">` 后主内容列/composer 回落到 1021/712。
  注意这个属性**同时是宿主 0.8.1 面板地板的门阀**（`lib/mobile-layout.js:507`），
  所以它是「本实验与宿主地板一起关」，不是恢复官方原状；只关本实验请停用扩展。
- 本实验**没有**面板状态门阀：宽屏排版作用于会话列，与插件面板是否打开无关。

## 2. 与 dsh-go 的设计对照（只对照，不复制）

| 设计点 | dsh-go（README/截图描述） | 本实验 |
|---|---|---|
| 侧栏 | 横屏/平板常驻 | 依赖 dsh-mobile ≥900px 的静态侧栏（340/56px），不重写 |
| 内容列 | 约 700px 居中列 | `[data-conversation-scroll]` 最多 **720px** 居中（与胶囊同宽） |
| composer | 居中胶囊 | `[data-composer-card]` 最多 **720px**，并清掉左右 clearance 贴齐列宽 |
| 键盘 | 「弹出键盘也不挤」 | **未验证**：headless 无法复现软键盘，真机需人工复测 |
| 实现 | 自有布局 | 纯 CSS 覆盖 dsh-mobile 的既有 DOM 标记，不改宿主、不加 JS |

## 3. 为什么放 `experiments/` 而不是 `packs/`

- `docs/收录标准.md` §1 明确**不收外壳级适配**（抽屉、设置页、**输入栏**、主题、PWA）——
  composer 与整列排版属于这一类；
- 能力表（`hit-target` / `width-reclaim` / …）无法表达「宽屏排版」，`check-pack` 也没有对应断言组；
  硬塞进 catalog 会让「能力 ↔ 断言」失真。
- 因此本目录**不在 `packs/` 下**、没有 `extension.json`、不进 `catalog.json`；`check-pack` 不会扫描它。

## 4. 事实与取舍（2026-11-03/04 实测）

- 宿主 0.8.1 的宽布局阈值只看宽度：`WIDE_LAYOUT_MIN_WIDTH_PX = 900`（`lib/mobile-layout.js:39/47`）；
  本实验把作用域收窄到 **≥1100px**，竖屏 909（主区 569）不再生效，省掉无收益的竖屏复测。
- 1363×860：侧栏 340 常驻，主列 **1023**，会话滚动容器 **1021**，composer 卡片 **712**。
- **宿主已经把消息正文限制在约 680px 并居中**（`--dsh-chat-content-width` 派生出 composer 的
  `--dsh-composer-card-max-width = content + 32px = 712`）。所以本实验改变的是
  **会话列宽度/滚动条位置/两侧留白 + composer 胶囊宽度**；消息正文仍是宿主的 680px，
  前后不变（实测 1363：680→680）。
- 列与胶囊同宽靠把 `--dsh-composer-side-clearance` 归零实现（必须设在
  `[data-conversation-scroll]` 上：宿主把变量定义在更内层的 `.wSkVaW_body`，设在 `.dshm-shell` 会被覆盖）。
  归零后会话列 padding 从 32px 降到 16px，720−32=688 ≥ 680，正文不会被收窄。
- `[data-conversation-scroll]` 是 flex 列里的 `flex:1` 子项，只写 `max-width` + `margin-inline:auto`
  会让 auto 宽度收缩成 fit-content（实测 720→~396）；必须同时 `width:100%`。

## 5. 怎么试 / 怎么测

本实验没有 `extension.json`，**不要**用 `install.mjs` 装；用 ui-lab 注入或手动把 `mobile.css`
作为扩展内容加载。ui-lab 0.2.1 没有 1363/909 的 profile，所以本目录带一个复用 ui-lab 模块的只读探针：

```bash
# 需要 dsh-ui-lab checkout + 已完成配对（.cache/mobile-state.json）
node experiments/tablet-wide/probe.mjs                 # 默认 ../../dsh-ui-lab
node experiments/tablet-wide/probe.mjs --ui-lab /path/to/dsh-ui-lab
```

探针会依次跑 1363×860 / 909×1314 / 834×1194（<1100）/ 1280×800（精指针），
打开一个**真实已有会话**（只做导航，不发消息），测量会话列/composer/侧栏/首条消息，
注入 `mobile.css` 后再测一次，并做 `data-dsh-adapt="off"` 回落；每个场景保存
before / after / opted-out 三张截图。它还会：
- 检测宿主遗留诊断脚本 `$DSH_HOME/mobile-access/mobile.js`：存在则**在浏览器里屏蔽其请求**并记录，
  避免把整屏文本拍进截图；
- 用一个无 `.dshm-shell` 的合成页面做**非 dedicated 反例**（≥1100 粗指针 → 不生效）。

也可用 ui-lab 在它支持的平板上粗略看效果（834 宽 <1100，本实验不生效，只能看「不动」）：

```bash
cd ../dsh-ui-lab
node src/cli.mjs shot --surface mobile --profile tablet-834x1194 \
  --inject ../dsh-adapt-packs/experiments/tablet-wide --out .shots/tablet-wide
```

## 6. 证据（lab）

`probe.mjs` 输出（2026-11-04，本机 0.8.1 真实页，headless Chromium 156.0.8078.4，**17/17 PASS**）：

| 场景 | 会话列 | composer | 正文列 | 侧栏 | 结论 |
|---|---|---|---|---|---|
| 1363×860 装前 | 1021 @x340 | 712 @x492 | 680 | 340 | — |
| 1363×860 装后 | **720 @x491.5** | **715** @x491.5 | **680** | 340 | 居中定宽 + 胶囊贴齐 |
| 1363×860 opt-out | 1021 @x340 | 712 @x492 | 680 | 340 | 回落 |
| 909×1314 | 567→567 | 530→530 | 498→498 | 340 | 规则不命中，完全不变 |
| 834×1194（<1100） | 776→776 | 712→712 | — | 56 | 规则不命中 |
| 1280×800（精指针） | 938→938 | 712→712 | 680 | 340 | 桌面零改动 |
| 非 dedicated 合成页（1363，粗指针） | 1023→1023 | 712→712 | — | — | 守卫生效 |

截图：`shots/1363x860-{before,after,opted-out}.png`、`shots/909x1314-{before,after,opted-out}.png`；
原始 JSON：`shots/measurements.json`（含 `hostOverlay` 与 `nonDedicated` 记录）。

## 7. 未验证 / 风险

1. **真机平板**：以上是 headless Chromium 对真实网关页的测量（lab），不是平板真机；
   safe-area、触摸滚动惯性未覆盖。**composer 真机 720 的「真实会话」证据仍待 device-tester 补**
   （lab 是 715：headless 滚动条占 5px；真机 overlay 滚动条预期 720）。
2. **软键盘**：dsh-go 的卖点之一是「键盘弹出也不挤」，headless 无法复现；真机需人工复测。
3. **浮动控件**：截图右侧仍能看到宿主悬浮控件（鲸鱼/用量气泡）压在留白区；`floaters` 只负责
   面板让位，不处理宽屏留白区的遮挡。
4. **宿主 DOM 契约**：依赖 `.dshm-shell`、`[data-conversation-scroll]`、`[data-composer-card]`、
   `--dsh-composer-side-clearance`；宿主改标记/变量时本实验会失效（实验性质，接受）。
5. **消息正文宽度**：本实验不改变宿主的 680px 正文列；若要 720 正文需另改宿主变量并复测。
