$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& "$PSScriptRoot\scripts\launch.ps1" -BuildOnly -NoDialogs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ediroPreviewUrl = 'http://127.0.0.1:5191/?preview=1'
$ediroPreviewActive = $false
try { $null = Invoke-WebRequest 'http://127.0.0.1:5191/preview-session' -UseBasicParsing -TimeoutSec 1; $ediroPreviewActive = $true } catch {}
if (!$ediroPreviewActive) {
    $ediroPreviewLocalNode = Join-Path $PSScriptRoot '.local\runtime-tools\node\node.exe'
    $ediroPreviewNode = if (Test-Path -LiteralPath $ediroPreviewLocalNode) { $ediroPreviewLocalNode } else { (Get-Command node).Source }
    $null = Start-Process -FilePath $ediroPreviewNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'scripts\preview.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($ediroPreviewAttempt = 0; $ediroPreviewAttempt -lt 30; $ediroPreviewAttempt++) {
        try { $null = Invoke-WebRequest 'http://127.0.0.1:5191/preview-session' -UseBasicParsing -TimeoutSec 1; $ediroPreviewActive = $true; break } catch { Start-Sleep -Milliseconds 200 }
    }
}
if (!$ediroPreviewActive) { throw '浏览器验证服务启动失败，请检查 5191 端口。' }
Start-Process $ediroPreviewUrl
