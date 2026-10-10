export type CacheTtl = '5m' | '1h'

// Below the prompt.
export type Bar = {
  model: string
  dir: string
  branch: string | null
  dirty: boolean
  ahead: number
  fiveHour: number | null
}

// Above the prompt: the context window by category.
export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }
export type Reading = {
  slices: Slice[]
  total: number
  window: number
  percent: number
  compactsAt?: number
  delta: number // tokens gained since the previous reading
}

declare module 'claude-code' {
  interface PluginState {
    'mini-bar': {
      bar: Bar | null
      reading: Reading | null
      isHidden: boolean
      lastRequestAt: number | null
      ttl: CacheTtl | null
    }
  }
}
