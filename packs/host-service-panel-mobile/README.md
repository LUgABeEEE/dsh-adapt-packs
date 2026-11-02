# host-service-panel-mobile · 主机观测面板移动下限

> 修的是 **`dsh-host-service-panel`（面板名「主机服务」）的主面板**。手机上两个真问题：
> ① 概览 6 格在窄屏落成 2 列 × 3 行，把「整体有没有事」的第一屏挤走；
> ② 页头 `flex-wrap` 之后采样串压在概览格上（390 实测），且按钮高 26/30px、输入 26px 点不中。

## 元信息

- **目标插件**：`dsh-host-service-panel`，实测版本 `0.7.5`。
- **实测设备**：stock DSH web + dsh-ui-lab 设备仿真 —— 360×800 / 390×844 / 768×1024（`pointer: coarse`）、
  1280×800（精指针回归）。**真机尚未验**，见 catalog 的 `evidence.missing`。
- **用到哪些宿主标记**：`.dshm-shell` / `.dshm-main` / `.dshm-mainContent` / `[data-slot="main"]`。
  面板自有标记（本包点名的全部）：`[data-dsh-hsp-root]` `-head` `-beat` `-overview` `-ov`
  `-ov-value` `-ov-sub` `-signal` `-signal-text` `-card` `-kv` `-kv-value`。
  这些是 0.7.5 起对外承诺的稳定标记，**不依赖 `hsp-*` 私有类名**。
- **opt-out**：`<html data-dsh-adapt="off">` 时全部规则失效；面板回到自己的尺寸。注意：0.8.1 起该属性同时是宿主地板的门阀（`lib:507`），会连宿主地板一起关；只关本包请停用扩展。
- **回滚**：删掉 `$DSH_HOME/mobile-access/extensions/host-service-panel-mobile/`（约 2s 生效）。本包不改任何已安装文件。
- **状态 / 风险 / 默认值**：见仓库根 `catalog.json`，不写进 `extension.json`。

## 包内文件

| 文件 | 说明 |
|---|---|
| `extension.json` | 5 字段清单 |
| `mobile.css` | 纯样式：概览重排 / 页头行距 / 触控下限 |
| `fixture.html` | 定向 DOM，元素与 `src/client/index.js` 一一对应 |
| `shots/` | 390×844 改前 / 改后 |

## 设计取舍

- **只抬 `min-height`，不加 `min-width`**：`.hsp-btn` / `.hsp-air-tab` 是 `border-radius: 999px` 的胶囊，
  44×44 会把「刷新」渲染成一个圆球（第一版实测如此）。本面板没有纯图标按钮，所以不设宽度下限。
- **不用 `:has()`**：老 WebView 不支持；需要区分的状态用 data 属性（check-pack 强制）。
- **不改外壳职责**：轨道让位、浮动控件让位不属于本包。

## 验收

```
node tools/check-pack.mjs       → host-service-panel-mobile：STATIC + RUNTIME 全 PASS
                                  390×844 13/13 按钮 ≥44、输入 44 / 16px
                                  关掉适配 → 逐项回落基线；1280 精指针 → 零改动
```
