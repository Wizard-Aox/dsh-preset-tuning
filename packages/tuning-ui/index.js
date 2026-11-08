/**
 * dsh-tuning-ui —— Host 半侧
 *
 * 客户端半侧（client.js）需要读 `tuningRegistry`、写规则、改基线。客户端不能直接
 * 摸 Host 服务，所以这里开一个 HTTP 端点把它们接起来。
 *
 * ── 为什么不用 connection.rpc.handle() ──────────────────────────────────────
 *
 * 它内部是 `owner.effect(() => owner.webServer.register(route))`，而 Loader 行的
 * 依赖取自行选项 `entry.options.inject`（不是模块导出的 inject）。我们的行拿不到
 * webServer，于是抛 `cannot get property "webServer" without inject`——试过两次。
 *
 * 而 `connection.fetch.register()` 只操作服务内部的 fetchRoutes 表，不碰 webServer。
 * 代价是客户端用原生 fetch 而不是 rpc.call，但对一个自用面板来说完全够。
 *
 * 端点：POST /api/tuning
 *   请求体 { endpoint: 'keys'|'state'|'setRules'|'acknowledge'|'setBaseline', ...参数 }
 *   响应体 { ok: true, value } | { ok: false, error }
 *
 * `/api` 已被 Gateway 占用为拦截器，但精确 fetch 路由在拦截器之前匹配，所以
 * `/api/tuning` 归我们。
 */

/** Loader 诊断里显示的插件名。 */
const name = 'dsh-tuning-ui'

/** 只需要 connection（开路由）与 tuningRegistry（数据来源）。 */
const inject = ['connection', 'tuningRegistry']

/** 路由路径。 */
const PATH = '/api/tuning'

/** 统一的失败信封。 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** 校验并取出请求里的 key。 */
function requireKey(payload) {
  const key = payload?.key
  if (typeof key !== 'string' || key.length === 0) return undefined
  return key
}

/**
 * 挂载入口。
 * @param {object} ctx - profile 平面的插件上下文。
 */
function apply(ctx) {
  const registry = ctx.tuningRegistry

  /** 处理一个业务端点。 */
  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case 'keys':
        return { ok: true, value: { keys: registry.keys() } }

      case 'state': {
        const key = requireKey(payload)
        if (key === undefined) return fail('tuning/bad-request', 'key 必须是非空字符串')
        return {
          ok: true,
          value: {
            key,
            rules: registry.getRules(key) ?? null,
            // 现采：每次进页面都重新读取工具与技能，并与基线重新对比
            report: await registry.listPresetTools(key),
          },
        }
      }

      case 'setRules': {
        const key = requireKey(payload)
        if (key === undefined) return fail('tuning/bad-request', 'key 必须是非空字符串')
        const rules = payload?.rules
        if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
          return fail('tuning/bad-request', 'rules 必须是对象')
        }
        const { persisted } = registry.setRules(key, rules)
        return { ok: true, value: { persisted, rules: registry.getRules(key) ?? null } }
      }

      case 'acknowledge': {
        const key = requireKey(payload)
        if (key === undefined) return fail('tuning/bad-request', 'key 必须是非空字符串')
        return { ok: true, value: await registry.acknowledge(key) }
      }

      case 'setBaseline': {
        const key = requireKey(payload)
        if (key === undefined) return fail('tuning/bad-request', 'key 必须是非空字符串')
        return { ok: true, value: registry.setBaseline(key, payload?.names ?? []) }
      }

      // 保存某一分段的展示顺序（纯 UI 偏好）
      case 'setOrder': {
        const key = requireKey(payload)
        if (key === undefined) return fail('tuning/bad-request', 'key 必须是非空字符串')
        return { ok: true, value: registry.setOrder(key, payload?.scope, payload?.ids ?? []) }
      }

      default:
        return fail('tuning/unknown-endpoint', `未知端点：${endpoint}`)
    }
  }

  const respond = (body) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return respond(fail('tuning/bad-request', '请求体必须是 JSON'))
          }
          try {
            return respond(await dispatch(body?.endpoint, body?.payload ?? {}))
          } catch (error) {
            return respond(fail('tuning/failed', String(error)))
          }
        },
      }),
    'dsh-tuning-ui.fetch()',
  )

  ctx.logger.info(`dsh-tuning-ui: 端点 ${PATH} 已就绪（keys / state / setRules / acknowledge / setBaseline）`)
}

export { apply, inject, name }
