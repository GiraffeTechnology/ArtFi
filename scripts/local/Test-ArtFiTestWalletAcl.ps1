[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $Path).Path
$item = Get-Item -LiteralPath $resolved -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Test wallet key must be a regular, non-reparse-point file."
}
if (-not $item.IsReadOnly) {
    throw "Test wallet key must have the read-only file attribute."
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid = "S-1-5-18"
$acl = Get-Acl -LiteralPath $resolved
$ownerSid = $acl.Owner
try {
    $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
        [Security.Principal.SecurityIdentifier]
    ).Value
} catch {
    # Owner may already be a SID string.
}
if ($ownerSid -ne $currentSid) {
    throw "Test wallet key must be owned by the current user."
}
if (-not $acl.AreAccessRulesProtected) {
    throw "Test wallet key ACL inheritance must be disabled."
}

$writeRights = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership

foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        if ($sid -notin @($currentSid, $systemSid)) {
            throw "Test wallet key grants access to an unexpected principal."
        }
        if ($sid -eq $currentSid -and ($rule.FileSystemRights -band $writeRights)) {
            throw "Current user must have read-only access to the test wallet key."
        }
    }
}

$parent = Split-Path -Parent $resolved
$parentAcl = Get-Acl -LiteralPath $parent
if (-not $parentAcl.AreAccessRulesProtected) {
    throw "Test wallet secrets directory ACL inheritance must be disabled."
}
foreach ($rule in $parentAcl.Access) {
    $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        if ($sid -notin @($currentSid, $systemSid)) {
            throw "Test wallet secrets directory grants access to an unexpected principal."
        }
        if ($sid -eq $currentSid -and ($rule.FileSystemRights -band $writeRights)) {
            throw "Current user must not be able to replace the test wallet key through its directory."
        }
    }
}

if (-not $Quiet) {
    Write-Output "wallet_acl=pass"
}
