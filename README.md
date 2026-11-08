# dsh-preset-tuning

按 **agent preset** 过滤工具、隐藏技能，并提供一个 Web 页面来调。

同一次改动只影响所选 preset：工具的 schema 不再进入上下文，技能从目录里消失，
而提供它们的插件**照常运行**。

```
┌─ preset 平面 ────────────────────────────────────────────┐
│  dsh-preset-tuning/preset                                │
│    订阅规则 → 对每个 agent 施加工具掩码 → 注册技能影子      │
├─ profile 平面 ───────────────────────────────────────────┤
│  dsh-preset-tuning        规则 / 清单 / 基线 / 排序的来源  │
│  dsh-tuning-ui            「注入筛选」页面                 │
└──────────────────────────────────────────────────────────┘
```

## 目录结构

```
dsh-preset-tuning/
├─ packages/
│   ├─ preset-tuning/          preset 平面插件 + profile 平面服务
│   │   ├─ preset.js           工具掩码、技能影子、提示词段
│   │   ├─ index.js            Host 服务：规则 / 清单 / 基线 / 排序，POST /api/tuning
│   │   ├─ owners-scan.js      静态扫描安装目录，推导「工具 → 归属组」
│   │   └─ ARCHITECTURE.md     内部设计细则
│   └─ tuning-ui/              Web 界面
│       ├─ index.js            随服务注册的端点入口
│       ├─ client.js           设置 → 插件 → 注入筛选
│       └─ cordis.patch.yml
└─ tools/gen-owners.mjs        离线重建归属表
```

## 安装

**第一步：装上两个包**（profile 平面）

```bash
pnpm add file:<本仓库>/packages/preset-tuning file:<本仓库>/packages/tuning-ui
```

两个包都声明了 `dsh.bundle.patch`，profile 会据此把它们挂成 Loader 行：

```
tuning-registry   → dsh-preset-tuning（Host 服务 + 端点）
tuning-ui         → dsh-tuning-ui（页面）
```

**第二步：在目标 preset 里加一行**（preset 平面）

preset 的插件列表里加：

```yaml
- id: preset-tuning
  name: dsh-preset-tuning/preset
  config:
    key: my-preset       # 规则文件的键名，也是页面上的 preset 标识
```

> 为什么不能自动：profile 平面的插件不在 agents 作用域里，收不到 `agent/created`。
> 想按 agent 施加限制，就必须挂在那个 preset 内部。

改完重启 DSH。之后打开 **设置 → 插件 → 注入筛选**。

## 配置

运行期数据都在 `$DSH_HOME/preset-tuning/`（`$DSH_HOME` 缺省是 `~/.dsh`）。
刻意不放进 `node_modules`——那里升级会被覆盖；也不摊在 home 根目录，避免和别的插件挤在一起。

| 文件 | 谁写 | 用途 |
|---|---|---|
| `rules.json` | 人 / 页面 | 规则：哪些工具禁用、哪些技能隐藏 |
| `owners.json` | 人 | 归属的**手工覆盖**，通常为空 |
| `owners.generated.json` | 程序 | 扫描产物，**不要手改** |
| `state.json` | 程序 | 基线（上次看到的清单）+ 各分段的展示顺序 |

规则形状：

```jsonc
{
  "my-preset": {
    "tools": {
      "deny": ["mcp__notion__notion-calendar-*"],  // glob，命中即隐藏
      "allow": [],                                  // 白名单，优先于 deny
      "except": []                                  // deny 里的例外
    },
    "skills": { "deny": ["archify"] }               // 按名字隐藏技能
  }
}
```

**改 `rules.json` 是热生效的**：服务监听文件 → 通知预设插件 → 撤销旧掩码、重新施加。
连当前会话都立刻变化，不需要重启或新建会话。

## 机制

### 工具：`restrict()`

在 `agent/created` 里对 `agent.ctx.tools.restrict({ deny })` 施加掩码：

```js
agent.ctx.tools.restrict({ deny: [...], allow: [...], except: [...] })
```

掩码对**祖先作用域**的工具生效——preset 作用域是 agent 作用域的祖先，所以能隐藏
profile 平面注册的工具（含全部 MCP 工具）。被隐藏的工具 schema 完全退出上下文。

### 技能：没有 `restrict()`，用"影子"

技能注册表（`dsh-skill`）**没有**工具那样的排除接口，`SkillViewOptions` 只有
`scope` / `cwd` / `signal`。但它和工具注册表同一形状：**按作用域分层，更近的层遮蔽
更远的同名技能**。

所以在 preset 作用域注册一个同名"影子"：

```js
ctx.skills.register({
  name: 'archify',
  description: '（本 preset 中已隐藏）',
  content: '…',
  source: 'runtime',
  invocation: { modelInvocable: false, userInvocable: false },
})
```

真身在远层被遮蔽，影子因不可调用而退出目录——净效果是**只对本 preset 不可见，
插件照常运行**。已实测：提供方 Loader 行仍 `active`，而模型技能目录里该名字消失。

### 归属：静态扫描

工具注册表只存 `名字 → 定义`，不记录来源；生成的 api-catalog 也只覆盖 Service/Event。
所以"这个工具是哪个插件注册的"只能靠**扫描安装目录**。

`owners-scan.js` 覆盖五种注册写法：

```js
ctx.tools.register({ name: "x", parameters })         ① 内联定义
const t = { name: "x", parameters }; register(t)      ② 名字与注册分离
defineTool({ name: "x" })                             ③ 显式构造
export const X = 'x';  name: X                        ④ 常量引用
config.toolName ?? "x" / z.string().default("x")      ⑤ 配置默认值
```

两条硬要求：

- **必须扫整个 `lib/`，不能只读入口**——`plugin_manager` 就定义在 `lib/types/tools.js`
- **必须递归进 `<pkg>/node_modules/@deepseek-ai`**——DSH 的依赖是嵌套安装的，
  绝大多数插件在那个位置

**误判无害**：扫描结果只是候选，归类时只对**实时存在**的工具生效，不存在的名字自动失效。
所以规则可以放宽以换召回率。

### 自愈

打开页面时如果发现归不了类的工具（装了新插件就会出现），服务会自动补扫一次并刷新
`owners.generated.json`，60 秒冷却。没有缺口就不扫。

## 限制

- **`skill` 装载器工具不能关**。关掉它会让**整个技能目录**不再发布——想禁用某个技能，
  用技能区的开关，不要动这个工具。
- **零工具的组件不显示**。页面列的是工具，不是 Loader 行；只挂服务的插件不会出现。
- **项目内技能没有包名**（路径里没有 `node_modules`），会落到 `filesystem` 组。
- **清单需要活跃会话**。该 preset 还没跑过会话时，服务拿不到清单。
- **扫描认不出动态拼出来的工具名**，这类会留在「未归类」，但依然可配置。

## 开发

重建归属表（平时不需要，页面会自愈）：

```bash
node tools/gen-owners.mjs [<node_modules 根>]
```

改客户端 `client.js` 后：升 `packages/tuning-ui/package.json` 的版本号 →
在插件页禁用/启用 `tuning-ui` → 刷新页面。

改 Host 侧代码（`index.js` / `preset.js` / `owners-scan.js` 等）：**必须重启 DSH**，
禁用/启用不够（ESM 模块缓存）。
