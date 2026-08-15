#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Display Status
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🖥️
# @raycast.packageName Display
# @raycast.description Show the current input, brightness, contrast and volume

ddc="$(command -v ddc 2>/dev/null || echo "$HOME/.local/bin/ddc")"

# fullOutput is not a TTY but interprets ANSI escapes
export FORCE_COLOR=1
exec "$ddc" status
