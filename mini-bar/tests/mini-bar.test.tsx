import { expect, test } from 'claude-code/testing'

import { cachePart, legend, parseGit, prettyModel, runs, toReading, ttlFromTranscript } from '../hooks/register'

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 20000, color: 'x', kind: 'used' },
    { name: 'MCP tools', tokens: 60000, color: 'x', kind: 'used' },
    { name: 'Messages', tokens: 240000, color: 'x', kind: 'used' },
    { name: 'Deferred', tokens: 9000, color: 'x', kind: 'deferred' },
    { name: 'Free space', tokens: 680000, color: 'x', kind: 'free' },
  ],
  totalTokens: 320000,
  rawMaxTokens: 1000000,
  percentage: 32,
  autoCompactThreshold: 800000,
  isAutoCompactEnabled: true,
}

test('model ids read as short names', async () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
})

test('git porcelain v2 gives branch, ahead and dirty', async () => {
  expect(parseGit('# branch.head main\n# branch.ab +9 -0\n1 .M N... a\n')).toEqual({ branch: 'main', ahead: 9, dirty: true })
  expect(parseGit('# branch.head dev\n')).toEqual({ branch: 'dev', ahead: 0, dirty: false })
})

test('context bar fills its width exactly and marks the compaction point', async () => {
  const r = toReading(BREAKDOWN, 300000)
  expect(r.delta).toBe(20000)
  expect(r.slices.map(s => s.name)).toEqual(['system prompt', 'mcp tools', 'messages', 'free space'])
  expect(legend(r).map(s => s.name)).toEqual(['messages', 'mcp tools', 'system prompt'])
  for (const w of [20, 57, 120]) {
    const text = runs(r, w).map(c => c.text).join('')
    expect([...text].length).toBe(w)
    expect(text.includes('┃')).toBe(true)
  }
})

test('cache countdown and ttl detection', async () => {
  expect(cachePart(0).text).toBe('❄ cold')
  expect(cachePart(272_000).text).toBe('❄ 4:32')
  const line = (o: object) => JSON.stringify(o)
  const t = [
    line({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } }),
    line({ type: 'assistant', isSidechain: true, message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 5 } } } }),
  ].join('\n')
  expect(ttlFromTranscript(t)).toBe('1h')
})

test('both sites draw after a measured session start', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/Users/x/suyeo-agent' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 320000, percent: 32, breakdown: BREAKDOWN }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] } }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '# branch.head main\n# branch.ab +9 -0\n? x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'mini-bar' } }))
  on('session.start', (_$, e) => e)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ source: 'startup', cwd: '/Users/x/suyeo-agent' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const below = await $.ui.mount({ plugin: 'mini-bar', surface, component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
    for (const t of ['Opus 5\\.5', 'suyeo-agent', 'main', '12%', 'for shortcuts']) expect(await below.find({ type: 'Text', text: new RegExp(t) })).toBeDefined()
    await below.unmount()
    const above = await $.ui.mount({ plugin: 'mini-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as any })
    for (const t of ['32%', 'messages', 'compact 800k']) expect(await above.find({ type: 'Text', text: new RegExp(t) })).toBeDefined()
    await above.unmount()
  }
})
