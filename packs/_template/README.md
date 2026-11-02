# &lt;id&gt; · &lt;name&gt;

> 一句话：修的是**哪个插件的哪个面板**、在手机上是什么问题（叠字 / 点不中 / 被轨道盖住 / 顶栏占半屏）。

> **这是模板。** `cp -r packs/_template packs/<id>` 之后，把本文件里的 `<...>` 全部替换掉。
> `_template` 目录以下划线开头，是唯一不参与 `check-pack` 的目录，因此模板里的 `id: example-pack` 与「id 必须等于目录名」不冲突；复制后两者必须一致。

## 元信息

- **目标插件**：`<插件包名 / 面板名>`，实测版本 `<x.y.z>`。**必须点名**；写「适配所有插件」的包不收。
- **实测设备**：`<机型 · 系统 · 浏览器/WebView 版本>`，至少一台真机。
- **用到哪些宿主标记**：`.dshm-*` / `[data-slot]` / `[role=dialog]` ……（用到的 `.dshm-*` 必须同时登记进 `catalog.json` 的 `usesHostMarkers`，那是债务登记，标记消失＝这张包失败）
- **opt-out**：目标插件根加 `[data-dsh-adapt="off"]`，或面板级 CSS 变量 `--<name>`；说明怎么关、并实测关掉后本包数值回落到基线。**不要写「恢复官方原状」**：0.8.1 起该属性同时是宿主面板地板的门阀（`lib:507`），`off` 会把宿主地板一起关（结果可能比不装包更差）；只关本包请停用扩展。
- **回滚**：删掉 `$DSH_HOME/mobile-access/extensions/<id>/` 即回滚（2s 生效）；本包不改任何已安装的 DSH 产物。
- **状态 / 风险 / 默认值**：写在仓库根 `catalog.json`，**不写进 `extension.json`**。

## 包内文件

| 文件 | 必须 | 约束 |
|---|---|---|
| `extension.json` | 是 | **只能 5 个字段**：`schemaVersion`（必须 `1`）、`id`、`name`、`version`、`description`。多一个字段整包被拒（`src/extensions.ts`）。`id` 必须等于目录名，匹配 `^[a-z][a-z0-9-]{0,63}$`，且 `extension.json` ≤ 64 KB |
| `mobile.css` | 可选 | 纯样式包的唯一产物；≤ 512 KB；选择器必须收敛到目标面板，必须实现 opt-out |
| `mobile.js` | 可选 | ≤ 1 MB；只做宿主替不了的事（打**自己命名**的面板状态属性、MutationObserver、量值）；必须 `window.dshMobile.define`。**不要写宿主的 `data-dsh-panel`**（dsh-mobile #319 起由宿主维护），需要面板状态时用 `data-dshm-adapt-panel` 这类自有属性 |
| `fixture.html` | 可选（定向 pack 建议有） | 只给 `check-pack` 用的定向 DOM：≤ 256 KB、完整 HTML、只放 DOM + 内联 `<style>`、不得有脚本/事件处理属性/外链/`data:` 资源。存在时替代内置 fixture 跑全部运行时断言；契约见 `docs/定向-fixture.md` |
| `README.md` | 是 | 就是本文件；目标插件、宿主标记、opt-out、回滚、真机验证、截图 |
| `shots/` | 是（收录时） | before / after PNG，不参与运行时 |
| `assets/` | 可选 | 仅当 `mobile.js` 需要图片/字体；单文件 ≤ 8 MB、最多 256 个，不参与 CSS 注入 |

运行时只读 `extension.json` / `mobile.js` / `mobile.css` / `host.mjs` / `assets/`；根上的 `README.md`、`fixture.html`、`shots/` 会被忽略，可以放心写文档与校验夹具。定向 pack 的 `fixture.html` 放在包根目录，`check-pack` 会自动发现它；没有它时回退内置 fixture 并在报告里标注。

## mobile.js 的形状（可选）

```js
window.dshMobile.define({
  apiVersion: 1,
  id: '<id>', // 必须等于目录名
  async activate(api) {
    // api: { host: { invoke, fetch, assetUrl }, ui: { registerSurface, open, close, toast },
    //        native, signal, document, window }
    const style = api.document.createElement('style')
    api.document.head.append(style)
    return () => {
      // 清理：移除 style、断开 observer、撤销标记
      style.remove()
    }
  },
})
```

约定：能力能用 CSS 表达就用 CSS，`mobile.js` 只做宿主替不了的事。`activate` 返回的清理函数必须真正撤销所有副作用。

## 能力

只勾**真的做了**的能力（登记在 `catalog.json` 的 `capabilities`，逐条对应断言见 `docs/收录标准.md`）：

- [ ] `hit-target` —— 粗指针下面板内 `button / select / input` ≥ 44px
  - 若规则以宿主的 `data-dsh-panel` 为门阀（只在宿主没有 #319 地板时兜底），`check-pack` 会额外跑 host-probe，断言门阀真的退让、且 shim 不改写宿主属性。
- [ ] `width-reclaim` —— 面板根不横向溢出（左右缘都在视口内）
- [ ] `chrome-collapse` —— `data-dsh-chrome="header"` 折叠顶栏
- [ ] `notice-collapse` —— `data-dsh-chrome="notice"` 折成一行且可展开
- [ ] `scroll-owner` —— 面板状态主区可滚，不夺插件自己的滚动

未勾的能力**不得出现对应选择器**（例：CSS 里出现 `[data-dsh-chrome=notice]` 就必须勾 `notice-collapse`）。

## 验证

```bash
node tools/check-pack.mjs packs/<id>
```

静态（`extension.json` 字段 / id / 体积 / 选择器作用域 / 未勾能力选择器）+ 390×844 实测（Playwright，真实盒模型）+ opt-out 检查 + before/after 两张图。实现见 `tools/check-pack.mjs`。

## 审查记录

- 真机验证：`<日期 · 设备 · 结论>`
- 已知限制：`<宿主版本、面板状态、动态渲染的例外>`
