#Requires -Version 7.0
<#
.SYNOPSIS
  Creates (or updates) the Booster Rocket staff sign-in app in your club's Microsoft Entra tenant.
.DESCRIPTION
  Signs you in with the normal Microsoft browser sign-in (never device code), then:
    1. finds the app "Booster Rocket (staff)" or creates it (single tenant),
    2. sets its redirect URI,
    3. requests the sign-in scopes openid, profile, email, offline_access and User.Read,
    4. creates its service principal and grants admin consent for those scopes,
    5. adds Booster Rocket's certificate (made by your Booster Rocket
       server; only its public half is in this script),
  and prints the values to paste into the Booster Rocket setup page. Nothing is written to disk.
  Safe to run again: it reuses the app and adds the certificate if it is not already there, leaving other certificates alone.
.EXAMPLE
  ./New-BoosterRocketStaffApp.ps1 -TenantId 0f8fad5b-d9cb-469f-a165-70867728950e
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__'
)
$ErrorActionPreference = 'Stop'

if ($AppUrl -notmatch '^https?://') { throw 'Pass -AppUrl with your site address, for example -AppUrl https://portal.example.org' }
$AppUrl = $AppUrl.TrimEnd('/')
$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'
if ($CertificateBase64 -notmatch '^[A-Za-z0-9+/]{200,}={0,2}$') { throw 'Download this script from the Booster Rocket setup page; it carries the certificate to add to the app.' }
$Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($CertificateBase64))
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
  Write-Host 'This script needs the Microsoft Graph PowerShell module. Install it with:'
  Write-Host '  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
  exit 2
}

$DisplayName = 'Booster Rocket (staff)'
$RedirectUri = "$AppUrl/api/auth/staff/callback/microsoft"
$GraphAppId = '00000003-0000-0000-c000-000000000000'
# Microsoft Graph delegated permission IDs: openid, profile, email, offline_access, User.Read
$Scopes = [ordered]@{
  'openid' = '37f7f235-527c-4136-accd-4a02d197296e'; 'profile' = '14dad69e-099b-42c9-810b-d002981feec1'
  'email' = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; 'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
  'User.Read' = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
}

Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -ContextScope Process -NoWelcome
try {
  $tenant = (Get-MgContext).TenantId
  $access = @{ resourceAppId = $GraphAppId; resourceAccess = @($Scopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
  $body = @{ signInAudience = 'AzureADMyOrg'; web = @{ redirectUris = @($RedirectUri) }; requiredResourceAccess = @($access) }

  $found = (Invoke-MgGraphRequest GET "v1.0/applications?`$filter=displayName eq '$DisplayName'").value
  if ($found.Count -gt 1) { throw "More than one app is named '$DisplayName'. Delete the extras in the Entra admin center, then run this again." }
  if ($found.Count -eq 1) {
    $app = $found[0]
    Invoke-MgGraphRequest PATCH "v1.0/applications/$($app.id)" -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json' | Out-Null
    Write-Host "Reusing the existing app '$DisplayName' and making sure its settings are right."
  } else {
    $body.displayName = $DisplayName
    $app = Invoke-MgGraphRequest POST 'v1.0/applications' -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json'
    Write-Host "Created the app '$DisplayName'."
  }

  $sp = (Invoke-MgGraphRequest GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'").value | Select-Object -First 1
  if (-not $sp) { $sp = Invoke-MgGraphRequest POST 'v1.0/servicePrincipals' -Body (@{ appId = $app.appId } | ConvertTo-Json) -ContentType 'application/json' }
  $graphSp = (Invoke-MgGraphRequest GET "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'").value | Select-Object -First 1
  $scopeText = ($Scopes.Keys -join ' ')
  $grant = (Invoke-MgGraphRequest GET "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)' and consentType eq 'AllPrincipals' and resourceId eq '$($graphSp.id)'").value | Select-Object -First 1
  if ($grant) {
    Invoke-MgGraphRequest PATCH "v1.0/oauth2PermissionGrants/$($grant.id)" -Body (@{ scope = $scopeText } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  } else {
    Invoke-MgGraphRequest POST 'v1.0/oauth2PermissionGrants' -Body (@{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = $scopeText } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  }
  Write-Host 'Granted admin consent for the sign-in scopes, so staff will not see a consent prompt.'

  $existing = @((Invoke-MgGraphRequest GET "v1.0/applications/$($app.id)?`$select=keyCredentials").keyCredentials)
  $hash = [Convert]::ToBase64String($Certificate.GetCertHash())
  if ($existing | Where-Object { $_.customKeyIdentifier -eq $hash }) {
    Write-Host 'The Booster Rocket certificate is already on the app.'
  } else {
    if ($existing | Where-Object { -not $_.key }) {
      throw "Microsoft didn't return this app's existing certificates, so the script stopped rather than risk removing them. Upload the .cer from the setup page by hand: Certificates & secrets > Certificates > Upload certificate."
    }
    $keys = @($existing | ForEach-Object { @{ type = $_.type; usage = $_.usage; key = $_.key; displayName = $_.displayName } })
    $keys += @{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = $CertificateBase64; displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')" }
    Invoke-MgGraphRequest PATCH "v1.0/applications/$($app.id)" -Body (@{ keyCredentials = @($keys) } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
    Write-Host 'Added the Booster Rocket certificate to the app. Certificates already on it were kept.'
  }

  Write-Host ''
  Write-Host 'Enter these on the Booster Rocket setup page. There is no secret to copy.'
  Write-Host "  Tenant ID:            $tenant"
  Write-Host "  Client ID:            $($app.appId)"
  Write-Host "  Certificate:          $($Certificate.Thumbprint) (expires $($Certificate.NotAfter.ToUniversalTime().ToString('yyyy-MM-dd')))"
  Write-Host 'A new certificate can take a minute to start working. If the setup page says Microsoft does not have it yet, wait and try again.'
} finally {
  Disconnect-MgGraph | Out-Null
}
