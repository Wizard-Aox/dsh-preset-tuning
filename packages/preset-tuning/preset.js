/**
 * dsh-preset-tuning —— 按 preset 裁剪「模型所见」
 *
 * 这个插件做两件事，都围绕「模型在这个会话里能看到什么」：
 *
 *   1. 工具过滤：把匹配到的工具从当前会话隐藏（schema 与调用一并消失）
 *   2. 提示词注入：往系统提示词里追加一个段落
 *
 * 两者都可以按 preset 自由配置——同一份插件，挂在哪个 preset 就只影响那个 preset。
 *
 * ── 规则从哪来（两个来源，后者优先）────────────────────────────────────────
 *
 *   1. 本行 config.tools            —— 内联默认值，写在 preset YAML 里
 *   2. Host 服务 tuningRegistry     —— 按 config.key 从 $DSH_HOME/preset-tuning.json 取
 *
 * 为什么要有第二个来源：内联规则属于「组合」，而组合在会话创建时就被钉住了，
 * 改它要等新会话或重启。走 Host 服务的规则是运行时状态，改了能立刻重新施加到
 * 所有活着的会话上（撤销旧掩码 → 施加新掩码）。
 *
 * 提示词段落仍然只从内联配置读取：段落是组合的一部分，且很少改。
 *
 * ── 为什么能过滤到别的插件注册的工具 ────────────────────────────────────────
 *
 * dsh-tools 的 `view(scope)` 把 `restrictableNames` 算成「全局工具 + 所有祖先
 * 作用域的工具」，只有「查看者自己那一层」的注册豁免。preset 作用域正是 agent
 * 作用域的祖先，所以在 agent 作用域里调用 restrict() 就能遮蔽 preset 里的工具
 * （包括 mcp-client 注册的 mcp__<server>__* 和普通工具行）。
 *
 * 但反过来不行：在 preset 作用域自己调 restrict() 会报「unknown global tool」，
 * 因为 preset 自己的注册不在它的 restrictableNames 里。所以必须等 agent 建好。
 *
 * ── 为什么不用 schemastery 声明 Config ──────────────────────────────────────
 *
 * DSH 的 resolveConfig 只要看到导出的 Config 就会调它做校验。而插件可能放在没有
 * node_modules 的目录里（profile 目录、$DSH_HOME/plugins），import 不了 schema 库。
 * 所以配置在这里手工归一化，放在 apply() 内部做。
 *
 * ── 安全约束（必须遵守） ────────────────────────────────────────────────────
 *
 * `agent/created` 是 serial 事件，监听器抛异常会直接导致会话创建失败。而
 * restrict() 对未知工具名会抛错。所以：
 *   - 先用已知工具名求交集，只对真实存在的名字调用 restrict()
 *   - 全部逻辑包在 try/catch 里，任何异常降级为日志，绝不外抛
 */

/** Loader 诊断里显示的插件名。 */
const name = 'dsh-preset-tuning'

/** 依赖的服务：提示词注册表 + 工具注册表。tuningRegistry 走可选注入。 */
const inject = ['systemPrompt', 'tools']

/** 段落默认顺序。第一方段落：identity −1000、persona 0、后缀 10200。 */
const DEFAULT_SECTION_ORDER = 700

/**
 * 把一个值规范成字符串数组。
 * @param {unknown} value - 原始配置值。
 * @param {string} label - 报错时用的字段路径。
 * @returns {string[]} 规范化后的数组。
 */
function asStringArray(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new TypeError(`dsh-preset-tuning: config.${label} 必须是字符串数组`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError(`dsh-preset-tuning: config.${label}[${index}] 必须是非空字符串`)
    }
    return item
  })
}

/**
 * 把 glob 模式编译成正则。只支持 `*`（任意字符）和 `?`（单个字符），
 * 其余字符按字面量转义——工具名里本来就有 `_` 和 `-`，不需要字符类。
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

/**
 * 归一化「工具规则」这一小段配置。
 * @param {unknown} raw - `{ deny, allow, dryRun }` 的原始形状。
 * @param {string} label - 报错时用的字段前缀。
 * @returns {{deny: string[], allow: string[], dryRun: boolean}} 归一化结果。
 */
function normalizeTools(raw, label) {
  const value = raw ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`dsh-preset-tuning: ${label} 必须是对象`)
  }
  return {
    deny: asStringArray(value.deny, `${label}.deny`),
    allow: asStringArray(value.allow, `${label}.allow`),
    // 例外：即使被 deny 匹配到也保留。让界面能表达「整组关掉，但留这两个」，
    // 而不必把整组的 glob 拆散成一个个精确名字。
    except: asStringArray(value.except, `${label}.except`),
    // 试运行：只算账不落刀，用来验证规则匹配是否符合预期。
    dryRun: value.dryRun === true,
  }
}

/**
 * 归一化并校验一整份配置。
 * @param {unknown} raw - Loader 传来的原始配置。
 * @returns {object} 归一化后的配置。
 */
function normalizeConfig(raw) {
  const value = raw ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dsh-preset-tuning: config 必须是对象')
  }

  const promptsRaw = value.prompts ?? {}
  if (typeof promptsRaw !== 'object' || Array.isArray(promptsRaw)) {
    throw new TypeError('dsh-preset-tuning: config.prompts 必须是对象')
  }

  const sectionsRaw = promptsRaw.sections ?? []
  if (!Array.isArray(sectionsRaw)) {
    throw new TypeError('dsh-preset-tuning: config.prompts.sections 必须是数组')
  }

  const key = value.key
  if (key !== undefined && (typeof key !== 'string' || key.length === 0)) {
    throw new TypeError('dsh-preset-tuning: config.key 必须是非空字符串')
  }

  const sections = sectionsRaw.map((section, index) => {
    const at = `config.prompts.sections[${index}]`
    if (typeof section !== 'object' || section === null) {
      throw new TypeError(`dsh-preset-tuning: ${at} 必须是对象`)
    }
    const { name: sectionName, text, order, interpolate } = section
    if (typeof sectionName !== 'string' || sectionName.length === 0) {
      throw new TypeError(`dsh-preset-tuning: ${at}.name 必须是非空字符串`)
    }
    if (typeof text !== 'string') {
      throw new TypeError(`dsh-preset-tuning: ${at}.text 必须是字符串`)
    }
    const resolvedOrder = order ?? DEFAULT_SECTION_ORDER
    if (typeof resolvedOrder !== 'number' || !Number.isFinite(resolvedOrder)) {
      throw new TypeError(`dsh-preset-tuning: ${at}.order 必须是有限数字`)
    }
    if (interpolate !== undefined && typeof interpolate !== 'boolean') {
      throw new TypeError(`dsh-preset-tuning: ${at}.interpolate 必须是布尔值`)
    }
    return {
      name: sectionName,
      order: resolvedOrder,
      text,
      // 默认关闭插值：段落是给模型看的散文，不是模板。一旦文本里出现字面
      // `{{xxx}}`，严格插值会抛错并拖垮整个系统提示词组装。
      interpolate: interpolate ?? false,
    }
  })

  const skillsRaw = value.skills ?? {}
  if (typeof skillsRaw !== 'object' || Array.isArray(skillsRaw)) {
    throw new TypeError('dsh-preset-tuning: config.skills 必须是对象')
  }

  return {
    key,
    tools: normalizeTools(value.tools, 'config.tools'),
    skills: { deny: asStringArray(skillsRaw.deny, 'config.skills.deny') },
    prompts: { sections },
  }
}

/**
 * 取得一个 agent 当前能看到的全部工具名（遮蔽前）。
 *
 * 优先用 `view(agent).knownNames`——它包含全局与祖先作用域的全部注册；
 * 拿不到时退回到 `schemas(agent)`（官方声明的方法，但只给可见集）。
 *
 * @param {object} tools - 工具注册表服务。
 * @param {object} agent - 作用域键（agent 对象本身）。
 * @returns {string[]} 工具名列表。
 */
function knownToolNames(tools, agent) {
  try {
    if (typeof tools.view === 'function') {
      const view = tools.view(agent)
      if (view !== undefined && view.knownNames !== undefined) {
        return [...view.knownNames]
      }
    }
  } catch {
    // 内部方法不可用时静默降级。
  }
  try {
    if (typeof tools.schemas === 'function') {
      const schemas = tools.schemas(agent)
      if (Array.isArray(schemas)) return schemas.map((entry) => entry.name)
    }
  } catch {
    // 同上。
  }
  return []
}

/**
 * 把一组 glob 规则编译成匹配器。
 * @param {object} rules - 归一化后的工具规则。
 * @returns {{deny: RegExp[], allow: RegExp[]}} 编译结果。
 */
function compileRules(rules) {
  return {
    deny: rules.deny.map(globToRegExp),
    allow: rules.allow.map(globToRegExp),
    except: (rules.except ?? []).map(globToRegExp),
  }
}

/**
 * 从技能指令文件路径反推它属于哪个包。
 * 形如 …/node_modules/@tt-a1i/archify-dsh/skills/archify/SKILL.md → "@tt-a1i/archify-dsh"。
 * 项目内或用户目录的技能没有 node_modules 段，返回 undefined，由调用方回落到 provider。
 * @param {string | undefined} filePath - 技能指令文件的绝对路径。
 * @returns {string | undefined} 包名，推不出来时为 undefined。
 */
function packageFromPath(filePath) {
  if (typeof filePath !== 'string') return undefined
  const marker = 'node_modules'
  const at = filePath.lastIndexOf(marker)
  if (at < 0) return undefined
  const segments = filePath.slice(at + marker.length + 1).split(/[\\/]/)
  const first = segments[0]
  if (first === undefined || first.length === 0) return undefined
  if (first.startsWith('@')) return segments[1] === undefined ? undefined : `${first}/${segments[1]}`
  return first
}

/**
 * 挂载入口。
 * @param {object} ctx - preset 作用域上下文。
 * @param {unknown} rawConfig - Loader 配置。
 */
function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  // ── 提示词注入 ────────────────────────────────────────────────────────────
  // 注册在 preset 作用域，该 preset 的所有会话都会继承这些段落。
  // 只来自内联配置：段落是组合的一部分，且很少改。
  for (const section of config.prompts.sections) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: section.name,
          order: section.order,
          text: section.text,
          interpolate: section.interpolate,
        }),
      `dsh-preset-tuning.section(${section.name})`,
    )
  }

  // ── 技能隐藏 ──────────────────────────────────────────────────────────────
  // 技能注册表没有 tools.restrict() 那样的排除接口，只有分层遮蔽：更近的作用域
  // 遮蔽更远的同名技能。所以在 preset 层注册一个同名"影子"，把调用策略全关，
  // 真正的那个被挡住、影子自己也不进模型目录——净效果是只对本 preset 不可见。
  let skillDeny = config.skills.deny
  let shadowDisposers = []

  function applySkillShadows() {
    for (const dispose of shadowDisposers) {
      try {
        dispose()
      } catch {
        // 已失效的撤销函数忽略即可。
      }
    }
    shadowDisposers = []
    if (skillDeny.length === 0) return

    // 用 ctx.get 而不是 ctx.skills：前者在服务缺席时返回 undefined，
    // 不会像属性访问那样抛「without inject」。
    const skills = ctx.get('skills')
    if (skills === undefined || typeof skills.register !== 'function') {
      ctx.logger.warn('dsh-preset-tuning: 找不到 skills 服务，技能隐藏规则未生效')
      return
    }

    for (const skillName of skillDeny) {
      try {
        shadowDisposers.push(
          skills.register({
            name: skillName,
            description: '（本 preset 中已隐藏）',
            content: `该技能在 preset "${config.key ?? '当前 preset'}" 中被隐藏。`,
            source: 'runtime',
            invocation: { modelInvocable: false, userInvocable: false },
          }),
        )
      } catch (error) {
        ctx.logger.warn(`dsh-preset-tuning: 注册技能影子 "${skillName}" 失败：${String(error)}`)
      }
    }
    ctx.logger.info(`dsh-preset-tuning: 已注册 ${shadowDisposers.length} 个技能影子`)
  }

  applySkillShadows()

  // ── 工具过滤 ──────────────────────────────────────────────────────────────
  // 见过并处理过的 agent。值里保存当前掩码的撤销函数，改规则时先撤销再重算。
  /** @type {Map<object, { dispose?: () => void }>} */
  const seen = new Map()

  let rules = config.tools
  let matchers = compileRules(rules)
  /**
   * 最近一次算出来的「遮蔽前」工具全集。
   * 用来向 Host 服务上报本预设的工具清单——必须是遮蔽前的，
   * 否则自己下的 deny 规则会让被隐藏的工具看起来像"失效"。
   */
  let lastKnownTools = []
  /**
   * 最近一次采集到的技能清单。注册表本身就给出 provider 与 source，
   * 所以技能的归属可以完全自动，不需要手工映射表。
   */
  let lastKnownSkills = []
  /** 最近一个会话的 agent；清单现采时要用它的作用域去读工具与技能。 */
  let lastAgent = null

  /**
   * 为一个 agent 重新计算并施加掩码。
   *
   * 绝不抛异常：agent/created 是串行事件，抛出会中断会话创建。
   *
   * @param {object} agent - 目标 agent。
   */
  function applyToAgent(agent) {
    try {
      const scoped = agent?.ctx
      if (scoped === undefined) {
        ctx.logger.warn('dsh-preset-tuning: agent 没有作用域上下文，跳过工具过滤')
        return
      }
      const tools = scoped.tools ?? ctx.tools
      if (tools === undefined) {
        ctx.logger.warn('dsh-preset-tuning: 找不到 tools 服务，跳过工具过滤')
        return
      }

      const entry = seen.get(agent) ?? {}

      // 先撤销上一次的掩码，否则改规则只会叠加而不会替换。
      if (entry.dispose !== undefined) {
        const dispose = entry.dispose
        entry.dispose = undefined
        try {
          dispose()
        } catch (error) {
          ctx.logger.warn(`dsh-preset-tuning: 撤销旧掩码失败：${String(error)}`)
        }
      }
      seen.set(agent, entry)

      const known = knownToolNames(tools, agent)
      if (known.length === 0) {
        ctx.logger.warn('dsh-preset-tuning: 读不到工具清单，跳过工具过滤（配置未生效）')
        return
      }
      lastKnownTools = known

      // 技能清单：异步取，取不到不影响工具过滤。
      //
      // 两个来源要合并：
      //   list({ scope })  本 preset 视角的**有效**清单——被影子遮蔽的项会读成
      //                    我们注册的影子（source: runtime、没有 path），
      //                    所以不能用它来判断归属。
      //   list({})         全局层，影子不在这一层，读到的是真身。
      // 用真身的 provider/source/path 归档，用有效清单的 invocation 反映可见性。
      try {
        const skills = ctx.get('skills')
        if (skills !== undefined && typeof skills.list === 'function') {
          Promise.all([skills.list({ scope: agent }), skills.list({})])
            .then(([effective, global]) => {
              const originals = new Map(global.map((entry) => [entry.name, entry]))
              lastKnownSkills = effective.map((entry) => {
                // 影子（runtime 来源且全局有同名真身）用真身的信息
                const real = entry.source === 'runtime' ? originals.get(entry.name) ?? entry : entry
                return {
                  name: entry.name,
                  description: real.description,
                  provider: real.provider ?? 'unknown',
                  source: real.source ?? 'unknown',
                  packageName: packageFromPath(real.path),
                  modelInvocable: entry.invocation?.modelInvocable ?? true,
                }
              })
            })
            .catch(() => {
              // 读取失败保持上一次的清单。
            })
        }
      } catch {
        // 服务不可用就算了，技能清单只是管理用途。
      }

      /** @type {Set<string>} */
      const deny = new Set()
      /** @type {Set<string>} */
      const keep = new Set()

      matchers.deny.forEach((regExp, index) => {
        let hit = 0
        for (const toolName of known) {
          if (regExp.test(toolName)) {
            deny.add(toolName)
            hit += 1
          }
        }
        if (hit === 0) {
          ctx.logger.warn(
            `dsh-preset-tuning: tools.deny[${index}] "${rules.deny[index]}" 没有匹配到任何工具`,
          )
        }
      })

      matchers.allow.forEach((regExp, index) => {
        let hit = 0
        for (const toolName of known) {
          if (regExp.test(toolName)) {
            keep.add(toolName)
            hit += 1
          }
        }
        if (hit === 0) {
          ctx.logger.warn(
            `dsh-preset-tuning: tools.allow[${index}] "${rules.allow[index]}" 没有匹配到任何工具`,
          )
        }
      })

      /**
       * 只在命中的名字里调用 restrict。
       *
       * allow 语义是「只保留这些」——如果配了 allow 却一条都没匹配上，直接调用
       * 会让会话失去全部工具。这种情况必须跳过并报警，不能照做。
       */
      const filter = {}
      // except 例外：从 deny 集合里摘掉。
      if (rules.except.length > 0) {
        for (const regExp of matchers.except) {
          for (const toolName of [...deny]) if (regExp.test(toolName)) deny.delete(toolName)
        }
      }
      if (deny.size > 0) filter.deny = [...deny]
      if (matchers.allow.length > 0) {
        if (keep.size === 0) {
          ctx.logger.warn(
            'dsh-preset-tuning: 配置了 tools.allow 但没有匹配到任何工具，已跳过 allow 掩码（否则会清空全部工具）',
          )
        } else {
          filter.allow = [...keep]
        }
      }

      if (filter.deny === undefined && filter.allow === undefined) {
        ctx.logger.debug?.('dsh-preset-tuning: 本会话没有需要改动的工具')
        return
      }

      const summary =
        `隐藏 ${filter.deny?.length ?? 0} 个工具` +
        `${filter.allow === undefined ? '' : `，只保留 ${filter.allow.length} 个`}`

      if (rules.dryRun) {
        ctx.logger.info(`dsh-preset-tuning: [dryRun] 将${summary}（agent ${agent.id ?? '?'}）`)
        return
      }

      entry.dispose = scoped.tools.restrict(filter)
      ctx.logger.info(`dsh-preset-tuning: 已${summary}（agent ${agent.id ?? '?'}）`)
    } catch (error) {
      // 降级而非中断：一次过滤失败不该让会话建不出来。
      ctx.logger.warn(`dsh-preset-tuning: 工具过滤失败，已跳过：${String(error)}`)
    }
  }

  /** 把所有已见 agent 的掩码按当前规则重算一遍。 */
  function applyAll() {
    for (const agent of [...seen.keys()]) applyToAgent(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    lastAgent = agent
    seen.set(agent, seen.get(agent) ?? {})
    applyToAgent(agent)
  })

  // 会话结束就忘掉它，别让 Map 长期持有已销毁的 agent。
  ctx.on('agent/disposed', ({ agent }) => {
    seen.delete(agent)
    if (lastAgent === agent) lastAgent = null
  })

  /**
   * 现采一份清单：每次调用都重新读工具与技能，所以界面刷新能看到最新状态，
   * 而不是会话创建那一刻的快照。
   *
   * 技能要合并两层：`list({ scope })` 是本 preset 的有效清单（被影子遮蔽的项读成影子），
   * `list({})` 是全局层（读到的才是真身）。归属取真身，可见性取有效清单。
   *
   * @returns {Promise<{tools: string[], skills: object[]}>} 清单。
   */
  async function collectInventory() {
    const agent = lastAgent
    if (agent === null) return { tools: lastKnownTools, skills: lastKnownSkills }

    try {
      const scoped = agent.ctx
      const tools = scoped?.tools ?? ctx.tools
      if (tools !== undefined) {
        const known = knownToolNames(tools, agent)
        if (known.length > 0) lastKnownTools = known
      }
    } catch {
      // 保持上一次的工具清单。
    }

    try {
      const skills = ctx.get('skills')
      if (skills !== undefined && typeof skills.list === 'function') {
        const [effective, global] = await Promise.all([skills.list({ scope: agent }), skills.list({})])
        const originals = new Map(global.map((entry) => [entry.name, entry]))
        lastKnownSkills = effective.map((entry) => {
          const real = entry.source === 'runtime' ? originals.get(entry.name) ?? entry : entry
          return {
            name: entry.name,
            description: real.description,
            provider: real.provider ?? 'unknown',
            source: real.source ?? 'unknown',
            packageName: packageFromPath(real.path),
            modelInvocable: entry.invocation?.modelInvocable ?? true,
          }
        })
      }
    } catch {
      // 保持上一次的技能清单。
    }

    return { tools: lastKnownTools, skills: lastKnownSkills }
  }

  // ── 订阅 Host 服务的规则 ──────────────────────────────────────────────────
  // 没配 key、或没挂 tuning-registry 时，就只用内联规则——不会报错、不会阻塞。
  if (config.key !== undefined) {
    ctx.inject(['tuningRegistry'], (child) => {
      const service = child.tuningRegistry
      const undo = service.register(config.key, (next) => {
        try {
          // 服务里的规则形状与内联一致；没配该 key 时回退到内联默认值。
          const nextTools = next?.tools === undefined
            ? config.tools
            : normalizeTools(next.tools, `preset-tuning.json["${config.key}"].tools`)
          rules = nextTools
          matchers = compileRules(rules)
          applyAll()
          if (next?.skills !== undefined) {
            skillDeny = asStringArray(next.skills.deny, `preset-tuning.json["${config.key}"].skills.deny`)
            applySkillShadows()
          }
        } catch (error) {
          ctx.logger.warn(`dsh-preset-tuning: 应用外部规则失败，已保留原规则：${String(error)}`)
        }
      })
      child.effect(() => () => undo(), 'dsh-preset-tuning.registry')
      ctx.logger.info(`dsh-preset-tuning: 已订阅 tuningRegistry 的 "${config.key}"`)

      // 上报工具清单，供 Host 服务按归属整理、并与基线对比出 [新增] / [失效]。
      // 回调是惰性的：只有服务来问时才读，且返回的是遮蔽前的全集。
      const dropInventory = service.declareInventory(config.key, collectInventory)
      child.effect(() => () => dropInventory(), 'dsh-preset-tuning.inventory')
    })
  }

  ctx.logger.info(
    `dsh-preset-tuning: 已挂载（内联 deny ${config.tools.deny.length} 条、` +
      `allow ${config.tools.allow.length} 条、提示词段落 ${config.prompts.sections.length} 段` +
      `${config.key === undefined ? '' : `、规则键 "${config.key}"`}` +
      `${config.tools.dryRun ? '，试运行模式' : ''}）`,
  )
}

// 不导出 Config：见文件头注释。
export { apply, inject, name }
