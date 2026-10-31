param(
    [ValidateSet("1.21.11-fabric", "1.20.1-fabric")]
    [string]$Profile = "1.21.11-fabric"
)

$ErrorActionPreference = "Stop"
$TargetScript = Join-Path $PSScriptRoot "servers\$Profile\start.ps1"

if (-not (Test-Path $TargetScript)) {
    Write-Error "Server profile '$Profile' is not provisioned yet. Run: node mc-env/scripts/setup-server.mjs"
    exit 1
}

& $TargetScript
