[CmdletBinding()]
param(
    [string]$Path = (Join-Path $env:LOCALAPPDATA "ArtFi\secrets\hoodi-test-wallet.key")
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This provisioning script requires Windows."
}

$fullPath = [IO.Path]::GetFullPath($Path)
if (Test-Path -LiteralPath $fullPath) {
    throw "Refusing to overwrite an existing test wallet key."
}

$directory = Split-Path -Parent $fullPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null

$keyBytes = [byte[]]::new(32)
do {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($keyBytes)
    } finally {
        $rng.Dispose()
    }
} while (($keyBytes | Where-Object { $_ -ne 0 }).Count -eq 0)

try {
    $privateKey = "0x" + ([BitConverter]::ToString($keyBytes) -replace "-", "").ToLowerInvariant()
    [IO.File]::WriteAllText(
        $fullPath,
        $privateKey + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
} finally {
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
    $privateKey = $null
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$readOnlyRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [Security.AccessControl.FileSystemRights]::Synchronize

$fileAcl = [Security.AccessControl.FileSecurity]::new()
$fileAcl.SetOwner($currentSid)
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    $readOnlyRights,
    [Security.AccessControl.AccessControlType]::Allow
))
$fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $systemSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
))
(Get-Item -LiteralPath $fullPath -Force).IsReadOnly = $true
Set-Acl -LiteralPath $fullPath -AclObject $fileAcl

# Protect the containing secrets directory as well. Otherwise a user with directory
# delete/create rights could replace an individually read-only file with another file.
$directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
$directoryAcl.SetOwner($currentSid)
$directoryAcl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
$directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    $readOnlyRights,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
))
$directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $systemSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
))
Set-Acl -LiteralPath $directory -AclObject $directoryAcl

& (Join-Path $PSScriptRoot "Test-ArtFiTestWalletAcl.ps1") -Path $fullPath -Quiet
Write-Output "wallet_file_configured=true"
Write-Output "wallet_file_read_only=true"
