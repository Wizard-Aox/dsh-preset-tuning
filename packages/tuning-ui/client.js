/**
 * dsh-tuning-ui —— 客户端半侧
 *
 * 一个「设置 → 插件 → 工具调优」页：选 preset，按归属分组展开，逐个工具开关。
 *
 * 数据通道：Host 半侧开了 POST /api/tuning，这里用原生 fetch 调用，
 * 请求 { endpoint, payload }，响应 { ok, value } | { ok, error }。
 *
 * 约束（官方 ui-plugin / practices 参考）：
 *   - 模块 id 必须等于包名
 *   - React 从浏览器模块表取，不额外安装，不 import Harness 客户端包
 *   - 只用 --dsw-alias-* 主题 token（名单来自 cordis_inspect_query 的 Theme）；
 *     自造 token 名会让所有回退色同时生效，在深色主题下变成白底浅字
 *   - 工厂函数无副作用，资源注册放在 apply 内
 */

window.__ModuleLoader__.load({
  id: 'dsh-tuning-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    /** 与插件端逐字相同的 glob 编译。 */
    function globToRegExp(pattern) {
      let source = '^'
      for (const char of pattern) {
        if (char === '*') source += '.*'
        else if (char === '?') source += '.'
        else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      return new RegExp(source + '$')
    }

    const matchesAny = (patterns, toolName) =>
      (patterns ?? []).some((pattern) => globToRegExp(pattern).test(toolName))

    /** 工具此刻是否被规则挡住。与预设插件一致：deny 命中且不在 except 里。 */
    function isHidden(toolName, tools) {
      if (!matchesAny(tools?.deny, toolName)) return false
      return !matchesAny(tools?.except, toolName)
    }

    /**
     * 依据一次勾选算出新 rules。
     * 显示：被 glob 挡住 → 加进 except；只被精确名挡住 → 删掉那一条。
     * 隐藏：加一条精确名 deny，并从 except 摘掉。
     */
    function withToolToggled(rules, toolName, visible) {
      const base = rules ?? {}
      const tools = { deny: [], allow: [], except: [], ...(base.tools ?? {}) }
      const next = {
        deny: (tools.deny ?? []).filter((pattern) => pattern !== toolName),
        allow: tools.allow ?? [],
        except: (tools.except ?? []).filter((pattern) => pattern !== toolName),
        dryRun: tools.dryRun === true,
      }
      if (visible) {
        if (matchesAny(tools.deny, toolName)) next.except.push(toolName)
      } else if (!next.deny.includes(toolName)) {
        next.deny.push(toolName)
      }
      return { ...base, tools: next }
    }

    // ── 主题 token（真实名单，不要自造）──────────────────────────────────
    const T = {
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: T.label },
      card: {
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        background: T.bg1,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      title: { margin: 0, fontSize: 14, fontWeight: 600, color: T.label },
      sub: { margin: 0, fontSize: 12, lineHeight: 1.5, color: T.label2 },
      controls: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      fieldLabel: { fontSize: 12, color: T.label2 },
      select: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 8px',
        minWidth: 180,
        borderRadius: 7,
        border: `1px solid ${T.border2}`,
        background: T.bg2,
        color: T.label,
        // 让原生下拉弹层跟随深浅色，否则深色主题里是白底黑字的系统菜单
        colorScheme: 'light dark',
      },
      button: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 12px',
        borderRadius: 7,
        border: `1px solid ${T.border2}`,
        background: T.bg2,
        color: T.label,
        cursor: 'pointer',
        marginLeft: 'auto',
      },
      meta: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.label2 },
      group: {
        border: `1px solid ${T.border}`,
        borderRadius: 9,
        background: T.bg1,
        padding: '4px 12px',
      },
      groupAlert: { borderColor: T.error },
      summary: {
        cursor: 'pointer',
        fontWeight: 600,
        padding: '6px 0',
        color: T.label,
        // 用 flex 自己画三角，这样把手可以排在三角左边
        display: 'flex',
        alignItems: 'center',
        listStyle: 'none',
      },
      caret: {
        width: 12,
        flex: '0 0 12px',
        textAlign: 'center',
        color: T.label2,
        marginRight: 6,
        fontSize: 10,
        lineHeight: 1,
      },
      groupSub: { fontSize: 12, color: T.label2, paddingBottom: 4 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0 3px 16px' },
      checkbox: { accentColor: T.brand, margin: 0 },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      badgeNew: { fontSize: 11, color: T.success },
      badgeGone: { fontSize: 11, color: T.error },
      dim: { fontSize: 12, color: T.label2 },
      seg: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      segBtn: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 14px',
        borderRadius: 7,
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.label2,
        cursor: 'pointer',
      },
      segActive: {
        borderColor: T.brand,
        color: T.label,
        fontWeight: 600,
      },
      // 二级分段用小一号
      segBtnSm: { fontSize: 12, padding: '3px 10px' },
      divider: { borderTop: `1px solid ${T.border}`, margin: '2px 0' },
      grip: {
        cursor: 'grab',
        userSelect: 'none',
        color: T.label2,
        marginRight: 8,
        fontSize: 13,
        lineHeight: 1,
      },
    }

    /**
     * 页面组件。capturedCtx 备用（当前只走 HTTP）。
     * @param {{capturedCtx: object}} props
     */
    function TuningPage() {
      const [keys, setKeys] = useState(null)
      const [key, setKey] = useState(null)
      const [state, setState] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      // 一级分段：工具 / 技能；二级分段：基础 / MCP（仅工具页）
      const [view, setView] = useState('tools')
      const [scope, setScope] = useState('core')
      /** 正在被拖动的组 id；null 表示没有拖动进行中。 */
      const [dragId, setDragId] = useState(null)
      /** 已展开的抽屉 id（自绘三角需要知道开合状态）。 */
      const [openIds, setOpenIds] = useState(() => new Set())
      const toggleOpen = (groupId, isOpen) =>
        setOpenIds((prev) => {
          const next = new Set(prev)
          if (isOpen) next.add(groupId)
          else next.delete(groupId)
          return next
        })

      const call = async (endpoint, payload) => {
        const response = await fetch('/api/tuning', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload ?? {} }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body?.ok !== true) throw new Error(body?.error?.message ?? '请求失败')
        return body.value
      }

      const load = async (targetKey) => {
        setBusy(true)
        setNote(null)
        try {
          setState(await call('state', { key: targetKey }))
        } catch (error) {
          setNote(`读取失败：${String(error.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      useEffect(() => {
        let alive = true
        call('keys')
          .then((value) => {
            if (!alive) return
            setKeys(value.keys)
            if (value.keys.length > 0) {
              setKey(value.keys[0])
              return load(value.keys[0])
            }
          })
          .catch((error) => alive && setNote(`读取规则键失败：${String(error.message ?? error)}`))
        return () => {
          alive = false
        }
      }, [])

      const onPick = (nextKey) => {
        setKey(nextKey)
        load(nextKey)
      }

      // 回到这个页面（窗口重新获得焦点）时自动重采一次，
      // 保证看到的是最新清单与最新基线对比，而不是进来时的快照。
      useEffect(() => {
        if (key === null) return undefined
        const refresh = () => {
          if (!busy) load(key)
        }
        const onVisible = () => {
          if (document.visibilityState === 'visible') refresh()
        }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [key, busy])

      const onToggle = async (toolName, visible) => {
        if (state === null) return
        const nextRules = withToolToggled(state.rules, toolName, visible)
        setState({ ...state, rules: nextRules })
        try {
          const value = await call('setRules', { key, rules: nextRules })
          setState((prev) => ({ ...prev, rules: value.rules }))
          setNote(value.persisted ? null : '规则已生效，但写盘失败（重启后会回退）')
        } catch (error) {
          setNote(`保存失败：${String(error.message ?? error)}`)
        }
      }

      /** 技能现在是否被规则隐藏。规则形状：rules.skills.deny = [名字]。 */
      const isSkillHidden = (skillName, rules) => (rules?.skills?.deny ?? []).includes(skillName)

      const onToggleSkill = async (skillName, visible) => {
        if (state === null) return
        const deny = (state.rules?.skills?.deny ?? []).filter((item) => item !== skillName)
        if (!visible) deny.push(skillName)
        const nextRules = { ...(state.rules ?? {}), skills: { ...(state.rules?.skills ?? {}), deny } }
        setState({ ...state, rules: nextRules })
        try {
          const value = await call('setRules', { key, rules: nextRules })
          setState((prev) => ({ ...prev, rules: value.rules }))
          setNote(value.persisted ? null : '规则已生效，但写盘失败（重启后会回退）')
        } catch (error) {
          setNote(`保存失败：${String(error.message ?? error)}`)
        }
      }

      const onAcknowledge = async () => {
        try {
          await call('acknowledge', { key })
          await load(key)
          setNote(null)
        } catch (error) {
          setNote(`更新基线失败：${String(error.message ?? error)}`)
        }
      }

      const onDropMissing = async (toolName) => {
        if (state?.report?.missing === undefined) return
        const kept = (state.report.missing ?? []).map((item) => item.name).filter((n) => n !== toolName)
        const baseline = [
          ...(state.report.groups ?? []).flatMap((group) => group.tools.map((tool) => tool.name)),
          ...kept,
        ]
        try {
          await call('setBaseline', { key, names: baseline })
          await load(key)
        } catch (error) {
          setNote(`删除失效项失败：${String(error.message ?? error)}`)
        }
      }

      if (keys === null) return h('div', { style: S.sub }, '正在读取…')
      if (keys.length === 0) {
        return h(
          'div',
          { style: S.page },
          h('div', { style: S.card },
            h('h2', { style: S.title }, '注入筛选'),
            h('p', { style: S.sub }, '还没有任何 preset 配置了规则键。先在一个 preset 的 preset-tuning 行里写 config.key。'),
          ),
        )
      }

      const report = state?.report
      const toolsRules = state?.rules?.tools ?? {}

      // ── 分段与排序 ────────────────────────────────────────────────
      const toolGroups = report?.groups ?? []
      const mcpGroups = toolGroups.filter((group) => String(group.id).startsWith('mcp:'))
      const coreGroups = toolGroups.filter((group) => !String(group.id).startsWith('mcp:'))
      const mcpCount = mcpGroups.reduce((sum, group) => sum + group.tools.length, 0)

      /** 按保存的顺序排列；不在顺序表里的组保持默认（工具数降序）排在后面。 */
      const applyOrder = (groups, ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return groups
        const rank = new Map(ids.map((id, index) => [id, index]))
        const weight = (groupId) => (rank.has(groupId) ? rank.get(groupId) : Number.MAX_SAFE_INTEGER)
        return [...groups].sort((a, b) => weight(a.id) - weight(b.id))
      }
      const order = report?.order ?? {}
      const visibleToolGroups = applyOrder(scope === 'mcp' ? mcpGroups : coreGroups, scope === 'mcp' ? order.mcp : order.core)
      const skillGroups = applyOrder(report?.skillGroups ?? [], order.skills)

      /**
       * 把 fromId 挪到 toId 的位置，落盘并更新本地顺序。
       * @param {'core'|'mcp'|'skills'} scopeName - 哪个分段。
       * @param {object[]} groups - 当前分段的组（决定完整 id 序列）。
       * @param {string} fromId - 被拖动的组。
       * @param {string} toId - 落点所在的组。
       */
      const reorder = async (scopeName, groups, fromId, toId) => {
        if (fromId === null || fromId === toId) return
        const ids = groups.map((group) => group.id)
        const from = ids.indexOf(fromId)
        const to = ids.indexOf(toId)
        if (from < 0 || to < 0) return
        ids.splice(to, 0, ids.splice(from, 1)[0])
        // 先本地生效，再落盘；失败时提示但保留本地顺序。
        setState((prev) =>
          prev === null
            ? prev
            : { ...prev, report: { ...prev.report, order: { ...(prev.report?.order ?? {}), [scopeName]: ids } } },
        )
        try {
          await call('setOrder', { key, scope: scopeName, ids })
          setNote(null)
        } catch (error) {
          setNote(`保存排序失败：${String(error.message ?? error)}`)
        }
      }

      /** 抽屉标题里的把手 + 拖动事件。 */
      const gripProps = (scopeName, groups, groupId) => ({
        style: S.grip,
        draggable: true,
        title: '拖动以排序',
        onClick: (event) => {
          // 点在把手上不要展开/收起抽屉。
          event.preventDefault()
          event.stopPropagation()
        },
        onDragStart: (event) => {
          setDragId(groupId)
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', groupId)
          }
        },
        onDragEnd: () => setDragId(null),
        onDrop: (event) => {
          event.preventDefault()
          event.stopPropagation()
          reorder(scopeName, groups, dragId, groupId)
          setDragId(null)
        },
        onDragOver: (event) => event.preventDefault(),
      })

      const header = h(
        'div',
        { style: S.card },
        h('div', null,
          h('h2', { style: S.title }, '注入筛选'),
          h('p', { style: S.sub }, '选择 preset，调整它的会话能看到哪些工具。改动立即生效，不需要重启或新建会话。'),
        ),
        h('div', { style: S.controls },
          h('span', { style: S.fieldLabel }, 'preset'),
          h('select', {
            style: S.select,
            value: key ?? '',
            onChange: (event) => onPick(event.target.value),
          }, keys.map((item) => h('option', { key: item, value: item }, item))),
          h('button', { style: S.button, onClick: onAcknowledge, disabled: busy }, '把当前状态设为基线'),
        ),
        report?.available === true
          ? h('div', { style: S.meta },
              h('span', null, `${report.total} 个工具`),
              h('span', null, `${report.groups.length} 个归属分组`),
              report.added?.length > 0 ? h('span', { style: S.badgeNew }, `新增 ${report.added.length}`) : null,
              report.missing?.length > 0 ? h('span', { style: S.badgeGone }, `失效 ${report.missing.length}`) : null,
              h('span', null, report.baselineAt === null ? '尚无基线' : `基线 ${report.baselineAt}`),
            )
          : null,
        report?.available === false ? h('p', { style: S.sub }, report.reason ?? '该预设还没有上报工具清单') : null,
      )

      const missingBlock = report?.missing?.length > 0
        ? h('details', { style: { ...S.group, ...S.groupAlert } },
            h('summary', { style: S.summary }, `失效工具 (${report.missing.length})`),
            report.missing.map((item) =>
              h('div', { key: item.name, style: S.row },
                h('span', { style: S.code }, item.name),
                h('span', { style: S.dim }, item.label ?? ''),
                h('button', { style: { ...S.button, marginLeft: 'auto' }, onClick: () => onDropMissing(item.name) }, '删除'),
              ),
            ),
          )
        : null

      return h(
        'div',
        { style: S.page },
        header,
        // 一级分段：工具 / 技能
        h(
          'div',
          { style: S.seg },
          ['tools', 'skills'].map((id) =>
            h(
              'button',
              {
                key: id,
                style: { ...S.segBtn, ...(view === id ? S.segActive : null) },
                onClick: () => setView(id),
              },
              id === 'tools' ? `工具 ${report?.total ?? 0}` : `技能 ${report?.skillTotal ?? 0}`,
            ),
          ),
        ),
        // 分隔线 + 二级分段：基础 / MCP（仅工具页）
        view === 'tools' && mcpCount > 0
          ? h(
              React.Fragment,
              null,
              h('div', { style: S.divider }),
              h(
                'div',
                { style: S.seg },
                ['core', 'mcp'].map((id) =>
                  h(
                    'button',
                    {
                      key: id,
                      style: { ...S.segBtn, ...S.segBtnSm, ...(scope === id ? S.segActive : null) },
                      onClick: () => setScope(id),
                    },
                    id === 'core' ? `基础 ${(report?.total ?? 0) - mcpCount}` : `MCP ${mcpCount}`,
                  ),
                ),
              ),
            )
          : null,
        note !== null ? h('p', { style: { ...S.sub, color: T.error } }, note) : null,
        missingBlock,
        view === 'skills' && skillGroups.length > 0
          ? h(
              'div',
              { style: { ...S.card, marginTop: 4 } },
              h('h2', { style: S.title }, '插件技能包'),
              skillGroups.map((group) =>
                h(
                  'details',
                  {
                    key: group.id,
                    style:
                      dragId !== null && dragId !== group.id
                        ? { ...S.group, borderStyle: 'dashed', borderColor: T.brand }
                        : S.group,
                    onDragOver: (event) => event.preventDefault(),
                    onDrop: (event) => {
                      event.preventDefault()
                      reorder('skills', skillGroups, dragId, group.id)
                      setDragId(null)
                    },
                    onToggle: (event) => toggleOpen(group.id, event.currentTarget.open),
                  },
                  h(
                    'summary',
                    { style: S.summary },
                    h('span', gripProps('skills', skillGroups, group.id), '⠿'),
                    h('span', { style: S.caret }, openIds.has(group.id) ? '▾' : '▸'),
                    `${group.label}　${
                      group.skills.filter((skill) => !isSkillHidden(skill.name, state?.rules)).length
                    }/${group.skills.length}`,
                  ),
                  group.skills.map((skill) =>
                    h(
                      'label',
                      { key: skill.name, style: S.row },
                      h('input', {
                        type: 'checkbox',
                        style: S.checkbox,
                        checked: !isSkillHidden(skill.name, state?.rules),
                        onChange: (event) => onToggleSkill(skill.name, event.target.checked),
                      }),
                      h('span', { style: S.code }, skill.name),
                      h('span', { style: S.dim }, (skill.description ?? '').slice(0, 70)),
                    ),
                  ),
                ),
              ),
            )
          : null,

        (view === 'tools' ? visibleToolGroups : []).map((group) =>
          h('details', {
            key: group.id,
            style:
              dragId !== null && dragId !== group.id
                ? { ...S.group, borderStyle: 'dashed', borderColor: T.brand }
                : S.group,
            onDragOver: (event) => event.preventDefault(),
            onDrop: (event) => {
              event.preventDefault()
              reorder(scope === 'mcp' ? 'mcp' : 'core', visibleToolGroups, dragId, group.id)
              setDragId(null)
            },
            onToggle: (event) => toggleOpen(group.id, event.currentTarget.open),
          },
            h('summary', { style: S.summary },
              h('span', gripProps(scope === 'mcp' ? 'mcp' : 'core', visibleToolGroups, group.id), '⠿'),
              h('span', { style: S.caret }, openIds.has(group.id) ? '▾' : '▸'),
              `${group.label}　${group.tools.filter((tool) => !isHidden(tool.name, toolsRules)).length}/${group.tools.length}`,
            ),
            group.description ? h('div', { style: S.groupSub }, group.description) : null,
            group.tools.map((tool) =>
              h('label', { key: tool.name, style: S.row },
                h('input', {
                  type: 'checkbox',
                  style: S.checkbox,
                  checked: !isHidden(tool.name, toolsRules),
                  onChange: (event) => onToggle(tool.name, event.target.checked),
                }),
                h('span', { style: S.code }, tool.name),
                tool.added ? h('span', { style: S.badgeNew }, '新增') : null,
              ),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'tuning', order: 30, label: '注入筛选' },
            TuningPage,
          ),
        )
      },
    }
  },
})
