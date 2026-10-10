// mini-bar: a minimal HUD in two parts.
//   Above the prompt: the context window as one stacked bar, a color per category,
//   the auto-compaction point marked, then the fill and last turn's growth.
//   Below the prompt: model, directory, git, prompt-cache countdown, 5h limit.
// Context breakdown adapted from hamzafer/claude-code-mods context-bar (MIT);
// cache countdown adapted from its token-weather (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Bar, CacheTtl, Reading, Slice } from '../types'

const bar = atom({ plugin: 'mini-bar', key: 'bar' } as const, null as Bar | null)
const reading = atom({ plugin: 'mini-bar', key: 'reading' } as const, null as Reading | null)
const isHidden = atom({ plugin: 'mini-bar', key: 'isHidden' } as const, false)
const lastRequestAt = atom({ plugin: 'mini-bar', key: 'lastRequestAt' } as const, null as number | null)
const ttl = atom({ plugin: 'mini-bar', key: 'ttl' } as const, null as CacheTtl | null)

// Kept clear of the messages accent: no oranges or ambers.
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#73daca', '#c0caf5', '#f7768e']
// Short legend names; anything unlisted shows as /context names it.
const SHORT: Record<string, string> = {
  'system prompt': 'system',
  'system tools': 'tools',
  'mcp tools': 'mcp',
  'mcp server instructions': 'mcp instr',
  'custom agents': 'agents',
  'memory files': 'memory',
}
const ACCENT = '#d97757'
const GREY = '#808080'
const GLYPH = { used: '█', free: '─', buffer: '░' } as const
const MARK = '┃'
const MIN_BAR = 20
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const TAIL_BYTES = 1024 * 1024

const level = (p: number) => (p >= 80 ? 'error' : p >= 50 ? 'warning' : 'success')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mini-bar', description: 'Show or hide the context bar above the prompt' }).catch(() => {})
    if ((await $.store.get('isHidden').catch(() => undefined)) === true) await update($, isHidden, () => true)
    const known = await $.store.get('ttl').catch(() => undefined)
    if ((known === '5m' || known === '1h') && (await read($, ttl)) === null) await update($, ttl, () => known)
    const since = await read($, lastRequestAt)
    if (since !== null) arm($, since)
    await refresh($)
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      tick?.cancel()
      await update($, lastRequestAt, () => null)
    }
    return next(e)
  })

  // Each finished main-thread request restarts the prompt cache's clock.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.stopReason !== null) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
      arm($, now)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await refresh($)
      const found = ttlFromTranscript(await readTail($))
      if (found && found !== (await read($, ttl))) {
        await update($, ttl, () => found)
        await $.store.set('ttl', found).catch(() => {})
      }
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await refresh($)
    return r
  })

  // Rate-limit and model changes between turns.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const fiveHour = e.rateLimits.find(l => l.kind === 'five_hour')?.percentUsed ?? null
    const model = prettyModel(await $.session.model())
    const b = await read($, bar)
    if (b && (b.fiveHour !== fiveHour || b.model !== model)) await update($, bar, () => ({ ...b, fiveHour, model }))
    return r
  })

  on('command.run', { command: 'mini-bar' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    await $.store.set('isHidden', hidden).catch(() => {})
    if (!hidden) await refresh($)
    return { text: hidden ? 'Context bar hidden. /mini-bar shows it again' : 'Context bar on' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const r = await read($, reading)
    if (e.props.hasSurvey || !r || (await read($, isHidden))) return rest
    const { Box, Text } = $.ui.resolve(e)

    const pct = `${r.percent}%`
    const grow = r.delta > 0 ? `▲${tokens(r.delta)}` : ''
    const label = ` ${pct}${grow ? ` ${grow}` : ''}`
    const width = e.props.bodyColumns - label.length
    if (width < MIN_BAR) return rest
    const lv = r.compactsAt ? (r.total / r.compactsAt) * 100 : r.percent

    return (
      <Box flexDirection="column">
        <Text>
          {runs(r, width).map(c => (
            <Text color={c.color}>{c.text}</Text>
          ))}
          <Text color={level(lv)} bold>{` ${pct}`}</Text>
          {grow && <Text color="subtle">{` ${grow}`}</Text>}
        </Text>
        <Text wrap="truncate-end">
          {legend(r).map((s, i) => (
              <Text>
                {i > 0 && <Text>{'  '}</Text>}
                <Text color={s.color}>■ </Text>
                <Text dimColor>{`${SHORT[s.name] ?? s.name} `}</Text>
                <Text>{tokens(s.tokens)}</Text>
              </Text>
            ))}
          {r.compactsAt && <Text color="subtle">{`   ${MARK} compact ${tokens(r.compactsAt)}`}</Text>}
        </Text>
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const b = await read($, bar)
    if (!b) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text color="subtle">{'  │  '}</Text>
    const since = await read($, lastRequestAt)
    const cache = since === null ? null : cachePart(since + ttlMs(await read($, ttl)) - (await $.clock.now()))

    return (
      <Box>
        <Text color="claude" bold>◆ {b.model}</Text>
        {sep}
        <Text>{b.dir}</Text>
        {b.branch && (
          <Text>
            <Text color="subtle">{'  ⎇ '}</Text>
            <Text color="suggestion">{b.branch}</Text>
            {b.dirty && <Text color="warning"> ●</Text>}
            {b.ahead > 0 && <Text color="subtle"> ↑{b.ahead}</Text>}
          </Text>
        )}
        {cache && (
          <Text>
            {sep}
            <Text color={cache.color}>{cache.text}</Text>
          </Text>
        )}
        {b.fiveHour !== null && (
          <Text>
            {sep}
            <Text color="subtle">5h </Text>
            <Text color={level(b.fiveHour)}>{b.fiveHour}%</Text>
          </Text>
        )}
        {e.props.hint && <Text dimColor>{'   '}{e.props.hint}</Text>}
      </Box>
    )
  })
}

async function refresh($: EngineInterface) {
  const [model, cwd, usage, git] = await Promise.all([
    $.session.model(),
    $.session.cwd(),
    $.session.usage({ breakdown: 'summary' }),
    $.process.run(['git', 'status', '--porcelain=v2', '--branch']),
  ])
  const g = git.exitCode === 0 ? parseGit(git.stdout) : { branch: null, ahead: 0, dirty: false }
  await update($, bar, () => ({
    model: prettyModel(model),
    dir: cwd.split('/').filter(Boolean).pop() ?? cwd,
    ...g,
    fiveHour: usage.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? null,
  }))
  const bd = usage.context.breakdown
  if (bd && bd.rawMaxTokens > 0) {
    const prev = (await read($, reading))?.total
    await update($, reading, () => toReading(bd, prev))
  }
}

// "claude-opus-5-5[1m]" -> "Opus 5.5"
export function prettyModel(id: string): string {
  const m = /(opus|sonnet|haiku|fable)[-_]?(\d+)(?:[-.](\d+))?/i.exec(id)
  if (!m) return id
  const [, family = '', major, minor] = m
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

// Parses `git status --porcelain=v2 --branch`.
export function parseGit(out: string) {
  let branch: string | null = null
  let ahead = 0
  let dirty = false
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14)
    else if (line.startsWith('# branch.ab ')) ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
    else if (line && !line.startsWith('#')) dirty = true
  }
  return { branch, ahead, dirty }
}

export function toReading(
  b: {
    categories: { name: string; tokens: number; color: string; kind: string }[]
    totalTokens: number
    rawMaxTokens: number
    percentage: number
    autoCompactThreshold?: number
    isAutoCompactEnabled: boolean
  },
  prevTotal?: number,
): Reading {
  const order = { used: 0, free: 1, buffer: 2 }
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, color: c.color, kind: c.kind as Slice['kind'] }))
    .sort((x, y) => order[x.kind] - order[y.kind])
  let n = 0
  for (const s of slices) {
    s.color = s.kind !== 'used' ? GREY : s.name === 'messages' ? ACCENT : PALETTE[n++ % PALETTE.length]!
  }
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    delta: prevTotal === undefined ? 0 : b.totalTokens - prevTotal,
  }
}

// Used slices, largest first, so a truncated line drops the smallest.
export function legend(r: Reading) {
  return r.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
}

// The bar as colored runs exactly `width` cells wide, each used slice at least one cell,
// with the auto-compaction point drawn as a marker.
export function runs(r: Reading, width: number) {
  const sizes = r.slices.map(s => Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)))
  let diff = width - sizes.reduce((a, x) => a + x, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const byFit = r.slices.map((_, i) => i).sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of byFit) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  const cells = r.slices.flatMap((s, i) => Array.from({ length: sizes[i]! }, () => ({ ch: GLYPH[s.kind] as string, color: s.color })))
  if (r.compactsAt && r.compactsAt < r.window) {
    const at = Math.min(cells.length - 1, Math.round((r.compactsAt / r.window) * width))
    if (cells[at]) cells[at] = { ch: MARK, color: 'warning' }
  }
  const out: { text: string; color: string }[] = []
  for (const c of cells) {
    const last = out.at(-1)
    if (last && last.color === c.color) last.text += c.ch
    else out.push({ text: c.ch, color: c.color })
  }
  return out
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function cachePart(leftMs: number) {
  if (leftMs <= 0) return { text: '❄ cold', color: 'error' }
  const s = Math.ceil(leftMs / 1000)
  return { text: `❄ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, color: s < 60 ? 'warning' : 'subtle' }
}

const ttlMs = (t: CacheTtl | null) => TTL_MS[t ?? '5m']

// Redraws when the countdown text changes: every second in the last two minutes,
// otherwise in 15 s steps, until the cache reads cold.
let tick: Timer | undefined
function arm($: EngineInterface, since: number) {
  tick?.cancel()
  const step = async () => {
    const left = since + ttlMs(await read($, ttl)) - (await $.clock.now())
    if ((await read($, lastRequestAt)) !== since) return
    $.ui.invalidate('ui.render')
    if (left <= 0) return
    const unit = left <= 120_000 ? 1000 : 15_000
    tick = $.clock.after(left % unit || unit, () => void step().catch(() => {}))
  }
  void step().catch(() => {})
}

// The end of this session's transcript, where the last response's usage is.
async function readTail($: EngineInterface) {
  try {
    const home = await $.env.get('HOME')
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
    if (!dir) return ''
    const project = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
    const path = `${dir}/projects/${project}/${await $.session.id()}.jsonl`
    const { size } = await $.fs.stat(path)
    if (size <= TAIL_BYTES) return await $.fs.read(path)
    const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    return exitCode === 0 ? stdout : ''
  } catch {
    return ''
  }
}

// The cache lifetime the latest main-thread response wrote with; null when it wrote none.
export function ttlFromTranscript(text: string): CacheTtl | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || entry.isSidechain || !entry.message?.usage) continue
    const w = entry.message.usage.cache_creation
    if (Number(w?.ephemeral_1h_input_tokens) > 0) return '1h'
    if (Number(w?.ephemeral_5m_input_tokens) > 0) return '5m'
    return null
  }
  return null
}
