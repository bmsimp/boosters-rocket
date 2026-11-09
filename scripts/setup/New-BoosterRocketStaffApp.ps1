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
    5. adds a new 24-month client secret,
  and prints the values to paste into the Booster Rocket setup page. Nothing is written to disk.
  Safe to run again: it reuses the app and adds a new secret, leaving older secrets alone.
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

  $end = (Get-Date).ToUniversalTime().AddMonths(24).ToString('o')
  $pw = Invoke-MgGraphRequest POST "v1.0/applications/$($app.id)/addPassword" -Body (@{ passwordCredential = @{ displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')"; endDateTime = $end } } | ConvertTo-Json -Depth 4) -ContentType 'application/json'
  if ($found.Count -eq 1) { Write-Host 'Added a new client secret. Older secrets on this app were left alone; delete them in the Entra admin center once the new one works.' }

  Write-Host ''
  Write-Host 'Paste these into the Booster Rocket setup page now. The secret is shown only this once.'
  Write-Host "  Tenant ID:      $tenant"
  Write-Host "  Client ID:      $($app.appId)"
  Write-Host "  Client secret:  $($pw.secretText)"
  Write-Host "  Secret expires: $(([datetime]$pw.endDateTime).ToUniversalTime().ToString('yyyy-MM-dd'))"
  Write-Host 'A brand-new secret can take a few minutes to start working. If the setup page says the secret was rejected, wait and try again.'
} finally {
  Disconnect-MgGraph | Out-Null
}
