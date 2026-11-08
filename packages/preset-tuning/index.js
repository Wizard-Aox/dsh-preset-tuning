/**
 * tuning-registry —— Host 平面的调优服务
 *
 * 它持有三样东西，并把它们提供给预设插件和（将来的）配置界面：
 *
 *   1. 规则        按 key 分组，来自 $DSH_HOME/preset-tuning.json
 *   2. 工具清单    按 key 分组，由各预设插件主动上报
 *   3. 基线快照    每份清单上一次的样子，用于标出 [新增] / [失效]
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────────
 *
 * 规则原来内联在 preset 的 YAML 里。那样改一次要等重组 + 新会话，因为规则属于
 * 「组合」，而组合在会话创建时就被钉住了。搬到 Host 服务之后，规则变成运行时状态：
 * 改文件 → 服务通知订阅者 → 预设插件撤销旧掩码、施加新掩码 → 连正在聊的会话都立刻变。
 *
 * 而且这也是配置界面的地基：客户端半侧只能挂在 profile 平面，只有通过共享的 Host
 * 服务才能和 preset 层的插件对话。
 *
 * ── 归属与基线 ──────────────────────────────────────────────────────────────
 *
 * 工具和"哪个插件提供的"之间没有系统级记录（dsh-tools 只存 名字→定义）。
 * 所以归属来自 $DSH_HOME/preset-tuning.owners.json 这张人工维护的表；
 * MCP 工具则按 mcp__<server>__ 前缀自动归组。没登记的工具进「未归类」，仍可配置。
 *
 * 基线是"上次看到的清单"。没有它，就回答不了"为什么工具莫名少了一部分"。
 * 基线只在明确确认时更新，不会因为读一次就自动前移——否则标记会立刻消失。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { defaultRoots, scanOwners } from './owners-scan.js'

/** 自动补扫的最小间隔，避免每次打开页面都全盘扫描。 */
const SCAN_COOLDOWN_MS = 60_000

/** Loader 诊断里显示的插件名。 */
const name = 'tuning-registry'

/** 默认文件位置：本插件在 $DSH_HOME/plugins/ 下，上一级就是 $DSH_HOME。 */
/**
 * 运行时数据目录：`$DSH_HOME/preset-tuning/`。
 *
 * 跟随 DSH 的路径约定——从 home 派生自己的子目录，而不是把文件摊在 home 根目录
 * （官方 `dsh-home-paths` 的做法就是 `dshHomePath('settings')` 这种形式）。
 * 优先级：`$DSH_HOME` > `~/.dsh`，空白值视为未设置。
 */
const DATA_DIR = join(
  (() => {
    const configured = process.env.DSH_HOME
    if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
    return join(homedir(), '.dsh')
  })(),
  'preset-tuning',
)
const DEFAULT_RULES_FILE = join(DATA_DIR, 'rules.json')
const OWNERS_FILE = join(DATA_DIR, 'owners.json')
/** 静态扫描生成的「工具 → 组」映射，由 tools/gen-owners.mjs 或自动补扫产出。 */
const GENERATED_FILE = join(DATA_DIR, 'owners.generated.json')
const STATE_FILE = join(DATA_DIR, 'state.json')

/** 归属表里没有登记的工具归到这里。 */
const UNCLASSIFIED = { id: 'unclassified', label: '未归类', description: '归属表里没有登记，仍可配置' }

/**
 * 把 glob 模式编译成正则。只支持 `*` 和 `?`，与预设插件里的实现保持一致。
 * @param {string} pattern - 例如 `mcp__notion__*`。
 * @returns {RegExp} 锚定到整串的正则。
 */
function globToRegExp(pattern) {
  let source = '^'
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/** 读一份 JSON 文件；失败返回 undefined 并交给调用方决定怎么记录。 */
function readJson(url) {
  try {
    return { value: JSON.parse(readFileSync(url, 'utf8')) }
  } catch (error) {
    return { error }
  }
}

/** 原子写：先写临时文件再改名，避免读到写了一半的内容。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, file)
}

/**
 * 挂载入口。
 *
 * @param {object} ctx - Host 平面的插件上下文。
 * @param {object} [rawConfig] - Loader 配置。
 */
function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('tuning-registry: config 必须是对象')
  }
  if (config.file !== undefined && typeof config.file !== 'string') {
    throw new TypeError('tuning-registry: config.file 必须是字符串')
  }
  const rulesFile = typeof config.file === 'string' && config.file.length > 0
    ? resolve(config.file)
    : DEFAULT_RULES_FILE

  /** @type {Map<string, object>} key → 规则（原始 JSON 形状） */
  const rules = new Map()
  /** @type {Map<string, Set<(rules: object | undefined) => void>>} key → 规则订阅者 */
  const listeners = new Map()
  /** @type {Map<string, () => string[]>} key → 上报工具清单的回调 */
  const inventories = new Map()

  /** 重新加载规则文件。失败时保留上一次成功的内容。 */
  function reload() {
    const { value, error } = readJson(rulesFile)
    if (error !== undefined) {
      if (error?.code === 'ENOENT') {
        ctx.logger.info(`tuning-registry: 规则文件尚未创建（${rulesFile}）`)
      } else {
        // 解析失败/b 读取失败都保留旧规则：一次手滑不该让所有会话失去过滤。
        ctx.logger.warn(`tuning-registry: 规则文件不可用，已保留上一次的规则：${String(error)}`)
      }
      return false
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.logger.warn('tuning-registry: 规则文件顶层必须是对象，已保留上一次的规则')
      return false
    }
    rules.clear()
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        ctx.logger.warn(`tuning-registry: 键 "${key}" 的值不是对象，已跳过`)
        continue
      }
      rules.set(key, entry)
    }
    ctx.logger.info(`tuning-registry: 已加载 ${rules.size} 组规则`)
    return true
  }

  /** 把某个键的当前规则推给它的订阅者。 */
  function notify(key) {
    const set = listeners.get(key)
    if (set === undefined || set.size === 0) return
    const value = rules.get(key)
    for (const handler of [...set]) {
      try {
        handler(value)
      } catch (error) {
        ctx.logger.warn(`tuning-registry: 订阅者处理 "${key}" 时失败：${String(error)}`)
      }
    }
  }

  /**
   * 读归属表 + 生成表。每次现读，改完立刻生效，不需要重启。
   *
   * 归属的优先级：
   *   ① 手写表里显式列出的工具（覆盖，用来处理特殊情况）
   *   ② 生成表精确命中（静态扫描得出的 工具 → 包）
   *   ③ 生成表前缀兜底（`subagent_fork` 归到 `subagent` 所在的包）
   *   ④ 都落空 → 未归类
   */
  function loadOwners() {
    const ownersRead = readJson(OWNERS_FILE)
    const owners =
      ownersRead.error === undefined && ownersRead.value !== null && typeof ownersRead.value === 'object'
        ? ownersRead.value
        : {}
    const generatedRead = readJson(GENERATED_FILE)
    const generatedTools =
      generatedRead.error === undefined && generatedRead.value?.tools !== null && typeof generatedRead.value?.tools === 'object'
        ? generatedRead.value.tools
        : {}
    return {
      groups: Array.isArray(owners.groups) ? owners.groups : [],
      mcp: owners.mcp,
      generated: generatedTools,
    }
  }

  /** 手写覆盖表：工具名 → 组。 */
  function buildExact(owners) {
    const exact = new Map()
    for (const group of owners.groups) {
      for (const toolName of group.tools ?? []) {
        exact.set(toolName, { id: group.id, label: group.label, description: group.description ?? '' })
      }
    }
    return exact
  }

  /** 补扫冷却，避免每次打开页面都全盘扫一遍。 */
  let lastScanAt = 0
  let scanning = false

  /**
   * 重新扫描安装目录并刷新生成表。
   * 只在发现归不了类的工具时调用——那通常意味着刚装了新插件。
   * @returns {Promise<boolean>} 是否真的刷新了。
   */
  async function rescanOwners() {
    if (scanning) return false
    if (Date.now() - lastScanAt < SCAN_COOLDOWN_MS) return false
    scanning = true
    lastScanAt = Date.now()
    try {
      const dshHome = dirname(DATA_DIR)
      const roots = defaultRoots(dshHome.replace(/[\\/]$/, ''))
      if (roots.length === 0) return false
      const { tools, packageCount } = await scanOwners(roots)
      const sorted = Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)))
      writeJsonAtomic(GENERATED_FILE, {
        generatedAt: new Date().toISOString(),
        note: '由 tuning-registry 自动补扫生成，不要手改。',
        roots,
        toolCount: Object.keys(sorted).length,
        packageCount,
        tools: sorted,
      })
      ctx.logger.info(`tuning-registry: 归属表已自动补扫（${packageCount} 个包，${Object.keys(sorted).length} 个工具）`)
      return true
    } catch (error) {
      ctx.logger.warn(`tuning-registry: 自动补扫失败：${String(error)}`)
      return false
    } finally {
      scanning = false
    }
  }

  /** 读基线快照。 */
  function loadState() {
    const { value } = readJson(STATE_FILE)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  /**
   * 把一个工具名归到某个组。
   * @param {string} toolName - 工具名。
   * @param {object} owners - 归属表。
   * @param {Map<string, object>} exact - 工具名 → 组。
   * @returns {{id: string, label: string, description: string}}
   */
  function classify(toolName, owners, exact) {
    const prefix = owners.mcp?.namePrefix ?? 'mcp__'
    if (typeof prefix === 'string' && toolName.startsWith(prefix)) {
      const rest = toolName.slice(prefix.length)
      const cut = rest.indexOf('__')
      const server = cut > 0 ? rest.slice(0, cut) : rest
      // server 来自工具名的 mcp__<serverName>__<rawName>，由 mcp-client 保证，
      // 每次现采都重新推导，所以 MCP 增删服务器会自动反映。
      return {
        id: `mcp:${server}`,
        label: server,
        description: '由该 MCP 服务器提供的工具',
      }
    }

    // ① 手写表覆盖
    const group = exact.get(toolName)
    if (group !== undefined) return group

    // ② 生成表精确命中；组名就是组 id
    const generated = owners.generated ?? {}
    if (typeof generated[toolName] === 'string') {
      return { id: generated[toolName], label: generated[toolName], description: '' }
    }

    // ③ 前缀兜底：`subagent_fork` → 以 `subagent` 所在组为准（取最长的匹配前缀）
    let best
    for (const [known, groupId] of Object.entries(generated)) {
      if (!toolName.startsWith(`${known}_`)) continue
      if (best === undefined || known.length > best.length) best = known
    }
    if (best !== undefined) {
      const groupId = generated[best]
      return { id: groupId, label: groupId, description: '' }
    }

    return UNCLASSIFIED
  }

  reload()

  try {
    const watcher = watch(rulesFile, { persistent: false }, () => {
      if (reload()) for (const key of [...listeners.keys()]) notify(key)
    })
    watcher.on('error', (error) => {
      ctx.logger.warn(`tuning-registry: 监听规则文件失败，改动需重启才生效：${String(error)}`)
    })
    ctx.effect(() => () => watcher.close(), 'tuning-registry.watch')
  } catch (error) {
    ctx.logger.warn(`tuning-registry: 无法监听规则文件，改动需重启才生效：${String(error)}`)
  }

  /** 提供给订阅者的服务。 */
  const service = {
    /**
     * 读取某个键的规则副本。
     * @param {string} key - 规则键。
     * @returns {object | undefined} 规则，未配置时为 undefined。
     */
    getRules(key) {
      const value = rules.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },

    /** 当前所有已配置的规则键。 */
    keys() {
      return [...rules.keys()]
    },

    /**
     * 写入某个键的规则：更新内存、落盘、通知订阅者。
     * @param {string} key - 规则键。
     * @param {object} next - 规则对象；传 undefined 表示删除该键。
     * @returns {{persisted: boolean}} 落盘是否成功。
     */
    setRules(key, next) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('tuning-registry: setRules() 的 key 必须是非空字符串')
      }
      if (next !== undefined && (next === null || typeof next !== 'object' || Array.isArray(next))) {
        throw new TypeError('tuning-registry: setRules() 的规则必须是对象或 undefined')
      }
      const { value: current } = readJson(rulesFile)
      const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
      if (next === undefined) delete base[key]
      else base[key] = next

      let persisted = false
      try {
        writeJsonAtomic(rulesFile, base)
        persisted = true
      } catch (error) {
        // 落盘失败仍保留内存中的新规则：本次运行可用，重启后会回到旧值。
        ctx.logger.warn(`tuning-registry: 规则写盘失败，改动仅本次运行有效：${String(error)}`)
      }

      if (next === undefined) rules.delete(key)
      else rules.set(key, next)
      notify(key)
      return { persisted }
    },

    /**
     * 订阅某个键的规则。注册时立即推送一次当前值。
     * @param {string} key - 规则键。
     * @param {(rules: object | undefined) => void} handler - 收到规则时调用。
     * @returns {() => void} 取消订阅。
     */
    register(key, handler) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('tuning-registry: register() 的 key 必须是非空字符串')
      }
      if (typeof handler !== 'function') {
        throw new TypeError('tuning-registry: register() 的 handler 必须是函数')
      }
      let set = listeners.get(key)
      if (set === undefined) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(handler)
      try {
        handler(rules.get(key))
      } catch (error) {
        ctx.logger.warn(`tuning-registry: 首次推送规则失败：${String(error)}`)
      }
      return () => {
        set.delete(handler)
        if (set.size === 0) listeners.delete(key)
      }
    },

    /**
     * 由预设插件上报「它当前能看到哪些工具」。
     *
     * 必须是**遮蔽前**的全集：否则自己下的 deny 规则会让被隐藏的工具看起来像失效了。
     *
     * @param {string} key - 规则键。
     * @param {() => string[]} provider - 返回工具名数组的回调。
     * @returns {() => void} 取消上报。
     */
    declareInventory(key, provider) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('tuning-registry: declareInventory() 的 key 必须是非空字符串')
      }
      if (typeof provider !== 'function') {
        throw new TypeError('tuning-registry: declareInventory() 的 provider 必须是函数')
      }
      inventories.set(key, provider)
      return () => {
        if (inventories.get(key) === provider) inventories.delete(key)
      }
    },

    /**
     * 取某个键的工具清单，按归属分组，并标出相对基线的新增与失效。
     *
     * @param {string} key - 规则键。
     * @returns {object} 报表对象。
     */
    async listPresetTools(key) {
      const provider = inventories.get(key)
      if (provider === undefined) {
        return { key, available: false, reason: '该预设尚未上报工具清单（需要一个活跃会话来读取）' }
      }
      let raw
      try {
        // provider 可以返回 Promise：每次请求都现采一次，而不是读会话创建时的快照。
        raw = await provider()
      } catch (error) {
        return { key, available: false, reason: `读取清单失败：${String(error)}` }
      }
      // 兼容两种形状：数组（只有工具）或 { tools, skills }
      const current = Array.isArray(raw) ? raw : raw?.tools ?? []
      const skillList = Array.isArray(raw) ? [] : raw?.skills ?? []

      // 归属表：手写覆盖 + 生成表。有归不了类的工具时先补扫一次（装新插件就会出现）。
      let owners = loadOwners()
      let exact = buildExact(owners)
      const countUnclassified = () =>
        current.filter((name) => classify(name, owners, exact).id === UNCLASSIFIED.id).length
      if (countUnclassified() > 0 && (await rescanOwners())) {
        owners = loadOwners()
        exact = buildExact(owners)
      }

      const currentSet = new Set(current)

      const state = loadState()
      const entry = state[key]
      const baseline = Array.isArray(entry?.tools) ? entry.tools : null
      const baselineSet = new Set(baseline ?? [])

      const added = baseline === null ? [] : current.filter((toolName) => !baselineSet.has(toolName))
      const missing = baseline === null ? [] : [...baselineSet].filter((toolName) => !currentSet.has(toolName))

      const buckets = new Map()
      for (const toolName of [...current].sort()) {
        const group = classify(toolName, owners, exact)
        if (!buckets.has(group.id)) buckets.set(group.id, { ...group, tools: [] })
        buckets.get(group.id).tools.push({ name: toolName, added: added.includes(toolName) })
      }

      const groups = [...buckets.values()].sort((a, b) => {
        if (a.id === UNCLASSIFIED.id) return 1
        if (b.id === UNCLASSIFIED.id) return -1
        return b.tools.length - a.tools.length
      })

      // 技能：归属优先级 = 包名（从路径反推）> providerName。
      const skillBuckets = new Map()
      for (const skill of [...skillList].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const ownerId = String(skill.packageName ?? skill.provider ?? 'unknown')
        if (!skillBuckets.has(ownerId)) {
          skillBuckets.set(ownerId, { id: ownerId, label: ownerId, skills: [] })
        }
        skillBuckets.get(ownerId).skills.push({
          name: skill.name,
          description: skill.description ?? '',
          source: skill.source ?? 'unknown',
          modelInvocable: skill.modelInvocable !== false,
        })
      }

      const skillBaseline = Array.isArray(entry?.skills) ? entry.skills : null
      const skillBaselineSet = new Set(skillBaseline ?? [])
      const currentSkillNames = skillList.map((skill) => skill.name)
      const addedSkills =
        skillBaseline === null ? [] : currentSkillNames.filter((name) => !skillBaselineSet.has(name))
      const missingSkills =
        skillBaseline === null
          ? []
          : [...skillBaselineSet].filter((name) => !currentSkillNames.includes(name)).sort()

      return {
        key,
        available: true,
        total: current.length,
        groups,
        added: added.sort(),
        missing: missing
          .sort()
          .map((toolName) => ({ name: toolName, ...classify(toolName, owners, exact) })),
        skillTotal: skillList.length,
        skillGroups: [...skillBuckets.values()],
        addedSkills,
        missingSkills,
        // 展示顺序（纯 UI 偏好）：{ core: [...], mcp: [...], skills: [...] }
        order: entry?.order ?? {},
        baselineAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
        generatedAt: new Date().toISOString(),
      }
    },

    /**
     * 保存某一分段的展示顺序。属于 UI 偏好，不改基线时间戳。
     * @param {string} key - 规则键。
     * @param {'core'|'mcp'|'skills'} scope - 哪个分段。
     * @param {string[]} ids - 组 id 顺序。
     * @returns {{order: object}} 保存后的完整排序表。
     */
    setOrder(key, scope, ids) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('tuning-registry: setOrder() 的 key 必须是非空字符串')
      }
      if (scope !== 'core' && scope !== 'mcp' && scope !== 'skills') {
        throw new TypeError('tuning-registry: setOrder() 的 scope 必须是 core / mcp / skills')
      }
      if (!Array.isArray(ids) || ids.some((item) => typeof item !== 'string')) {
        throw new TypeError('tuning-registry: setOrder() 的 ids 必须是字符串数组')
      }
      const state = loadState()
      const previous = state[key] ?? {}
      state[key] = {
        ...previous,
        order: { ...(previous.order ?? {}), [scope]: [...new Set(ids)] },
      }
      writeJsonAtomic(STATE_FILE, state)
      return { order: state[key].order }
    },

    /** 把当前清单记为基线（清掉所有新增/失效标记），工具与技能一起记。 */
    async acknowledge(key) {
      const provider = inventories.get(key)
      if (provider === undefined) throw new Error(`tuning-registry: "${key}" 尚未上报清单`)
      const raw = await provider()
      const tools = Array.isArray(raw) ? raw : raw?.tools ?? []
      const skills = Array.isArray(raw) ? [] : (raw?.skills ?? []).map((skill) => skill.name)
      return service.setBaseline(key, tools, skills)
    },

    /**
     * 直接指定基线。界面里"删除某个失效工具"就是把它从基线里去掉；
     * 只传工具时不改动已记录的技能基线。
     * @param {string} key - 规则键。
     * @param {string[]} names - 新的工具基线。
     * @param {string[]} [skills] - 新的技能基线；省略则保留原值。
     * @returns {{count: number, skillCount: number}} 写入后的基线长度。
     */
    setBaseline(key, names, skills) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('tuning-registry: setBaseline() 的 key 必须是非空字符串')
      }
      if (!Array.isArray(names) || names.some((item) => typeof item !== 'string')) {
        throw new TypeError('tuning-registry: setBaseline() 的 names 必须是字符串数组')
      }
      const state = loadState()
      const previous = state[key] ?? {}
      state[key] = {
        ...previous,
        updatedAt: new Date().toISOString(),
        tools: [...new Set(names)].sort(),
        ...(skills === undefined ? {} : { skills: [...new Set(skills)].sort() }),
      }
      writeJsonAtomic(STATE_FILE, state)
      return { count: state[key].tools.length, skillCount: state[key].skills?.length ?? 0 }
    },
  }

  ctx.provide('tuningRegistry', service)
  ctx.logger.info(
    `tuning-registry: 服务已提供（规则 ${rulesFile}，归属 ${OWNERS_FILE}，基线 ${STATE_FILE}）`,
  )
}

export { apply, name, globToRegExp }
