# suyeo-mods

Claude Code mods (Claude Code 2.1.29x+, mod API is early access).

## mini-bar

A minimal two-part HUD.

- **Above the prompt** — the context window as one stacked bar, a color per category, the auto-compaction point marked `┃`, fill % and last turn's growth. Legend lists the largest categories first. `/mini-bar` shows or hides it.
- **Below the prompt** — model · directory · git branch (`●` dirty, `↑n` unpushed) · prompt-cache countdown `❄ m:ss` · 5-hour limit usage.

```
████▒▒██████────────────────────┃──── 32% ▲20k
■ messages 240k  ■ mcp 60k  ■ system 20k   ┃ compact 800k
> _
◆ Opus 5.5  │  repo  ⎇ main ● ↑2  │  ❄ 4:32  │  5h 12%   ? for shortcuts
```

### Install

```bash
claude plugin marketplace add Suyeo2025/claude-mods
claude plugin install mini-bar@suyeo-mods
```

Update later with `claude plugin marketplace update suyeo-mods`.

### Develop

```bash
claude plugin validate mini-bar
claude plugin test mini-bar
```

Context breakdown and cache countdown adapted from
[hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (`context-bar`, `token-weather`, MIT).
