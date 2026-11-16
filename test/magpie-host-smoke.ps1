[CmdletBinding()]
param([string]$CliPath = (Join-Path $PSScriptRoot '../.local-validation/magpie-cli-windows-amd64.exe'))
$ErrorActionPreference = 'Stop'
$resolvedCli = (Resolve-Path $CliPath).Path
$validationRoot = Split-Path $resolvedCli -Parent
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedHash = '1991382e8e0fefee01c20b256d6be53efc3118f527b0579fd850f601b51d2ae4'
if ((Get-FileHash $resolvedCli -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Expected official Magpie v0.1.3250 Windows amd64 CLI' }
if (-not (Test-Path (Join-Path $validationRoot '.portable') -PathType Leaf)) { throw 'Create a .portable marker beside this isolated test executable first' }
# Run in a disposable directory, never beside a real Magpie installation.
if ($validationRoot -eq $repo) { throw 'The isolated executable must be in a dedicated test directory' }
$env:HOME = $validationRoot
$env:USERPROFILE = $validationRoot
$env:APPDATA = $validationRoot
$env:LOCALAPPDATA = $validationRoot
$env:XDG_CONFIG_HOME = $validationRoot
$env:XDG_CACHE_HOME = $validationRoot
$env:MAGPIE_NO_ACCOUNTS = '1'
$env:MAGPIE_ADDR = '127.0.0.1:0'
& $resolvedCli plugin add $repo
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed' }
& $resolvedCli plugin options $repo '{"models":[{"id":"offline-test","api":"responses"},{"id":"offline-chat","api":"chat"}]}'
if ($LASTEXITCODE -ne 0) { throw 'Plugin options failed' }
'[ {"groupId":101,"key":"SYNTHETIC-NONFUNCTIONAL-KEY","multiplier":0.08,"models":["offline-test","offline-chat"]} ]' | & $resolvedCli plugin login aihub-auto 1
if ($LASTEXITCODE -ne 0) { throw 'Synthetic manual authentication failed' }
$json = & $resolvedCli plugin --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin inspection failed' }
$state = ($json -join "`n") | ConvertFrom-Json
$provider = @($state.providers | Where-Object id -eq 'aihub-auto')
if ($provider.Count -ne 1 -or -not $provider[0].signedIn) { throw 'AIHub provider was not signed in' }
$models = $provider[0].models
$responses = @($models | Where-Object { $_.id -eq 'offline-test' -and $_.npm -eq '@ai-sdk/openai' })
$chat = @($models | Where-Object { $_.id -eq 'offline-chat' -and $_.npm -eq '@ai-sdk/openai-compatible' })
if ($responses.Count -ne 1 -or $chat.Count -ne 1) { throw 'Per-model SDK registration failed' }
if (@($provider[0].methods | Where-Object { -not $_.keyless }).Count -ne 0) { throw 'Unexpected extra API key prompt' }
Write-Output 'PASS: Magpie v0.1.3250 loads the plugin, authenticates synthetic manual keys and registers both model SDKs.'
Write-Output 'No inference request or AIHub account login was sent. This does not test production deployment or browser rendering.'
