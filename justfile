# ddc-switch — DDC/CI display input switcher
#   just             recipe list
#   just install     build and deploy the CLI (ddc)

set shell := ["bash", "-euo", "pipefail", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

home       := home_directory()
prefix     := env_var_or_default("PREFIX", home / ".local/bin")
config_dir := home / ".config/ddc-switch"

raycast_dir := env_var_or_default("RAYCAST_SCRIPTS", home / ".raycast/script-commands")
skills_dir := env_var_or_default("CLAUDE_SKILLS", home / ".claude/skills")

default:
    @just --list --unsorted

deps:
    bun install

typecheck:
    bun run tsc --noEmit

cli *args:
    bun run src/main.ts {{ args }}

probe *args:
    bun run scripts/probe-ddc.ts {{ args }}

build: deps
    bun run scripts/build.ts

# --------------------------------------------------------------- installation

install: check build _link _config
    @echo ""
    @echo "Done."
    @just _next-steps
    @just _check-path

# prerequisites

[macos]
check:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v m1ddc >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/m1ddc ]]; then
      echo "m1ddc not found. Run 'brew install m1ddc' first." >&2
      exit 1
    fi
    echo "==> OK (m1ddc)"

[windows]
check:
    @if (-not (Test-Path "$env:SystemRoot\System32\dxva2.dll")) { Write-Error "dxva2.dll not found."; exit 1 }
    @Write-Output "==> OK (dxva2.dll)"

# link / deploy

[macos]
_link:
    @echo "==> install to {{ prefix }}"
    mkdir -p "{{ prefix }}"
    install -m 755 dist/ddc "{{ prefix }}/.ddc.new"
    mv -f "{{ prefix }}/.ddc.new" "{{ prefix }}/ddc"
    rm -f "{{ prefix }}/ddcd"  # 旧名 (daemon 時代の名残) が残っていたら掃除する

[windows]
_link:
    @Write-Output "==> install to {{ prefix }}"
    @New-Item -ItemType Directory -Force "{{ prefix }}" | Out-Null
    @$dst = "{{ prefix }}\ddc.exe"; $old = "{{ prefix }}\ddc.old.exe"; \
     if (Test-Path $old) { try { Remove-Item $old -Force -ErrorAction Stop } catch {} }; \
     if (Test-Path $dst) { Move-Item $dst $old -Force }; \
     Copy-Item dist\ddc.exe $dst -Force; \
     if (Test-Path $old) { try { Remove-Item $old -Force -ErrorAction Stop } catch { Write-Output "    (running process — ddc.old.exe removed next time)" } }
    @Remove-Item -Force -ErrorAction SilentlyContinue "{{ prefix }}\ddcd.exe", "{{ prefix }}\ddcd.old.exe", "{{ prefix }}\ddc.cmd" # 旧名 (daemon 時代の名残) の掃除

# config file

[macos]
_config:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> config"
    mkdir -p "{{ config_dir }}"
    if [[ -f "{{ config_dir }}/config.json" ]]; then
      echo "    {{ config_dir }}/config.json already exists, skipping"
      exit 0
    fi
    cp config.default.json "{{ config_dir }}/config.json"
    echo "    created {{ config_dir }}/config.json"

[windows]
_config:
    @Write-Output "==> config"
    @New-Item -ItemType Directory -Force "{{ config_dir }}" | Out-Null
    @if (Test-Path "{{ config_dir }}\config.json") { \
       Write-Output "    {{ config_dir }}\config.json already exists, skipping" \
     } else { \
       Copy-Item config.default.json "{{ config_dir }}\config.json"; \
       Write-Output "    created {{ config_dir }}\config.json" \
     }

# raycast scripts

[macos]
raycast:
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{ justfile_directory() }}/raycast"
    dst="{{ raycast_dir }}"

    if [[ ! -x "{{ prefix }}/ddc" ]]; then
      echo "{{ prefix }}/ddc not found. Run 'just install' first." >&2
      exit 1
    fi

    for f in "$src"/ddc-*.sh; do
      for key in schemaVersion title mode; do
        grep -q "@raycast.$key" "$f" || { echo "$(basename "$f"): @raycast.$key missing" >&2; exit 1; }
      done
    done

    echo "==> ddc connectivity check"
    "{{ prefix }}/ddc" inputs > /dev/null
    echo "    OK ({{ prefix }}/ddc)"

    fresh=0
    [[ -d "$dst" ]] || { mkdir -p "$dst"; fresh=1; }

    echo "==> deploy to $dst"
    rm -f "$dst"/ddc-*.sh
    install -m 700 "$src"/ddc-*.sh "$dst/"
    for f in "$src"/ddc-*.sh; do
      printf '    %-20s %s\n' "$(basename "$f")" "$(grep -m1 '@raycast.title' "$f" | sed 's/.*@raycast.title //')"
    done

    if (( fresh )); then
      printf '%s' "$dst" | pbcopy
      cat <<MSG

    New script directory. Register it in Raycast:
      Preferences → Extensions → Script Commands → Add Script Directory
      Cmd+Shift+G → Cmd+V (path is copied) → Enter
MSG
    else
      echo ""
      echo "Raycast: search for "Switch Display to Type-C" etc."
      echo "Assign hotkeys via Record Hotkey on each command."
    fi

[windows]
raycast:
    @pwsh -NoLogo -NoProfile -File "{{ justfile_directory() }}\scripts\raycast-install.ps1" -Prefix "{{ prefix }}" -Destination "{{ raycast_dir }}"

# skills

[macos]
skill:
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{ justfile_directory() }}/skills"
    dst="{{ skills_dir }}"

    for d in "$src"/*/; do
      f="$d/SKILL.md"
      [[ -f "$f" ]] || { echo "$(basename "$d"): SKILL.md missing" >&2; exit 1; }
      for key in name description; do
        grep -q "^$key:" "$f" || { echo "$(basename "$d")/SKILL.md: $key: missing" >&2; exit 1; }
      done
    done

    echo "==> deploy to $dst"
    mkdir -p "$dst"
    for d in "$src"/*/; do
      name="$(basename "$d")"
      rm -rf "${dst:?}/$name"
      cp -R "$d" "$dst/$name"
      printf '    %-16s %s\n' "$name" "$(grep -m1 '^description:' "$d/SKILL.md" | cut -c14- | cut -c1-60)…"
    done

    echo ""
    echo "Reload Claude Code to pick it up (/skills to list)."

# other

[macos]
_next-steps:
    @echo "  status:      {{ prefix }}/ddc status"
    @echo "  raycast:     just raycast"
    @echo "  claude code: just skill"

[windows]
_next-steps:
    @Write-Output "  status: {{ prefix }}\ddc status"
    @Write-Output "  raycast: just raycast"

[macos]
_check-path:
    #!/usr/bin/env bash
    if [[ ":$PATH:" != *":{{ prefix }}:"* ]]; then
      echo ""
      echo "warning: {{ prefix }} not in PATH"
    fi

[windows]
_check-path:
    @$p = "{{ prefix }}".Replace('/', '\'); \
     if (($env:PATH -split ';') -notcontains $p) { \
       Write-Output ''; \
       Write-Output ('warning: ' + $p + ' not in PATH'); \
     }

[macos]
uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -f "{{ prefix }}/ddc" "{{ prefix }}/ddcd"  # ddcd は旧名
    rm -f "{{ raycast_dir }}"/ddc-*.sh
    for d in "{{ justfile_directory() }}"/skills/*/; do
      rm -rf "{{ skills_dir }}/$(basename "$d")"
    done
    echo "uninstalled. config in {{ config_dir }} preserved."

[windows]
uninstall:
    @Remove-Item -Force -ErrorAction SilentlyContinue "{{ prefix }}\ddc.exe", "{{ prefix }}\ddc.old.exe", "{{ prefix }}\ddcd.exe", "{{ prefix }}\ddcd.old.exe", "{{ prefix }}\ddc.cmd"
    @Remove-Item -Force -ErrorAction SilentlyContinue "{{ raycast_dir }}\ddc-*.ps1"
    @Write-Output "uninstalled. config in {{ config_dir }} preserved."
