$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$coreRoot = Join-Path $root 'packages/unity'
$platformRoot = Join-Path $root 'packages/unity-platform-services'

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$coreManifest = Get-Content -Raw (Join-Path $coreRoot 'package.json') | ConvertFrom-Json
$platformManifest = Get-Content -Raw (Join-Path $platformRoot 'package.json') | ConvertFrom-Json
$coreAssembly = Get-Content -Raw (Join-Path $coreRoot 'Runtime/OneSub.Unity.asmdef') | ConvertFrom-Json
$platformAssembly = Get-Content -Raw (Join-Path $platformRoot 'Runtime/OneSub.Unity.PlatformServices.asmdef') | ConvertFrom-Json

Assert-Condition ($coreManifest.name -eq 'com.onesub.unity') 'Unexpected Core package name.'
Assert-Condition ($coreManifest.version -eq '0.2.0') 'Unexpected Core development version.'
Assert-Condition ($coreManifest.unity -eq '2022.3') 'Core minimum Unity version must be 2022.3.'
Assert-Condition ($coreManifest.dependencies.'com.unity.purchasing' -eq '5.4.0') 'Core must pin the validated Unity IAP version.'
Assert-Condition ($coreAssembly.references.Count -eq 1 -and $coreAssembly.references -contains 'Unity.Purchasing') 'Core runtime must only reference Unity Purchasing.'

$coreText = Get-ChildItem $coreRoot -Recurse -File |
    Where-Object { $_.Extension -in @('.cs', '.asmdef', '.xml', '.json') } |
    ForEach-Object { Get-Content -Raw $_.FullName }
$forbiddenCorePatterns = @(
    'OneSubPlatformServices',
    'UnityNative.Sharing',
    'com.google.android.play:review',
    'OneSubDependencies.xml'
)
foreach ($pattern in $forbiddenCorePatterns) {
    Assert-Condition (-not ($coreText -match [regex]::Escape($pattern))) "Core package leaked optional platform dependency: $pattern"
}

Assert-Condition ($platformManifest.name -eq 'com.onesub.unity.platform-services') 'Unexpected platform-services package name.'
Assert-Condition ($platformManifest.version -eq $coreManifest.version) 'Platform-services and Core versions must match.'
Assert-Condition ($platformManifest.dependencies.'com.onesub.unity' -eq $coreManifest.version) 'Platform-services must depend on the matching Core version.'
Assert-Condition ($platformAssembly.references -contains 'OneSub.Unity') 'Platform-services must reference Core.'
Assert-Condition ($platformAssembly.references -contains 'UnityNative.Sharing') 'Platform-services must reference Unity Native Sharing.'
Assert-Condition ($platformAssembly.defineConstraints -contains 'ONESUB_NATIVE_SHARING') 'Platform-services must be disabled without Unity Native Sharing.'
Assert-Condition ($platformAssembly.versionDefines.name -contains 'com.unitynative.sharing') 'Platform-services must derive its define from the sharing package.'
Assert-Condition (Test-Path (Join-Path $platformRoot 'Editor/OneSubDependencies.xml')) 'Google Play Review dependency metadata must stay in platform-services.'

$guidEntries = foreach ($metaFile in Get-ChildItem $coreRoot, $platformRoot -Recurse -Filter '*.meta' -File) {
    $match = Select-String -Path $metaFile.FullName -Pattern '^guid:\s*(\S+)$'
    if ($match) {
        [pscustomobject]@{
            Guid = $match.Matches[0].Groups[1].Value
            Path = $metaFile.FullName
        }
    }
}
$duplicateGuids = @($guidEntries | Group-Object Guid | Where-Object { $_.Count -gt 1 })
Assert-Condition ($duplicateGuids.Count -eq 0) 'Unity package .meta files contain duplicate GUIDs.'

Write-Host "Validated Unity Core $($coreManifest.version) and optional platform-services boundaries."
