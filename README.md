# ddc-switch

DDC/CI CLI to switch external display input between multiple machines.

Share one display between a Mac and a Windows PC without touching the monitor's
physical buttons. Switch input from the terminal, Raycast, or Claude Code.

Supported platforms:

| OS | DDC backend | Extra install |
| --- | --- | --- |
| macOS (Apple Silicon) | [m1ddc](https://github.com/waydabber/m1ddc) | `brew install m1ddc` |
| Windows 11 | [dxva2.dll](https://learn.microsoft.com/en-us/windows/win32/api/_monitor/) (built-in) | None |

Same CLI, same config file, same commands on both OSes.

## Port-based input naming

Inputs are named after the **monitor's port** (`type-c` / `hdmi` / `dp`), not the
machine connected to it. You can swap the device on a Type-C port without the
name becoming a lie.

Want to name inputs after machines? Add aliases in your config's `inputs`:
```json
{ "inputs": { "type-c": 27, "work-mac": 27, "hdmi": 17, "game-pc": 17 } }
```

## Install

### macOS

```sh
brew install m1ddc
git clone <this repo> ~/src/ddc-switch && cd ddc-switch
mise trust && mise install
just install
```

### Windows

```powershell
git clone <this repo> $env:USERPROFILE\src\ddc-switch
cd $env:USERPROFILE\src\ddc-switch
mise trust; mise install
just install
```

No extra install needed — `dxva2.dll` ships with Windows.

Make sure **DDC/CI is enabled** in your monitor's OSD menu.

### What `just install` does

1. Builds a self-contained binary (`dist/ddc` on macOS / `dist/ddc.exe` on Windows)
2. Places it in `~/.local/bin/` (`ddc` on macOS, `ddc.exe` on Windows)
3. Creates `~/.config/ddc-switch/config.json` if it doesn't exist

Prefix is configurable: `PREFIX=/usr/local/bin just install`
Uninstall with `just uninstall` (config is preserved).

No daemon — the binary runs on demand and exits. Self-contained so it works
from Raycast, launchers, or any environment with a limited PATH.

## CLI

```sh
ddc                    # current state
ddc hdmi               # switch to HDMI
ddc type-c             # switch to Type-C
ddc toggle             # toggle between the two inputs in config
ddc inputs             # list configured input names
ddc displays           # list DDC-visible displays
ddc caps               # what the display reports it supports (Windows only)
ddc brightness 60
ddc contrast 75
ddc volume 30 / ddc mute / ddc unmute
ddc pbp 36 hdmi        # PBP 50/50 with HDMI as secondary

ddc status --json      # JSON output
ddc version            # print version
```

Commands are identical on both OSes.

## Raycast

`raycast/` contains Script Commands for both macOS and Windows:

| Script | Name | Action |
| --- | --- | --- |
| `ddc-type-c.*` | Switch Display to Type-C | Switch to Type-C |
| `ddc-hdmi.*` | Switch Display to HDMI | Switch to HDMI |
| `ddc-status.*` | Display Status | Show current state |

```sh
just raycast
```

Copies scripts to `~/.raycast/script-commands/`. Run after `just install`.

First time only: register the script directory in Raycast
(Raycast → Extensions → Script Commands → Add Script Directory → paste path).

Assign hotkeys to your most-used commands via Record Hotkey.

Brightness/contrast/volume controls are intentionally not exposed as Raycast
scripts — input switching is the hotkey use case.

## Claude Code (Skill)

`skills/ddc-display/` contains a Claude Code Skill:

```sh
just skill
```

Installs to `~/.claude/skills/`. Reload Claude Code and `/skills` to verify.

The Skill tells Claude:

- Input names are port-based, run `ddc inputs` to confirm (don't guess)
- Switching physically takes over the user's screen — ask permission first
- Background multi-switch scripts must log to file and restore the original input
- `ddc status` takes 3-6 seconds; read failures are normal, retry once

## Config

`~/.config/ddc-switch/config.json`

```json
{
  "display": "YOUR_DISPLAY_NAME",
  "inputs": {
    "type-c": 27,
    "hdmi": 17,
    "dp": 15
  },
  "toggle": ["type-c", "hdmi"],
  "m1ddcPath": null
}
```

- `display` — partial name match, backend-specific ID, or index number
- `inputs` — logical name → VCP 0x60 value (use `ddc caps` on Windows to find values for your monitor)
- `toggle` — the two inputs `ddc toggle` cycles between
- `m1ddcPath` — macOS only; null means find via PATH

Writing `inputs` replaces the whole map (not merged).

## Why you can switch back from the other side

On the reference monitor (Dell U3223QE), switching away to HDMI does **not**
kill the DDC link on the Type-C side — so the Mac can switch back without
any external hardware.

This is **monitor-dependent** — other displays may behave differently. See
[docs/ddc-findings.md](docs/ddc-findings.md) for measurement details.

Also: switching **to** the input your machine is currently on triggers ~10 seconds
of DDC silence (the display re-establishes its link). The CLI retries
aggressively during this window.

## Development

```sh
just              # recipe list
just deps         # bun install
just cli status   # CLI (read-only, no screen change)
just typecheck
just build        # self-contained binary
just probe        # raw DDC behavior (debugging)
just raycast      # deploy Raycast scripts
just skill        # deploy Claude Code Skill
just uninstall    # remove deployed files (config preserved)
```

Recipes with `[macos]` / `[windows]` attributes are platform-specific.

## License

MIT
