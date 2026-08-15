# Raycast (Windows) の Script Commands を配置する。`just raycast` から呼ばれる。
#
# macOS 側は justfile の中の bash で完結しているが、Windows のレシピは 1 行ごとに
# 別プロセスになって変数を持ち越せないため、こちらだけスクリプトに切り出している。

[CmdletBinding()]
param(
    # ddc.exe の配置先 (justfile の PREFIX)
    [string]$Prefix = (Join-Path $env:USERPROFILE '.local\bin'),
    # Raycast の Script Directory (justfile の RAYCAST_SCRIPTS)
    [string]$Destination = (Join-Path $env:USERPROFILE '.raycast\script-commands')
)

$ErrorActionPreference = 'Stop'

# justfile の PATH は区切りが混ざる場合があるので統一
$Prefix = $Prefix.Replace('/', '\')
$Destination = $Destination.Replace('/', '\')

$source = Resolve-Path (Join-Path $PSScriptRoot '..\raycast')
$exe = Join-Path $Prefix 'ddc.exe'

if (-not (Test-Path $exe)) {
    throw "$exe がありません。先に 'just install' を実行してください。"
}

$scripts = Get-ChildItem $source -Filter 'ddc-*.ps1'
if ($scripts.Count -eq 0) { throw "$source に ddc-*.ps1 がありません。" }

# メタデータが欠けているとスクリプトが Raycast の一覧に出ない
foreach ($script in $scripts) {
    foreach ($key in 'schemaVersion', 'title', 'mode') {
        if (-not (Select-String -Path $script.FullName -Pattern "@raycast\.$key" -Quiet)) {
            throw "$($script.Name): @raycast.$key がありません"
        }
    }
}

# 読み取り系を 1 回だけ叩いて疎通確認する (画面は変わらない)
Write-Output '==> ddc の疎通確認'
& $exe inputs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$exe の実行に失敗しました (exit $LASTEXITCODE)" }
Write-Output "    OK ($exe)"

New-Item -ItemType Directory -Force $Destination | Out-Null

# 他のスクリプトと同居するので ddc- 接頭辞で名前空間を分ける
Write-Output "==> $Destination に配置"
Copy-Item (Join-Path $source 'ddc-*.ps1') $Destination -Force
foreach ($script in $scripts) {
    $title = (Select-String -Path $script.FullName -Pattern '@raycast\.title (.*)').Matches[0].Groups[1].Value
    Write-Output ('    {0,-22} {1}' -f $script.Name, $title.Trim())
}

# Raycast の設定 DB は暗号化されていて CLI からは読めないので、登録済みかどうかを
# 判定できない。macOS 版と違って毎回案内を出し、パスもクリップボードに置いておく
Set-Clipboard -Value $Destination
Write-Output ''
Write-Output '一覧に出ない場合は Script Directory の登録が要ります (初回だけ):'
Write-Output ''
Write-Output '  Raycast 設定 → Extensions → Script Commands → Add Script Directory'
Write-Output "  開いたダイアログにパスを貼り付ける (コピー済み: $Destination)"
Write-Output ''
Write-Output 'そのあと Raycast で "Switch Display to Type-C" などを検索できるようになる。'
Write-Output 'ホットキーはそのコマンドを選んで Record Hotkey から割り当てる。'
