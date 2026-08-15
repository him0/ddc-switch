#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Switch Display to HDMI
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🪟
# @raycast.packageName Display
# @raycast.description Switch the external display input to HDMI

ddc="$(command -v ddc 2>/dev/null || echo "$HOME/.local/bin/ddc")"
exec "$ddc" hdmi
