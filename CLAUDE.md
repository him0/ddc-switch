# CLAUDE.md

DDC/CI CLI to switch external display input. macOS (via m1ddc) and Windows (via dxva2.dll).
Single self-contained binary named `ddc` (`ddc <input>` to switch).
Formerly `ddcd` — the daemon is gone, so the name is too. No `ddcd` / `ddc.cmd` is installed.

Input names are **port-based** (`type-c` / `hdmi` / `dp`), not machine-based.
Users who want machine names can add aliases in `config.json`.

## Key gotchas

### 1. DDC reads on macOS fail ~45% of the time with garbage value 110 (0x6E)

`m1ddc get <prop>` returns 110 ~45% of the time regardless of interval.
The same monitor read via dxva2 on Windows never does this (20/20 correct, even at 30ms interval).

**New VCP reads must go through the `Ddc` class** — it serializes commands, filters garbage, and requires two consecutive identical reads.

### 2. DDC commands cannot run in parallel

`Ddc` serializes all commands with a minimum 120ms interval. Never `Promise.all` DDC operations.

### 3. Switching input steals the user's screen

Switching actually changes what the monitor displays. Always:
- Get user permission first
- Never run foreground (screen switches away, output becomes unreadable)
- Use background + log file for multi-switch scripts
- Always restore original input at the end

Read-only commands (`ddc status`, `ddc inputs`, `ddc caps`, `scripts/probe-ddc.ts`) are safe without permission.

### 4. "Can switch back from the other side" is monitor-dependent

The reference monitor keeps DDC alive on the inactive side. This was confirmed by measurement — other monitors may not behave this way.

### 5. ~10 second DDC silence when switching to own input

The display re-establishes its link during this window. `Ddc.verifyInput()` retries for the backend's full verify window.

## Architecture

```
src/main.ts              entry
src/ddc.ts              serialization / retry / plausibility filter (platform-agnostic)
src/backends/backend.ts DdcBackend interface and shared types
src/backends/m1ddc.ts   macOS: spawn m1ddc
src/backends/win32.ts   Windows: dxva2.dll via bun:ffi
src/service.ts          domain logic (input resolution, switching, verification)
src/cli.ts              CLI
src/config.ts           ~/.config/ddc-switch/config.json and state file

raycast/                Raycast Script Commands (deployed via `just raycast`)
skills/                 Claude Code Skill      (deployed via `just skill`)
```

Dependency direction: `cli` → `service` → `ddc` → `backends/*`

- `ddc.ts` knows nothing about *how* a read/write happens — only serialization, 2-match, retry
- `backends/*` knows nothing about serialization or retry — only single read/write. `isPlausible()` lives here since only the backend knows what "broken" means for its platform
- Adding a platform = implement `DdcBackend` and add to `createBackend()`. Don't touch anything else.

**No daemon.** Runs on demand and exits.

## Commands

```sh
just typecheck   # always run after changes
just cli status  # CLI (read-only, no screen change)
just probe       # raw DDC behavior (debugging)
just build       # self-contained binary
just install     # build + deploy to ~/.local/bin
just raycast     # deploy Raycast scripts
just skill       # deploy Claude Code Skill
just uninstall   # remove deployed files (config preserved)
```

## Conventions

- Comments in Japanese, user-facing strings in English
- CLI color only in TTY (`NO_COLOR` / `FORCE_COLOR`)
- New VCP ops: add to `VcpProperty` → backends → `ddc.ts` → `service.ts` → `cli.ts`. Implement on **both** platforms.
- Monitor-specific values (input codes etc.) go in `config.json`, not code
- `skills/*/SKILL.md` must have `name` and `description` frontmatter
- `raycast/*` must have `@raycast.schemaVersion`, `title`, `mode`
- Don't open network ports — DDC physically takes over the display
