param([switch]$Check,[switch]$BuildOnly,[switch]$NoDialogs)
$ErrorActionPreference = 'Stop'
$ediroRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ediroRoot
$env:ELECTRON_RUN_AS_NODE = $null
$ediroForm = $null
$ediroMutex = $null
$ediroOwnsLock = $false
try {
    $ediroLocalNode = Join-Path $ediroRoot '.local\runtime-tools\node\node.exe'
    $ediroNode = if (Test-Path -LiteralPath $ediroLocalNode) { $ediroLocalNode } else { (Get-Command node -ErrorAction Stop).Source }
    & $ediroNode -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<12)){console.error('Ediro needs Node.js 22.12 or newer.');process.exit(1)}"
    if ($LASTEXITCODE -ne 0) { throw '需要 Node.js 22.12 或更新版本。' }
    $ediroElectron = Join-Path $ediroRoot 'node_modules\electron\dist\electron.exe'
    if (!(Test-Path -LiteralPath $ediroElectron)) { throw '桌面依赖尚未安装完整，找不到 Electron。请把此提示发给开发助手。' }
    if (!$Check) {
        $ediroHash = [Security.Cryptography.SHA256]::Create()
        try { $ediroLockName = [BitConverter]::ToString($ediroHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ediroRoot.ToLowerInvariant()))).Replace('-','') } finally { $ediroHash.Dispose() }
        $ediroMutex = New-Object Threading.Mutex($false, ('Local\EdiroStartup_' + $ediroLockName))
        try { $ediroOwnsLock = $ediroMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ediroOwnsLock = $true }
        if (!$ediroOwnsLock) { exit 0 }
    }
    $ediroReason = (& $ediroNode '.\scripts\build-state.mjs' --check 2>&1 | Out-String).Trim()
    $ediroCheckCode = $LASTEXITCODE
    if ($ediroCheckCode -ne 0 -and $ediroCheckCode -ne 10) { throw $ediroReason }
    if ($Check) { Write-Output $ediroReason; exit 0 }
    if ($ediroCheckCode -eq 10) {
        Write-Output ('正在自动构建：' + $ediroReason)
        if (!$NoDialogs) {
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $ediroForm = New-Object Windows.Forms.Form
            $ediroForm.Text = 'Ediro · 正在更新'
            $ediroForm.Size = New-Object Drawing.Size(460,160)
            $ediroForm.StartPosition = 'CenterScreen'
            $ediroForm.FormBorderStyle = 'FixedDialog'
            $ediroForm.ControlBox = $false
            $ediroLabel = New-Object Windows.Forms.Label
            $ediroLabel.Text = "正在自动构建，请稍候…`r`n$ediroReason"
            $ediroLabel.Location = New-Object Drawing.Point(20,20)
            $ediroLabel.Size = New-Object Drawing.Size(410,50)
            $ediroForm.Controls.Add($ediroLabel)
            $ediroProgress = New-Object Windows.Forms.ProgressBar
            $ediroProgress.Style = 'Marquee'
            $ediroProgress.Location = New-Object Drawing.Point(20,80)
            $ediroProgress.Size = New-Object Drawing.Size(410,18)
            $ediroForm.Controls.Add($ediroProgress)
            $ediroForm.Show()
            [Windows.Forms.Application]::DoEvents()
        }
        $ediroBuildScript = Join-Path $PSScriptRoot 'launch-build.mjs'
        $ediroNpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
        $env:EDIRO_NPM_CLI = Join-Path (Split-Path -Parent $ediroNpmCommand) 'node_modules\npm\bin\npm-cli.js'
        if (!(Test-Path -LiteralPath $env:EDIRO_NPM_CLI)) { throw '找不到 npm 构建工具，请把此提示发给开发助手。' }
        $ediroBuild = Start-Process -FilePath $ediroNode -ArgumentList ('"' + $ediroBuildScript + '"') -WorkingDirectory $ediroRoot -WindowStyle Hidden -PassThru
        while (!$ediroBuild.HasExited) {
            if ($ediroForm) { [Windows.Forms.Application]::DoEvents() }
            Start-Sleep -Milliseconds 80
            $ediroBuild.Refresh()
        }
        $ediroBuild.WaitForExit()
        if ($ediroForm) { $ediroForm.Close(); $ediroForm.Dispose(); $ediroForm = $null }
        if ($ediroBuild.ExitCode -ne 0) {
            $ediroLogPath = Join-Path $ediroRoot '.local\launcher\build.log'
            $ediroDetails = if (Test-Path -LiteralPath $ediroLogPath) { (Get-Content -LiteralPath $ediroLogPath -Encoding UTF8 | Select-Object -Last 45) -join "`r`n" } else { '构建进程未留下日志。' }
            throw "构建失败，没有启动旧版本。`r`n`r`n$ediroDetails`r`n`r`n完整日志：$ediroLogPath"
        }
        $ediroReason = (& $ediroNode '.\scripts\build-state.mjs' --check 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw ('构建后检查未通过：' + $ediroReason) }
        Write-Output '自动构建完成。'
    }
    if ($BuildOnly) { Write-Output 'Ediro 已是最新构建。'; exit 0 }
    if ($ediroOwnsLock) { $ediroMutex.ReleaseMutex(); $ediroOwnsLock = $false }
    Start-Process -FilePath $ediroElectron -ArgumentList ('"' + $ediroRoot + '"') -WorkingDirectory $ediroRoot -WindowStyle Normal
    exit 0
} catch {
    $ediroMessage = $_.Exception.Message
    if (!$NoDialogs) {
        if ($ediroForm) { $ediroForm.Close() }
        $ediroShell = New-Object -ComObject WScript.Shell
        $null = $ediroShell.Popup($ediroMessage,0,'Ediro · 启动失败',16)
    }
    [Console]::Error.WriteLine($ediroMessage)
    exit 1
} finally {
    if ($ediroForm) { $ediroForm.Dispose() }
    if ($ediroOwnsLock) { $ediroMutex.ReleaseMutex() }
    if ($ediroMutex) { $ediroMutex.Dispose() }
}
