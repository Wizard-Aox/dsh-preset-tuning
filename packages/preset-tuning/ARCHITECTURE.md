# dsh-preset-tuning / tuning-registry / dsh-tuning-ui

按 preset 裁剪「模型在这个会话里能看到什么」：**工具过滤** + **提示词注入**，并带一个网页配置界面。

三件套：

```
Profile 平面  tuning-registry.js     Host 服务：持有规则、工具清单、基线；watch 规则文件
Preset  平面  dsh-preset-tuning.js   订阅规则 → 施加工具掩码 + 注册提示词段落
Profile 平面  dsh-tuning-ui（组合包） 配置界面：设置 → 插件 → 工具调优
                                     Host 半侧开 /api/tuning，客户端半侧渲染页面
```

## 文件位置

| 文件 | 作用 |
|---|---|
| `$DSH_HOME/plugins/tuning-registry.js` | Host 服务（profile 平面） |
| `$DSH_HOME/plugins/dsh-preset-tuning.js` | 预设插件（读规则、施加掩码） |
| `$DSH_HOME/preset-tuning.json` | **规则**，按 preset key 分组 |
| `$DSH_HOME/preset-tuning.owners.json` | **归属表**，工具名 → 插件行（可手工扩展） |
| `$DSH_HOME/preset-tuning.state.json` | **基线快照**，每份清单上次的样子 |
| `$DSH_HOME/cordis.patch.yml` | 两处声明：profile 平面的 registry 行 + preset 里的 tuning 行 |
| `<工作区>/packages/dsh-tuning-ui/` | 配置界面组合包（link 装进 web profile） |

这些插件都不放在 `profiles/web/` 下——那个目录由 Cherry Studio 管理，可能被覆盖；也都不装成
普通 npm 依赖，避免 `pnpm add` 改写 profile 的 `package.json`（依赖丢了就是「预设导入失败 →
所有会话都建不出来」）。

例外是配置界面：**客户端半侧只能挂在 profile 平面的 Loader 行上**，所以它只能作为组合包安装。

## Host 服务 API（`tuningRegistry`）

| 方法 | 作用 |
|---|---|
| `register(key, handler)` | 订阅规则；注册时立即推一次，之后文件变化再推 |
| `setRules(key, rules)` | 写规则：更新内存 + 落盘 + 通知订阅者 |
| `declareInventory(key, provider)` | 预设插件上报「我遮蔽前的工具全集」 |
| `listPresetTools(key)` | 按归属分组 + 相对基线标出 `added` / `missing` |
| `acknowledge(key)` | 把当前清单记为基线（清掉所有标记） |
| `setBaseline(key, names)` | 直接指定基线——界面里「删除某个失效工具」用这个 |

工具清单必须是**遮蔽前**的全集，否则自己下的 deny 规则会让被隐藏的工具看起来像"失效"。

## 客户端 ↔ Host 的连接方式

界面 → Host 的端点：**`POST /api/tuning`**，请求 `{ endpoint, payload }`，
响应 `{ ok: true, value }` 或 `{ ok: false, error }`。端点有：
`keys` / `state` / `setRules` / `acknowledge` / `setBaseline`。

用的是 `ctx.connection.fetch.register`，**不是** `ctx.connection.rpc.handle`：

```
rpc.handle(channel, h)  内部是 owner.effect(() => owner.webServer.register(route))
                        → 必须拿到 webServer；而 Loader 行的依赖取自【行选项】inject，
                          模块导出的 inject 不生效 → cannot get property "webServer" without inject

fetch.register(route)   只操作服务内部的 fetchRoutes 表，完全不碰 webServer  ✅
```

`/api` 被 Gateway 占为拦截器，但**精确 fetch 路由先于拦截器匹配**，所以 `/api/tuning` 归这里。

Typert Remote 是官方路线，但它的生成器不在安装包里（第三方无法生成），且要求服务是带
`typertRemote` 绑定的类实例、方法上带 marker。自用工具不值得走那条路。

## 归属与基线

- 归属表里 `groups[].id` 尽量对齐真实 Loader 行 id（`tool-fs`、`tool-pwsh`…），
  这样界面能把 `pluginInventory` 报告的行与工具对应起来。对不上的组仍会显示，只是无法交叉验证。
- 被禁用的行没有工具可分组（例如 Windows 上的 `tool-bash`）——这类行要由界面从
  `pluginInventory` 那边补上并标记为「已停用」，不能只靠工具清单。
- 基线不会自动前移：只有 `acknowledge` / `setBaseline` 才更新，否则 `[新增]` / `[失效]`
  标记会一读就消失。

## ⚠ 相对路径在两层里差两级

```
home patch 直接插入 profile 平面的行   → name: './plugins/tuning-registry.js'
                                        （基址是 $DSH_HOME，即 home patch 所在目录）

preset 内 plugins 列表里的行            → name: '../../plugins/dsh-preset-tuning.js'
                                        （基址是 profile 目录，即 $DSH_HOME/profiles/web）
```

写错的后果是导入失败；如果坏在 profile 平面，可能拖垮启动。改完务必用
`dsh --profile web --dump-config` 确认 `file://` 解析结果指向真实文件。

## 规则文件

```json
{
  "xaihi": {
    "tools": {
      "deny":   ["mcp__notion__notion-calendar-*"],
      "except": ["mcp__notion__notion-calendar-list-calendars"],
      "allow":  [],
      "dryRun": false
    }
  }
}
```

| 字段 | 含义 |
|---|---|
| `deny` | 匹配的工具**隐藏**。glob 只支持 `*` 和 `?` |
| `except` | 即使被 `deny` 命中也**保留**。让界面能表达「整组关掉但留这两个」，不必拆散 glob |
| `allow` | 非空时**只保留**匹配的工具（会清空其余，慎用） |
| `dryRun` | `true` 时只记日志不生效，用来验证规则 |

- 顶层键 = preset 行里 `config.key` 的名字
- **文件被修改后立即生效**：registry 重新加载 → 通知订阅者 → 撤销旧掩码 → 施加新掩码。
  连正在进行的会话都换，不用重启、不用新建。
- JSON 解析失败时**保留上一次的规则**（一次手滑不该让所有会话失去过滤）
- 文件里没有某个 key 时，该 preset 回退到 YAML 里的内联 `tools` 配置

提示词段落只从 YAML 的内联配置读取——段落属于「组合」，且很少改。

## 为什么规则要经过 Host 服务

内联在 preset YAML 里的规则属于**组合**，组合在会话创建时就被钉住，改它要等新会话或重启。
经 Host 服务持有的规则是**运行时状态**，可以随时重算并施加到所有活着的会话。

这也正是配置界面能工作的前提：客户端半侧只能挂 profile 平面，只有通过共享的 Host 服务
才能和 preset 层的插件对话。

## 验证方法

1. 改 `preset-tuning.json`，保存
2. 当前会话里让模型重新读一次工具清单（`cordis_inspect_query` → `Tool.listTools`）
3. 数字应该立刻变，不需要重启

界面侧：`plugin_manager list_plugins` 看 `tuning-ui` 的 `fiberPhase` 是否为 `active`；
失败时 `diagnostic` 直接给出原因。

## 组合包更新流程

```
改 client.js    ① 改 package.json 的 version（bundle 元数据变了才会重新发布）
                ② plugin_manager set_plugin 禁用再启用（触发重新协调）
                ③ 浏览器刷新页面

改 index.js     必须重启 dsh —— ESM 模块缓存，禁用/启用不够，
                HMR 也不覆盖 link 包的 host 模块
```

## 已知边界

- **不省 MCP 连接成本**：工具只是被隐藏，`mcp-client` 照样连服务器、起桥接进程
- **不能隐藏 agent 自己注册的工具**：`restrict()` 只作用于继承来的工具
- **不能让规则作用于已隐藏工具的会话**：撤销旧掩码再施加新掩码，是替换不是叠加
- **改插件代码要重启**：HMR 只监视配置，不监视模块文件
- **界面不显示已禁用且无工具的行**：`tool-bash` 这类要等界面接上 `pluginInventory` 才完整
