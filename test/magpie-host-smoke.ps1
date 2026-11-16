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
$configured = @(
  @{ id = 'offline-test'; api = 'responses'; npm = '@ai-sdk/openai' },
  @{ id = 'offline-chat'; api = 'chat'; npm = '@ai-sdk/openai-compatible' }
)
foreach ($platform in @('deepseek', 'zhipu', 'kimi', 'grok', 'gemini')) {
  $configured += @{ id = "${platform}::offline-test"; api = 'responses'; npm = '@ai-sdk/openai' }
}
$configured += @{ id = 'gemini::offline-native'; api = 'gemini'; npm = '@ai-sdk/google' }
$options = @{ models = @($configured | ForEach-Object { @{ id = $_.id; api = $_.api } }) } | ConvertTo-Json -Depth 5 -Compress
& $resolvedCli plugin options $repo $options
if ($LASTEXITCODE -ne 0) { throw 'Plugin options failed' }
'[ {"groupId":101,"key":"SYNTHETIC-NONFUNCTIONAL-KEY","multiplier":0.08,"models":["offline-test","offline-chat"]} ]' | & $resolvedCli plugin login aihub-auto 1
if ($LASTEXITCODE -ne 0) { throw 'Synthetic manual authentication failed' }
$json = & $resolvedCli plugin --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin inspection failed' }
$state = ($json -join "`n") | ConvertFrom-Json
$provider = @($state.providers | Where-Object id -eq 'aihub-auto')
if ($provider.Count -ne 1 -or -not $provider[0].signedIn) { throw 'AIHub provider was not signed in' }
$models = $provider[0].models
foreach ($expected in $configured) {
  $matched = @($models | Where-Object { $_.id -eq $expected.id -and $_.npm -eq $expected.npm })
  if ($matched.Count -ne 1) { throw "Per-model SDK registration failed for $($expected.id)" }
}
if (@($provider[0].methods | Where-Object { -not $_.keyless }).Count -ne 0) { throw 'Unexpected extra API key prompt' }
Write-Output 'PASS: Magpie v0.1.3250 loads the plugin, authenticates synthetic manual keys and registers all six platform namespaces and three model SDKs.'
Write-Output 'No inference request or AIHub account login was sent. This does not test production deployment or browser rendering.'
