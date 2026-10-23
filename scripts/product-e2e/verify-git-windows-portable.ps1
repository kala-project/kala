param(
    [Parameter(Mandatory=$true)][string]$AssetPath,
    [string]$ProvenancePath = (Join-Path $PSScriptRoot 'fixtures\git-for-windows-portable.json')
)
$ErrorActionPreference = 'Stop'
$provenance = Get-Content -LiteralPath $ProvenancePath -Raw | ConvertFrom-Json
$asset = Get-Item -LiteralPath $AssetPath
if ($asset.PSIsContainer -or $asset.Name -ne $provenance.asset) { throw 'Expected the exact pinned official PortableGit asset.' }
if ($asset.Length -ne [long]$provenance.size) { throw 'PortableGit asset size differs from official release metadata.' }
$actualHash = (Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $provenance.sha256) { throw 'PortableGit SHA-256 differs from the pinned official release checksum.' }
$signature = Get-AuthenticodeSignature -LiteralPath $asset.FullName
$result = @{
    asset = $asset.Name
    sha256 = $actualHash
    hashMatchesOfficialRelease = $true
    signatureStatus = [string]$signature.Status
    signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
    signerThumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
    timestampSignerSubject = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })
    executedOrExtracted = $false
}
$result | ConvertTo-Json -Depth 4
if ($signature.Status -ne 'Valid') { throw 'PortableGit Authenticode is not Valid. Do not execute or extract the self-extracting executable; report the exact signature status to the coordinator.' }
