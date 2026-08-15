# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Switch Display to HDMI
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🖥️
# @raycast.packageName Display
# @raycast.description Switch the external display input to the HDMI port

$ddc = (Get-Command ddc -ErrorAction SilentlyContinue).Source
if (-not $ddc) { $ddc = Join-Path $env:USERPROFILE '.local\bin\ddc.exe' }
& $ddc hdmi
exit $LASTEXITCODE
