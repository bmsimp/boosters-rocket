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
  With -SetUpMail -Mailbox <address>, it also lets the app send mail as that one mailbox (Exchange Online RBAC for
  Applications: a management scope holding only the mailbox, and the "Application Mail.Send" role on that scope). It
  refuses while the app holds Microsoft Graph's unscoped Mail.Send application permission. This part needs an Exchange
  administrator and the ExchangeOnlineManagement module.
.EXAMPLE
  ./New-BoosterRocketStaffApp.ps1 -TenantId 0f8fad5b-d9cb-469f-a165-70867728950e
.EXAMPLE
  ./New-BoosterRocketStaffApp.ps1 -TenantId 0f8fad5b-d9cb-469f-a165-70867728950e -SetUpMail -Mailbox webmaster@fznband.org
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__',
  [switch]$SetUpMail,
  [string]$Mailbox
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
if ($SetUpMail -and -not $Mailbox) { throw 'Pass -Mailbox with the address the portal sends as, for example -Mailbox webmaster@yourclub.org' }
if ($SetUpMail) {
  $Mailbox = $Mailbox.Trim().ToLowerInvariant()
  if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    Write-Host 'Setting up mail needs the Exchange Online PowerShell module. Install it with:'
    Write-Host '  Install-Module ExchangeOnlineManagement -Scope CurrentUser'
    exit 2
  }
}
$MailSendAppRoleId = 'b633e1c5-b582-4048-a93e-9f11b44c7e96' # Microsoft Graph application permission Mail.Send
$ScopeName = 'Booster Rocket mail sender'

$DisplayName = 'Booster Rocket (staff)'
$RedirectUri = "$AppUrl/api/auth/staff/callback/microsoft"
$GraphAppId = '00000003-0000-0000-c000-000000000000'
# Microsoft Graph delegated permission IDs: openid, profile, email, offline_access, User.Read
$Scopes = [ordered]@{
  'openid' = '37f7f235-527c-4136-accd-4a02d197296e'; 'profile' = '14dad69e-099b-42c9-810b-d002981feec1'
  'email' = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; 'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
  'User.Read' = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
}

function Get-AppsNamed([string]$DisplayName) {
  $uri = 'v1.0/applications?$select=id,appId,displayName&$top=999'
  $all = @()
  while ($uri) {
    $page = Invoke-MgGraphRequest GET $uri
    $all += @($page.value)
    $uri = $page.'@odata.nextLink'
  }
  return @($all | Where-Object { $_.displayName -ceq $DisplayName })
}

Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -ContextScope Process -NoWelcome
try {
  $tenant = (Get-MgContext).TenantId
  $access = @{ resourceAppId = $GraphAppId; resourceAccess = @($Scopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
  $body = @{ signInAudience = 'AzureADMyOrg'; web = @{ redirectUris = @($RedirectUri) }; requiredResourceAccess = @($access) }

  $found = @(Get-AppsNamed $DisplayName)
  if ($found.Count -gt 1) { throw "More than one app is named '$DisplayName' (appId: $(($found | ForEach-Object { $_.appId }) -join ', ')). Delete the extras in the Entra admin center, then run this again." }
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
  if ($existing | Where-Object { $_.customKeyIdentifier -eq $hash -or $_.key -eq $CertificateBase64 }) {
    Write-Host 'The Booster Rocket certificate is already on the app.'
  } else {
    if ($existing | Where-Object { -not $_.key }) {
      throw "Microsoft didn't return this app's existing certificates, so the script stopped rather than risk removing them. Upload the .cer from the setup page by hand: Certificates & secrets > Certificates > Upload certificate."
    }
    $expired = $existing | Where-Object { $_.endDateTime -and [datetime]$_.endDateTime -lt (Get-Date) } | Select-Object -First 1
    if ($expired) {
      $who = if ($expired.displayName) { $expired.displayName } else { $expired.keyId }
      throw "This app has an expired certificate ($who), which Microsoft won't accept back. Remove it in the Entra admin center under Certificates & secrets > Certificates, then run this script again."
    }
    $keys = @($existing | ForEach-Object { $k = @{}; foreach ($name in 'type', 'usage', 'key', 'displayName', 'keyId', 'customKeyIdentifier', 'startDateTime', 'endDateTime') { if ($null -ne $_.$name) { $k[$name] = $_.$name } }; $k })
    $keys += @{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = $CertificateBase64; displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')" }
    Invoke-MgGraphRequest PATCH "v1.0/applications/$($app.id)" -Body (@{ keyCredentials = @($keys) } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
    Write-Host 'Added the Booster Rocket certificate to the app. Certificates already on it were kept.'
  }

  if ($SetUpMail) {
    # An unscoped Graph Mail.Send grant would let the app send as anyone; RBAC for Applications only adds to it.
    $grants = @((Invoke-MgGraphRequest GET "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments").value)
    if ($grants | Where-Object { $_.resourceId -eq $graphSp.id -and $_.appRoleId -eq $MailSendAppRoleId }) {
      throw "The app '$DisplayName' holds Microsoft Graph's Mail.Send application permission, which would let it send as anyone. Remove it first: Entra admin center > Enterprise applications > $DisplayName > Permissions, select Mail.Send and Revoke permission (and remove Mail.Send from App registrations > $DisplayName > API permissions). Then run this script again."
    }
    Connect-ExchangeOnline -ShowBanner:$false
    try {
      if (-not (Get-EXOMailbox -Identity $Mailbox -ErrorAction SilentlyContinue)) {
        throw "Exchange Online has no mailbox $Mailbox. Use the address of an existing mailbox in this tenant."
      }
      if (-not (Get-ServicePrincipal -Identity $sp.id -ErrorAction SilentlyContinue)) {
        New-ServicePrincipal -AppId $app.appId -ObjectId $sp.id -DisplayName $DisplayName | Out-Null
        Write-Host "Pointed Exchange Online at the app '$DisplayName'."
      }
      $filter = "PrimarySmtpAddress -eq '$Mailbox'"
      if (Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue) {
        Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $filter
      } else {
        New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$Mailbox'" | Out-Null
      }
      $assignment = Get-ManagementRoleAssignment -Role 'Application Mail.Send' -ErrorAction SilentlyContinue |
        Where-Object { $_.RoleAssigneeName -eq $sp.id -or $_.RoleAssignee -eq $sp.id } | Select-Object -First 1
      if ($assignment) {
        Set-ManagementRoleAssignment -Identity $assignment.Identity -CustomResourceScope $ScopeName
      } else {
        New-ManagementRoleAssignment -App $sp.id -Role 'Application Mail.Send' -CustomResourceScope $ScopeName | Out-Null
      }
      $check = Test-ServicePrincipalAuthorization -Identity $sp.id -Resource $Mailbox | Where-Object { $_.RoleName -eq 'Application Mail.Send' }
      if ($check -and $check.InScope) { Write-Host "The app can now send as $Mailbox, and only as $Mailbox." }
      else { Write-Host "The role assignment is in place, but Exchange doesn't report $Mailbox in scope yet. Check the mailbox address." }
      Write-Host 'Microsoft can take from 30 minutes to 2 hours to apply this. Then use Send test email on the setup page.'
    } finally {
      Disconnect-ExchangeOnline -Confirm:$false | Out-Null
    }
  }

  Write-Host ''
  Write-Host 'Enter these on the Booster Rocket setup page. There is no secret to copy.'
  Write-Host "  Tenant ID:            $tenant"
  Write-Host "  Client ID:            $($app.appId)"
  Write-Host "  Certificate:          $($Certificate.Thumbprint) (expires $($Certificate.NotAfter.ToUniversalTime().ToString('yyyy-MM-dd')))"
  if ($SetUpMail) { Write-Host "  Mail:                 Microsoft 365, sending as $Mailbox" }
  Write-Host 'A new certificate can take a minute to start working. If the setup page says Microsoft does not have it yet, wait and try again.'
} finally {
  Disconnect-MgGraph | Out-Null
}
