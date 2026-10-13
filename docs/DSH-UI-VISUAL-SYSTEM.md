# DSH 插件 UI 视觉系统 —— 完整逻辑总结

> 从 `dsh-webin` 设置页（`src/client/index.ts` 的 `CSS` 常量 + `LdwSettings` 组件）提取。
> 目标是**可移植**：换任何 DSH 插件项目都能整套照搬。

---

## 0. 一句话概括

**不写死任何颜色，全部走 DSH 主题令牌；层级靠 `layer-1/2/3` 三档凹槽；
动效只动 `transform`/`opacity`；所有「写错了也不报错」的东西都用测试钉住。**

---

## 1. 三条铁律（违反必出问题）

### 铁律一：令牌必须真实存在（否则静默失效）

`var(--dsw-xxx)` 取不到值时**不报错、不崩**，CSS 直接回退到 inherit/透明 ——
颜色悄悄没了，肉眼 review 极难发现。

**实测踩过的三个错名：**

| 写错的 | 真实的 | 后果 |
|---|---|---|
| `--dsw-alias-state-warning-primary` | `--dsw-alias-state-warn-primary` | 警告色标签/提示条/状态点全部失色 |
| `--dsw-alias-label-on-accent` | `--dsw-alias-label-primary-inverted` | 主按钮上的文字看不见 |
| `--dsw-font-xs-12` | `--dsw-font-xs-13` | 字号回退到继承值 |

**核对方法（机器核对，不靠肉眼）：**

```js
const dsh = readFileSync('F:/.../resources/app.asar', 'latin1')
const declared = new Set([...dsh.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
const referenced = new Set(dsh.match(/--dsw-[a-z0-9-]+/g) ?? [])
const used = [...new Set(src.match(/--dsw-[a-z0-9-]+/g) ?? [])]
const missing = used.filter((u) => !declared.has(u) && !referenced.has(u))  // 必须为空
```

也可以用运行时 Inspect 拿官方清单：

```
cordis_inspect_query(platform: 'client', provider: 'Theme', method: 'listTokens')
```

⚠️ Inspect 的清单是**精选别名**（14 个），比真实可用集合小 —— 查不到的令牌
要再去 asar 里核对一次（`label-quaternary`、`bg-layer-3`、`border-l3`
都不在 Inspect 清单里但真实存在）。

### 铁律二：禁止写死颜色

```css
/* ❌ 错：浅色主题下就是错的颜色 */
color: var(--dsw-alias-state-warn-primary, #f0a441)

/* ✅ 对：令牌一定存在，不要兜底 */
color: var(--dsw-alias-state-warn-primary)
```

**唯一允许的写死**：开关圆点在开启态的白色 `background:#fff` —— 因为它坐在
品牌色轨道上，任何主题下都该是白的。这类例外要在测试里显式豁免。

回归断言（正则直接查源码）：

```js
const hardcoded = [...client.matchAll(/\.ldw-[a-z-]+[^}]*?(?:background|color):\s*#[0-9a-fA-F]{3,6}/g)]
  .filter((m) => !m[0].includes('background:#fff'))   // 豁免开关圆点
check('没有写死的 background/color', hardcoded, [])
```

### 铁律三：令牌是「昼夜自动切换」的，不要自己判断主题

所有 `--dsw-alias-*` 都有 light/dark 两套值，宿主切换时 CSS 变量自动变。
插件**不需要**（也不应该）读主题状态、写 `prefers-color-scheme`、
或维护自己的暗色样式表。

---

## 2. 令牌字典（按用途分类）

### 背景层级（三档凹槽，是整套视觉的骨架）

| 令牌 | 用途 | 视觉语义 |
|---|---|---|
| `--dsw-alias-bg-base` | 应用底色 | 最底 |
| `--dsw-alias-bg-layer-3` | 凹槽 / 卡片底 | **下沉** |
| `--dsw-alias-bg-layer-2` | 面板 | 中间 |
| `--dsw-alias-bg-layer-1` | 浮起元素（输入框、代码块） | **抬起** |
| `--dsw-alias-bg-overlay` | 浮层 / popover | 最上 |

**用法规则**：卡片用 `layer-3` 打底、里面的输入框用 `layer-1` ——
形成「凹槽里放凸起」的双层关系，这是整套设计看起来「有厚度」的来源。

### 文字层级（四档，从强到弱）

| 令牌 | 用途 |
|---|---|
| `--dsw-alias-label-primary` | 标题、正文主体 |
| `--dsw-alias-label-secondary` | 副标题、说明文字 |
| `--dsw-alias-label-tertiary` | 提示、时间戳 |
| `--dsw-alias-label-quaternary` | 最弱：占位符、禁用态、字段标签 |
| `--dsw-alias-label-primary-inverted` | 反色（品牌色背景上的文字） |

### 边框（三档）

| 令牌 | 用途 |
|---|---|
| `--dsw-alias-border-l1` | 最轻：分隔线、分节标题下划线 |
| `--dsw-alias-border-l2` | 常规：卡片、输入框、按钮边框 |
| `--dsw-alias-border-l3` | 较重：工具栏底边 |

### 状态色

| 令牌 | 用途 |
|---|---|
| `--dsw-alias-state-business-primary` | **主强调色**（品牌动作、选中、聚焦环） |
| `--dsw-alias-state-success-primary` | 成功 / 已连接 |
| `--dsw-alias-state-warn-primary` | 警告 / 待操作 |
| `--dsw-alias-state-error-primary` | 错误 / 危险动作 |
| `--dsw-alias-state-idle-primary` | 空闲 / 未激活 |
| `--dsw-alias-interactive-bg-hover` | 悬停背景 |

### 字体与圆角

| 令牌 | 值形态 |
|---|---|
| `--dsw-font-xxxs-11` | 最小档（11px） |
| `--dsw-font-xxs-12` | 小档（12px） |
| `--dsw-font-xs-13` | 次小档（13px） |
| `--dsw-font-s-14` | 标准档 |
| `--dsw-font-m-18` | 中标题 |
| `--dsw-font-l-20` | 大标题 |
| `--dsw-font-xl-24` | 特大（页头） |
| `--dsw-radius-sm` / `-md` / `-lg` / `-xl` | 圆角阶梯 |

⚠️ 字体令牌可以直接用在 `font:` 简写里：`font: var(--dsw-font-xs-13)`。

---

## 3. 颜色混合技法是核心

**不要**自己算透明度，用 `color-mix()` 从令牌派生：

```css
/* 12% 的成功色作底 —— 自带昼夜适配 */
background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)

/* 主色 24% 的选区高亮 */
::selection { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent) }

/* 边框「稍微偏主色」—— 悬停态用 */
border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 62%, var(--dsw-alias-border-l2))

/* 内容 78% + 透明 —— 半透明面板 */
background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent)
```

**为什么必须这样**：写死 `rgba(64,128,255,.12)` 在暗色主题下会脏；
`color-mix` 的混合基色是令牌 ⇒ 昼夜都自动正确。

**常用配方表：**

| 想要 | 配方 |
|---|---|
| 状态徽标底 | `color-mix(in srgb, {状态色} 11%, transparent)` |
| 状态徽标边 | `color-mix(in srgb, {状态色} 38%, transparent)` |
| 状态点光晕 | `0 0 0 3px color-mix(in srgb, {状态色} 18%, transparent)` |
| 聚焦环 | `0 0 0 4px color-mix(in srgb, {主色} 13%, transparent)` |
| 卡片悬停边框 | `color-mix(in srgb, {主色} 66%, var(--dsw-alias-border-l2))` |
| 半透明面板 | `color-mix(in srgb, var(--dsw-alias-bg-layer-2) 82%, transparent)` |

---

## 4. 动效系统

### 缓动曲线（定义在容器上，子元素继承）

```css
.ldw-set {
  --ease-instrument: cubic-bezier(.16, 1, .3, 1);      /* 快出慢停 —— 位移/边框 */
  --ease-settle:     cubic-bezier(.34, 1.4, .4, 1);     /* 轻微过冲 —— 弹性归位 */
}
```

| 曲线 | 用在哪 | 感觉 |
|---|---|---|
| `--ease-instrument` | 悬停位移、边框变色、展开箭头 | 「精准、克制」 |
| `--ease-settle` | 开关圆点、星标旋转 | 「有弹性、活」 |
| `ease` | 透明度、颜色 | 通用 |

### 时长规范

| 场景 | 时长 |
|---|---|
| 颜色 / 边框 | 0.16–0.2s |
| 位移 / 阴影 | 0.2–0.24s |
| 覆盖层展开 | 0.3–0.4s |

### 只动 transform / opacity

```css
/* ✅ GPU 合成层，不掉帧 */
.ldw-card:hover { transform: translateY(-2px) }
.ldw-btn:hover  { transform: translateY(-1px) }
.ldw-btn:active { transform: translateY(0) }     /* 按下归位 —— 触感 */

/* ❌ 避免动 top/margin/width —— 触发重排 */
```

### 关键微交互

**卡片悬停**（抬 2px + 主色描边 + 主色投影）：

```css
.ldw-card {
  transition: transform .2s cubic-bezier(.32,.72,0,1), box-shadow .24s ease, border-color .18s ease;
}
.ldw-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 66%, var(--dsw-alias-border-l2));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 9%),
              0 16px 34px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
```

**按钮按下归位**（`hover` 抬 1px → `active` 回 0）：

```css
.ldw-btn:hover:not(:disabled)  { transform: translateY(-1px) }
.ldw-btn:active:not(:disabled) { transform: translateY(0) }
```

**开关圆点**（弹性位移 + 按住拉长 —— 拟物触感）：

```css
.ldw-switch > i::after {
  transition: transform .26s cubic-bezier(.34,1.3,.64,1), background .2s ease, width .16s ease;
}
.ldw-switch:active > i::after            { width: 17px }        /* 按住变长 */
.ldw-switch[aria-checked="true"] > i::after { transform: translateX(16px); background: #fff }
.ldw-switch[aria-checked="true"]:active > i::after { transform: translateX(13px) }  /* 时也拉长 */
```

**状态点呼吸**（只给「健康」态，2.6s 极缓）：

```css
@keyframes ldw-dot-breathe { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
.ldw-dot.ok { animation: ldw-dot-breathe 2.6s ease-in-out infinite }
```

**骨架屏 shimmer**：

```css
@keyframes ldw-shimmer { 0% { opacity: .45 } 50% { opacity: .85 } 100% { opacity: .45 } }
.ldw-skeleton { animation: ldw-shimmer 1.5s ease-in-out infinite }
```

---

## 5. 阴影：双层 bezel（质感的来源）

**不要用单层黑影**。用「内高光 + 外投影」两层，模拟真实材质的受光面：

```css
/* 卡片：hairline 边框 + 顶部内高光 + 主色投影 */
box-shadow:
  inset 0 1px 0 rgb(255 255 255 / 6%),                                    /* 顶边受光 */
  0 1px 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent),
  0 3px 10px color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent);

/* 悬停时内高光更亮 + 投影更远 */
box-shadow:
  inset 0 1px 0 rgb(255 255 255 / 9%),
  0 16px 34px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);

/* 玻璃层：backdrop-filter + 更强的内高光 */
.ldw-glass {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 68%, transparent);
  backdrop-filter: blur(16px) saturate(150%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), 0 12px 34px rgb(0 0 0 / 9%);
}

/* 输入框：内阴影 —— 「凹进去」 */
box-shadow: inset 0 1px 2px rgb(0 0 0 / 5%);
```

**层级对照表（凹/凸语义）：**

| 元素 | 内阴影 | 外阴影 | 语义 |
|---|---|---|---|
| 输入框 / 开关轨道 | ✅ inset | ❌ | 凹 |
| 卡片 / 按钮 | inset 高光 | ✅ | 凸 |
| 玻璃浮层 | inset 高光 | ✅ 大 | 最凸 |

---

## 6. 无障碍与键盘可达性

**聚焦环只给键盘，鼠标点击不出环：**

```css
.ldw-set :focus-visible {          /* 不是 :focus —— 那会让鼠标点击也出环 */
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 78%, transparent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 13%, transparent);
}
```

**语义化属性（不是装饰，是契约）：**

```js
// 开关必须是 button + role=switch + aria-checked
createElement('button', {
  type: 'button',
  className: 'ldw-switch',
  role: 'switch',
  'aria-checked': value === true ? 'true' : 'false',
  onClick: () => setField(spec.key, value !== true),
}, createElement('i'), createElement('span', { className: 'ldw-field-label' }, spec.label))

// 装饰性 SVG 必须 aria-hidden
createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', className: 'ldw-star-icon' }, ...)

// 外链必须 rel="noreferrer noopener"
createElement('a', { href, target: '_blank', rel: 'noreferrer noopener' }, ...)
```

**视觉状态用 `:has()` 联动（父元素读子元素状态）：**

```css
/* 未登录时整个入口偏警示色 —— 一眼看出「这里需要你做点什么」 */
.ldw-entry:has(.ldw-dot.warn) {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
```

---

## 7. 布局骨架

### 页面容器

```css
.ldw-set {
  display: flex; flex-direction: column; gap: 20px;
  max-width: 1080px;                    /* 阅读宽度上限 —— 防止超宽屏上文字拉太长 */
  font-size: 13px; line-height: 1.55;
  color: var(--dsw-alias-label-primary);
  -webkit-font-smoothing: antialiased;  /* 桌面端字体更清晰 */
}
.ldw-set * { box-sizing: border-box }   /* 局部重置，不影响宿主 */
```

### 页头 hero（渐变底 + 双径向光斑）

```css
.ldw-hero {
  position: relative; padding: 22px 24px; border-radius: 20px;
  background: linear-gradient(165deg,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent),
    color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent));
  overflow: hidden;
}
/* 两个角各打一束光 —— 左上主色、右下成功色 */
.ldw-hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 150% at 12% -20%,
      color-mix(in srgb, var(--dsw-alias-state-business-primary) 13%, transparent), transparent 58%),
    radial-gradient(90% 120% at 88% 130%,
      color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, transparent), transparent 60%);
}
.ldw-hero > * { position: relative }    /* 内容压在光斑之上 */
```

### 标题渐变文字

```css
.ldw-pagetitle h2 {
  font-size: 23px; font-weight: 760; letter-spacing: -.6px;
  background: linear-gradient(120deg,
    var(--dsw-alias-label-primary) 20%,
    color-mix(in srgb, var(--dsw-alias-label-primary) 55%, var(--dsw-alias-state-business-primary)));
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

### 响应式卡片网格（自动填充，无需媒体查询）

```css
.ldw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 10px;
}
```

### 表单行（三列网格：标签 | 控件 | 说明）

```css
.ldw-fieldrow {
  display: grid;
  grid-template-columns: minmax(150px, 1.1fr) auto 1fr;
  gap: 10px; align-items: center; padding: 5px 0;
}
.ldw-fieldrow .ldw-hint { font-size: 11px; color: var(--dsw-alias-label-quaternary); line-height: 1.45 }
```

### 分节标题（左侧 3px 主色竖条）

```css
.ldw-group-title { font-size: 12.5px; font-weight: 640; display: flex; align-items: center; gap: 7px }
.ldw-group-title::before {
  content: ""; width: 3px; height: 12px; border-radius: 2px; flex: none;
  background: var(--dsw-alias-state-business-primary);
}
```

### 折叠区（原生 `<details>`，自绘三角箭头）

```css
.ldw-details > summary { cursor: pointer; list-style: none; padding: 13px 16px;
  display: flex; align-items: center; gap: 9px; transition: background .16s ease }
.ldw-details > summary::-webkit-details-marker { display: none }   /* 去掉默认三角 */
.ldw-details > summary::before {                                   /* 自绘三角 */
  content: ""; width: 0; height: 0; flex: none;
  border-left: 5px solid var(--dsw-alias-label-tertiary);
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform .22s var(--ease-instrument);
}
.ldw-details[open] > summary::before { transform: rotate(90deg) }  /* 展开转 90° */
```

---

## 8. 状态表达系统（颜色说话，不靠文字喊）

**状态点三态：**

```css
.ldw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary) }
.ldw-dot.ok   { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(...18%...); animation: breathe }
.ldw-dot.warn { background: var(--dsw-alias-state-warn-primary);    box-shadow: 0 0 0 3px color-mix(...18%...) }
.ldw-dot.err  { background: var(--dsw-alias-state-error-primary);   box-shadow: 0 0 0 3px color-mix(...18%...) }
```

**胶囊状态标签（pill）：**

```css
.ldw-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;                    /* 全圆角 */
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  transition: border-color .16s ease, color .16s ease;
}
.ldw-pill.strong { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2) }
```

**图标色标签（tag）：**

```css
.ldw-tag.ok   { color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 38%, transparent);
  background:   color-mix(in srgb, var(--dsw-alias-state-success-primary) 11%, transparent) }
```

**提示条 callout（默认警告色，`.err` 切错误色）：**

```css
.ldw-callout {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent);
  font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary);
}
.ldw-callout.err { /* 同上，换 error-primary */ }
```

**徽标（badge）：**

```css
.webin-badge-on  { color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent) }
.webin-badge-off { color: var(--dsw-alias-label-quaternary); background: var(--dsw-alias-bg-layer-2) }
```

**次要入口做成链接而非按钮**（视觉权重 = 重要性）：

```css
.ldw-linkbtn {
  border: 0; background: none; padding: 2px 4px; cursor: pointer;
  color: var(--dsw-alias-label-quaternary); text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);  /* 淡下划线 */
}
.ldw-linkbtn:hover { color: var(--dsw-alias-label-secondary) }
```

---

## 9. CSS 注入机制

```js
// 随插件生命周期注入 / 卸载 —— ctx.effect 的返回值是清理函数
ctx.effect(() => {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}, 'dsh-webin: stylesheet')
```

**要点：**

- 用 `ctx.effect` 而不是裸 `appendChild` —— 插件卸载时样式要跟着走，
  否则重载插件会累积多份样式表
- label 参数（第三个）会显示在 DSH 的 effect 调试面板里，便于定位
- CSS 用**带前缀的类名**（`.ldw-*` / `.webin-*`）避免和宿主冲突
- 局部重置用 `.ldw-set *` 而不是全局 `*`

---

## 10. 配置表单的数据驱动骨架

**接口 —— 一个字段的全部信息：**

```ts
interface FieldSpec {
  key: keyof WebinConfig
  label: string
  unit?: string          // 单位（ms 会自动换算成秒显示）
  hint?: string          // 说明文字
  bool?: boolean         // true ⇒ 渲染成开关
  scale?: number         // 显示换算（存 ms 显示秒 ⇒ scale: 1000）
}
```

**分组按「用户意图」而非「技术模块」：**

```ts
const FIELD_GROUPS = [
  { title: '防封号', note: '网页版对请求密度敏感。调更保守 = 更慢但更安全。', fields: [...] },
  { title: '行为',   note: '遇到超时、结果被截断时来这调。',               fields: [...] },
  { title: '诊断',   note: '出问题时打开，看浏览器控制台。',               fields: [...] },
]
```

⚠️ **这是关键设计决策**：用户面对 11 个数字会懵。按「什么时候需要来调」
分组（担心封号 / 遇到问题 / 排查故障），比按「发送 / 超时 / 日志」分组有用得多。

**渲染函数（布尔走开关，数值走输入框）：**

```js
const renderField = (spec) => {
  const value = form[spec.key]
  const limit = LIMITS[spec.key]
  const scale = spec.scale ?? 1
  const unit  = scale === 1000 ? '秒' : (spec.unit ?? '')
  const rangeText = limit ? `${Math.round(limit.min/scale)}~${Math.round(limit.max/scale)}${unit}` : ''

  if (spec.bool === true) {
    return createElement('div', { key: spec.key, className: 'ldw-fieldrow' },
      createElement('button', { type: 'button', className: 'ldw-switch', role: 'switch',
        'aria-checked': value === true ? 'true' : 'false',
        onClick: () => setField(spec.key, value !== true) },
        createElement('i'), createElement('span', { className: 'ldw-field-label' }, spec.label)),
      createElement('span'),
      createElement('span', { className: 'ldw-hint' }, spec.hint ?? ''))
  }

  return createElement('div', { key: spec.key, className: 'ldw-fieldrow' },
    createElement('span', { className: 'ldw-field-label' }, spec.label),
    createElement('span', { className: 'ldw-field-inline' },
      createElement('input', { type: 'number', className: 'ldw-num',
        value: scale === 1000 ? Math.round(Number(value)/scale) : Number(value),
        min: limit ? Math.round(limit.min/scale) : undefined,
        max: limit ? Math.round(limit.max/scale) : undefined,
        step: 1,
        onChange: (e) => { const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          setField(spec.key, Math.round(n * scale)) } }),
      createElement('span', { className: 'ldw-unit' }, unit)),
    createElement('span', { className: 'ldw-hint' },
      [rangeText, spec.hint].filter((s) => s !== undefined && s !== '').join(' · ')))
}
```

**保存前不生效（本地草稿态）：**

```js
const [form, setForm] = useState(null)        // 本地编辑态
const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }))
// 「保存」才 POST /config；「重置」重新拉取
```

**服务端回传字段问题时逐条列出：**

```js
problems.length > 0
  ? createElement('div', { className: 'ldw-callout err' },
      createElement('div', null,
        createElement('strong', null, `${problems.length} 个字段被修正`),
        createElement('ul', null, ...problems.map((p, i) =>
          createElement('li', { key: i }, `${p.field}：${p.reason}`)))))
  : null
```

---

## 11. 加载态（数据到位前不整页跳动）

```js
if (state === null) {
  return createElement('div', { className: 'ldw-set' },
    createElement('div', { className: 'ldw-hero' },        // 页头骨架照常渲染
      createElement('div', { className: 'ldw-pagehead' },
        createElement('div', { className: 'ldw-pagetitle' },
          createElement('h2', null, 'LDW · 网页版接入'),
          createElement('p', { className: 'ldw-pagesub' }, '正在读取平台与配置…')))),
    createElement('div', { className: 'ldw-grid' },
      ...[0, 1].map((i) => createElement('div', { key: i, className: 'ldw-card' },
        createElement('div', { className: 'ldw-skeleton', style: { width: '55%' } }),
        createElement('div', { className: 'ldw-skeleton', style: { width: '85%' } }),
        createElement('div', { className: 'ldw-skeleton', style: { width: '70%' } })))))
}
```

**要点**：骨架屏复用真实布局的类名（`ldw-hero` / `ldw-grid` / `ldw-card`），
只是内容换成 `.ldw-skeleton` 条 —— 数据到位时**结构不跳**，只有内容淡入。

---

## 12. 可移植性清单（换项目照做）

- [ ] 类名统一前缀（如 `.xxx-`），避免与宿主冲突
- [ ] 页面容器定义缓动曲线变量，子元素继承
- [ ] 三档背景层级定好：凹槽 `layer-3` → 面板 `layer-2` → 浮起 `layer-1`
- [ ] 所有颜色走 `color-mix(in srgb, var(--dsw-*) N%, ...)`
- [ ] 阴影用「内高光 + 外投影」双层
- [ ] 聚焦环用 `:focus-visible`（不是 `:focus`）
- [ ] 开关用 `button[role=switch][aria-checked]`
- [ ] 动效只动 `transform` / `opacity`，时长 0.16–0.4s
- [ ] 骨架屏复用真实布局类名
- [ ] 样式注入走 `ctx.effect` 并返回清理函数
- [ ] **加一条测试：所有 `--dsw-*` 令牌在 DSH 产物里真实存在**
- [ ] **加一条测试：没有写死的 `background`/`color` 十六进制**（开关圆点豁免）

---

## 13. 测试断言（直接可用）

```js
// ① 令牌存在性（最重要 —— 写错不报错）
const dsh = readFileSync(DSH_ASAR_PATH, 'latin1')
const declared   = new Set([...dsh.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
const referenced = new Set(dsh.match(/--dsw-[a-z0-9-]+/g) ?? [])
const used = [...new Set(src.match(/--dsw-[a-z0-9-]+/g) ?? [])].filter((t) => t !== '--dsw-alias-')
const missing = used.filter((u) => !declared.has(u) && !referenced.has(u))
check('全部令牌真实存在', missing.length, 0)

// ② 没有写死颜色（开关圆点豁免）
const hardcoded = [...src.matchAll(/\.xxx-[a-z-]+[^}]*?(?:background|color):\s*#[0-9a-fA-F]{3,6}/g)]
  .filter((m) => !m[0].includes('background:#fff'))
check('没有写死的 background/color', hardcoded, [])

// ③ 关键视觉手法在位（防止被误删）
check('用 color-mix 派生颜色', /color-mix\(in srgb/.test(src), true)
check('聚焦环用 :focus-visible', /:focus-visible/.test(src), true)
check('开关有 role=switch', /role: 'switch'/.test(src), true)
check('开关有 aria-checked', /'aria-checked'/.test(src), true)
check('用了缓动变量', /--ease-instrument/.test(src), true)
check('有骨架屏', /ldw-skeleton/.test(src), true)
```

---

## 附：本次总结顺带修掉的三个真 bug

总结过程中对照 DSH 产物核对令牌，发现三个**静默失效**（不报错、不崩、
只是颜色/字号悄悄不对）—— 已全部修正并加测试钉住：

| 位置 | 写错 | 改对 | 症状 |
|---|---|---|---|
| 警告色（10 处） | `state-warning-primary` | `state-warn-primary` | 警告标签/提示条/状态点失色 |
| 主按钮文字 | `label-on-accent` | `label-primary-inverted` | 品牌色按钮上文字看不见 |
| 小字号（2 处） | `font-xs-12` | `font-xs-13` | 字号回退到继承值 |

同时删掉 10 处写死的兜底色 `#f0a441`（真令牌存在后不再需要，
且浅色主题下那个橙色是错的）。
