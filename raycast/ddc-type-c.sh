#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Switch Display to Type-C
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🍎
# @raycast.packageName Display
# @raycast.description Switch the external display input to Type-C (USB-C)

ddc="$(command -v ddc 2>/dev/null || echo "$HOME/.local/bin/ddc")"
exec "$ddc" type-c
