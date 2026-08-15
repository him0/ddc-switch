# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Display Status
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🖥️
# @raycast.packageName Display
# @raycast.description Show the current input, brightness, contrast and volume

$ddc = (Get-Command ddc -ErrorAction SilentlyContinue).Source
if (-not $ddc) { $ddc = Join-Path $env:USERPROFILE '.local\bin\ddc.exe' }
& $ddc status
