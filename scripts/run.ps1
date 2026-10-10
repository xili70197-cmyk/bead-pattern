$ErrorActionPreference = 'Stop'
$beadNode = Get-Command node -ErrorAction SilentlyContinue
if ($beadNode) {
    $beadNodePath = $beadNode.Source
} else {
    $beadCandidates = Get-ChildItem -Path (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.workbuddy\binaries\node\versions\*\node.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if (-not $beadCandidates) { throw '未找到 Node.js。请使用宿主托管运行时或安装 Node.js 20.9 以上版本。' }
    $beadNodePath = $beadCandidates[0].FullName
}
& $beadNodePath --expose-gc (Join-Path $PSScriptRoot 'bead.cjs') @args
exit $LASTEXITCODE
