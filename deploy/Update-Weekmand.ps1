[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$')]
    [string]$Target = 'root@192.168.1.1',
    [ValidateRange(1,65535)]
    [int]$Port = 22,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$remoteRoot = '/opt/weekmand'
$project = Split-Path -Parent $PSScriptRoot
$deployState = Join-Path $project '.deploy'
$identity = Join-Path $deployState 'router_ed25519'
$knownHosts = Join-Path $deployState 'known_hosts'
if (!(Test-Path -LiteralPath $identity -PathType Leaf) -or !(Test-Path -LiteralPath $knownHosts -PathType Leaf)) {
    throw 'De lokale deploysleutel of het vertrouwde known_hosts-bestand ontbreekt in .deploy.'
}

$release = (Get-Date -AsUTC -Format 'yyyyMMdd-hhmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$archive = Join-Path $deployState "$release.tgz"
$destination = "$remoteRoot/releases/$release"
$remote = "set -eu; umask 077; mkdir -p '$remoteRoot/releases'; mkdir '$destination'; cat > '$destination/bundle.tgz'; tar -xzf '$destination/bundle.tgz' -C '$destination'; rm -f '$destination/bundle.tgz'; sh '$destination/deploy/activate.sh' '$remoteRoot' '$release'"
$sshArguments = @(
    '-T', '-i', $identity, '-p', "$Port", '-o', 'IdentitiesOnly=yes',
    '-o', "UserKnownHostsFile=$knownHosts", '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $Target, $remote
)

Push-Location -LiteralPath $project
try {
    if (!$SkipTests) {
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'De tests zijn mislukt. Deployment afgebroken.' }
    }
    # Alle afhankelijkheden moeten exact de vastgepinde versies uit het lockbestand zijn.
    $lock = (Get-Content -Raw package-lock.json | ConvertFrom-Json -AsHashtable).packages
    foreach ($entry in $lock.GetEnumerator()) {
        if (-not $entry.Key.StartsWith('node_modules/')) { continue }
        $manifest = Join-Path $entry.Key 'package.json'
        if (!(Test-Path -LiteralPath $manifest) -or (Get-Content -Raw $manifest | ConvertFrom-Json).version -ne $entry.Value.version) {
            throw "Voer npm ci uit voordat je deze versie uitrolt ($($entry.Key))."
        }
    }
    # Welke versie dit is: de updatemelding in de webapp vergelijkt deze commit met main op GitHub.
    $commit = (git -c safe.directory='*' rev-parse HEAD).Trim()
    $dirty = [bool](git -c safe.directory='*' status --porcelain --untracked-files=no)
    [ordered]@{ commit = $commit; dirty = $dirty; source = 'local'; at = (Get-Date -AsUTC -Format 'o') } | ConvertTo-Json -Compress | Set-Content -Encoding utf8NoBOM release.json
    $files = @('package.json','package-lock.json','release.json','src','public','node_modules','deploy/activate.sh','deploy/weekmand.init','deploy/updater.mjs','deploy/weekmand-updater.init')
    tar.exe -czf $archive -- @files
    Remove-Item -LiteralPath release.json
    if ($LASTEXITCODE -ne 0) { throw 'De release kon niet worden verpakt.' }

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new('ssh.exe')
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardInput = $true
    foreach ($argument in $sshArguments) { $processInfo.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($processInfo)
    try {
        $inputStream = [System.IO.File]::OpenRead($archive)
        try { $inputStream.CopyTo($process.StandardInput.BaseStream) }
        finally {
            $inputStream.Dispose()
            $process.StandardInput.Close()
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Deployment $release is mislukt." }
    } finally {
        $process.Dispose()
    }
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    Pop-Location
}
