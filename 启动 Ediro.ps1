param([switch]$Check,[switch]$BuildOnly,[switch]$NoDialogs)
& "$PSScriptRoot\scripts\launch.ps1" @PSBoundParameters
exit $LASTEXITCODE