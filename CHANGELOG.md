# Changelog

本文件记录 `dsh-adapt-packs`（原 `dsh-mobile-adapt`）的包行为变更。包是**通配适配层**，
所以每条都写清「依据」与「适用范围（release 0.8.0 / main #319）」；没有证据的改动不进这里。

## [Unreleased]

### Fixed（2026-11-02，t20 复核修复 3）

- `shell-chrome`：侧栏按钮的 `min-width` 补齐（t15 F1）——折叠轨道 icon、drawerToggle（28×28/36×36）在两种抽屉状态下都到 44×44；`check-pack` 的 `runtime.shell.rail` 改为宽高都断言，新增 `runtime.shell.drawerToggle`，`runtime.shell.dockedRows` 也检查宽度；红色回归「只设 height 必须 FAIL」。
- `docs/复核修复3-20261102.md`：BUG-02 逐类计数（41/94 全是 `button[role=switch]` 36×20）与定向透明命中层试验（核心开关可行、第三方伪元素旋钮会被覆盖）→ 不新增通配规则，保持「我们的空白」口径。
- 文档：模板 README / shell-chrome CSS 头的 opt-out 措辞统一为「本包与宿主地板一起关」；catalog 恢复「未来宿主行高 >44 会被 !important 压小」风险；`verifiedWith` 改为 0.8.1；补 `role="treeitem"` 的 file:line。

### Changed（2026-11-02，t10 加固）

- `check-pack` 的 host-probe 改为**全量控件**断言（reviewer F1）：sentinel 阶段逐个比较 `controls` 的 computed `min-height` 与无包基线、逐个断言不小于基线；注入 0.8.1 宿主地板后逐个断言受覆盖控件 ≥44px（未覆盖控件只要求不压小）。报告给出不达标数量与最小 min-height/高度。新增红色回归「只压 `[role=group] button` 必须 FAIL」。
- `tools/bundle.mjs` 重新纳入 `dsh-context-mobile`；`package.json` 升到 **0.3.7**（只升版本号，未发布）。
- 修正 core-panel / catalog / compat / 根 README 里「宿主不提供 min-width」的旧说法（0.8.1 起宿主同时给 `min-width:44`，`lib/mobile-layout.js:507`），并把「本机仍跑 0.8.0」更正为「本机已 0.8.1，但未在真实 0.8.1 上装包复测」。
- `dsh-context-mobile` 的 fixture 文档补 Chromium 版本（156.0.8078.4）与 reviewer 段的真实页控件计数（6 个可测控件 + 1 个 24px 链接）。

### Fixed（2026-11-02，`dsh-context-mobile` 复核修复）

- `check-pack` 的 host-probe 判据回退问题：`<44px` 的判定可被「无门阀 40px 残留地板」利用（复核 B1）。现在两段测量——sentinel 阶段看**计算后的 `min-height`** 是否回到无包基线（直接证据），注入 0.8.1 宿主地板后看控件是否仍 ≥44px，并恢复「不得比无包基线更小（±2px 字号差）」；`test/checkpack-regression.test.mjs` 增加「无门阀 40px 必须 FAIL」的红色回归。
- `dsh-context-mobile` 删除与宿主重复的 `min-width:44` 与 16px 字号规则（复核 B2：0.8.1 已给 `min-width`，0.8.0/0.8.1 都已给输入 16px）；README / extension 描述 / catalog evidence 同步删除「宿主只给高度 / 16px 是宿主没有的」表述。
- `dsh-context-mobile` 的 fixture 按真实结构重做（真实根 `SECTION.lc-ov-page`、真实类名、fixed `role=tooltip`、`data-lc-tip` 信号桥），补 §8.1 的捕获口径/控件计数/差异表/独立复核段与 `shots/` 前后截图（复核 B3）。
- `catalog.json`：`dsh-context-mobile.verifiedWith` 改为 fixture 支撑的口径，并在 `evidence.missing` 明写未在真实运行时装包验证；`usesHostMarkers` 只保留包实际使用的 `.dshm-main` 与 `[data-slot="main"]`（复核 B4/B8）。

## [0.3.6] - 2026-11-01

### Added

- `compat.json.hostBaseline`：按宿主版本记录「面板控件有没有自带地板」。0.7.x–0.8.0 没有（172/173 个控件 <44px），**0.8.1 起** main-slot 面板自带 coarse-pointer 44px 下限（含 root opt-out，排除 switch/range/嵌套 opt-out），`core-panel` 的门阀随之退让。
- `dsh-adapt-packs compat` 与设置页都会先打印宿主基线，再列插件结论——读结论前先知道宿主已经替你做了什么。

### Docs

- README / `docs/收录标准.md` / `catalog.json`：把「#319 尚未发布」更正为「随 0.8.1 于 2026-11-01 发布」，并明确 0.8.1 上的运行时**本机尚未实测**（本机仍是 0.8.0），只有 host-probe 的合成验证。

### CI

- 发布不再依赖长期 token：包已通过 npm **trusted publishing** 绑定到本仓库，`publish.yml` 用 GitHub OIDC 换取短期凭据（`npx npm@12 publish --provenance`）。`NPM_TOKEN` secret 可以删除。

### CI

- `scripts/check-bundle.mjs`：把 `npm pack` 的产物装进临时 prefix 再验一遍（文件清单、`dsh.client` 三个字段、patch 行、host 导出、CLI 与 4 个包）。CI 与 `prepublishOnly` 都跑。这一层专门防「源码树里有、发布产物里没有」的清单错误。

### Changed（0.3.4）

- `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`：显式声明用到的客户端服务（与 `dsh-skills-manager` 同款）。
- `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`：把支持的宿主版本写进清单，别让宿主靠猜。

验证：在 **rc.5** 的隔离副本（完整 profile 克隆，端口 3103）里，0.3.3 / 0.3.4 都能 boot 成功、无 `entry did not activate`；
而**干净的 0.3.1**（缺 `immediately`）在同样环境里稳定复现 `dsh-adapt-packs: failed`。这就是 22:38 那次故障的根因。

### Fixed（0.3.3）

- `dsh.client.immediately: true`：只带设置面板的客户端模块必须随 boot 注入。缺这一项时模块会被推迟，浏览器侧把条目判成 `dsh-adapt-packs: failed`（这就是 22:38 那次「服务器拉不起来、插件 fail」的真正原因）。回归测试锁住这个字段。
- 0.3.2 的 `apply` 兜底保留：拿不到 `settings.section` 时只 warn 不抛，避免整条 bundle 失败。

### Fixed（0.3.2）

- 设置分区注册失败不再让整条 bundle 判 failed：在缺少 `settings.section` 的 profile（例如只有 `dsh-base + dsh-web-app`）里，`slots.inject` 会抛异常，之前会把 `dsh-adapt-packs: failed` 带进 web boot；现在静默降级（控制台留一条 warn，CLI 不受影响）。补了一条测试。

### Fixed（设置页 UI，0.3.1）

- 「安装」主按钮在深色主题下不可见：原先用 `--dsw-alias-label-primary` 当底色、`--dsw-alias-bg-base` 当字色，两个 token 在深色主题下可能同时接近白色；改成中性半透明底 + `currentColor` 描边 + 加粗，两种主题都可见。
- 兼容清单的结论徽章换行成「有适 / 配包」：加 `white-space: nowrap`。
- 包名与 id 相同时卡片标题重复（`core-panel core-panel`）：名字等于 id 时只显示一次。

### 收口 dsh-mobile 0.8.0 实测（2026-10-31）

依据：`实测-0.8.0-20261031.md`（真实网关 `https://192.168.1.11:3443`，390×844 粗指针，
Plugins 面板；#319 / #316 均**不在** 0.8.0 安装包内，v0.8.0 发布于 10-30T03:14Z，
两 PR 合入 main 于 10-31T08:46Z）。

**Changed**

- `core-panel`：面板状态改用**包自有**的 `data-dshm-adapt-panel`，不再写宿主的
  `data-dsh-panel`（#319 起由宿主维护，旧实现会与宿主抢写）。
- `core-panel`：高度地板（44px）与面板根宽度收口（`max-width:100%`）加上版本门阀
  `.dshm-main:not([data-dsh-panel])`——0.8.x 上仍由本包提供（纯宿主 94/94 控件 <44px，
  本包抬起 53 个）；宿主接管面板状态后退让，不重复叠加。
- `core-panel`：`min-width:44px`（svg-only 图标按钮）**不设门阀**，两条发布线都保留
  （宿主 #319 只给高度）。
- `shell-chrome`：返回栏规则从 `44px !important` 改为特异性 0、无 `!important` 的
  **rise-only** 兜底。0.8.0 宿主 `.dshm-panelBack` 已是 48px，旧规则会把 48 压成 44
  （panelNav 57→56，实测负收益）；现在宿主更大时不动它，宿主没给时才抬到 44px。
- `catalog.json`：`core-panel.capabilities` 去掉 `rail-clearance`；`usesHostMarkers`
  去掉 `.dshm-drawer`、加入 `[data-slot="main"]`；`verifiedWith` 增加
  `dshMobileMain: "post-#319 (6c50b13, unreleased)"`；三个包的 `evidence` 换成
  0.8.0 运行时数值并标注【事实】/【推断】。
- `tools/check-pack.mjs`：
  - 选择器作用域接受包自有的 `data-dsh*="1"` 状态属性（任意包内命名，如 `data-dshm-adapt-panel`、`data-dsh-floaters`）与宿主的 `[data-dsh-panel]`（含 `:not()` 形式）；
  - 新增 host-probe：声明了门阀的包会伪造「宿主已写 `data-dsh-panel`」，断言门阀退让、
    宿主属性未被改写、`min-width` 仍生效（`runtime.hostGate.*`）；
  - 移除 `rail-clearance` 断言组（能力已退役），390×844 指标表里「面板左缘」判据从
    `≥ 56px` 改为 `= 基线`。
- `tools/phone-instance.mjs`：探针改读 `data-dshm-adapt-panel`（并打印宿主的 `data-dsh-panel`），移除 `--dshm-rail`。
- 文档：`packs/core-panel/README.md`、`packs/shell-chrome/README.md`、
  `packs/floaters/README.md`、根 `README.md`（新增「Two release lines: 0.8.0 vs main」）、
  `docs/收录标准.md`（新增面板状态归属与 release/main 口径，`rail-clearance` 标为退役）、
  `docs/定向-fixture.md`、`packs/_template/README.md`、`docs/examples/fixture-pack/`
  同步；新增本 CHANGELOG。

**Removed**

- `core-panel` 的 `rail-clearance`：390 面板态抽屉是 `data-right-modal` → `display:none`
  （宽 0），768 上宿主已 `margin-left:56px` 让位且 `@media (max-width:720px)` 不命中——
  两种尺寸都没有可测量的让位场景（实测 `--dshm-rail` = 0px / 56px，面板左右缘不变）。
  连带删除 `--dshm-rail` 变量、`measureRail()` 与 check-pack 的对应断言组。

**Unverified**

- 含 #319 的构建（≥0.8.1，尚无 tag）：门阀退让只在 check-pack 的 host-probe 合成状态下验证，
  未在真实宿主上量。
- 真机（iOS / Android WebView）：拇指准确度、真实 `env(safe-area-inset-bottom)`（headless 为 0）、
  软键盘后的可视区。
- `width-reclaim` 与底部安全区在 0.8.0 上「规则在、场景没有」（面板态 390/390、768/768 无溢出）。
- `shell-chrome` 抽屉行的 `!important` 若遇到宿主 >44px 的行高会压小（当前宿主 36px，风险未发生）。

## [0.1.0] — 2026-10-30

- 首批三张包：`core-panel`（44px 命中区 + 宽度回收 + 56px 轨道让位）、`shell-chrome`
  （返回栏 / 抽屉行）、`floaters`（右下浮动控件让位），均 `default: off`、可 `data-dsh-adapt="off"`。
- `check-pack` 三层校验（static / runtime / desktop）与定向 fixture 契约。
- 当时的证据基线是 dsh-mobile 0.7.1 运行时 + Playwright fixture。
