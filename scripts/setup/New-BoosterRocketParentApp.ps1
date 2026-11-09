#Requires -Version 7.0
<#
.SYNOPSIS
  Sets up Booster Rocket parent sign-in in your Microsoft Entra External ID tenant.
.DESCRIPTION
  Signs you in with the normal Microsoft browser sign-in (never device code) to the External ID tenant, then:
    1. finds the app "Booster Rocket (parents)" or creates it, with its redirect URI and sign-in scopes,
    2. creates its service principal and grants admin consent for openid, profile, email and offline_access,
    3. finds the user flow "Booster Rocket parents" or creates it, with email one-time passcode sign-in and sign-up turned off,
    4. adds the app to that user flow,
    5. adds a new 24-month client secret,
  and prints the values to paste into the Booster Rocket setup page. Nothing is written to disk.
  The External ID tenant itself must already exist (create it in the Azure portal first).
.EXAMPLE
  ./New-BoosterRocketParentApp.ps1 -TenantId fznparents.onmicrosoft.com
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

$DisplayName = 'Booster Rocket (parents)'
$FlowName = 'Booster Rocket parents'
$RedirectUri = "$AppUrl/api/auth/parent/callback/parent-oidc"
$GraphAppId = '00000003-0000-0000-c000-000000000000'
$Scopes = [ordered]@{
  'openid' = '37f7f235-527c-4136-accd-4a02d197296e'; 'profile' = '14dad69e-099b-42c9-810b-d002981feec1'
  'email' = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; 'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
}
function Send-Graph([string]$Method, [string]$Uri, $Body) {
  if ($null -eq $Body) { return Invoke-MgGraphRequest $Method $Uri }
  return Invoke-MgGraphRequest $Method $Uri -Body ($Body | ConvertTo-Json -Depth 10) -ContentType 'application/json'
}

Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'EventListener.ReadWrite.All', 'Domain.Read.All' -ContextScope Process -NoWelcome
try {
  $tenant = (Get-MgContext).TenantId
  $initial = (Send-Graph GET 'v1.0/domains' $null).value | Where-Object { $_.isInitial } | Select-Object -First 1
  if (-not $initial) { throw "Couldn't read this tenant's .onmicrosoft.com domain. Check you signed in to the External ID tenant." }
  $subdomain = $initial.id -replace '\.onmicrosoft\.com$', ''

  $access = @{ resourceAppId = $GraphAppId; resourceAccess = @($Scopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
  $body = @{ signInAudience = 'AzureADMyOrg'; web = @{ redirectUris = @($RedirectUri) }; requiredResourceAccess = @($access) }
  $found = (Send-Graph GET "v1.0/applications?`$filter=displayName eq '$DisplayName'" $null).value
  if ($found.Count -gt 1) { throw "More than one app is named '$DisplayName'. Delete the extras, then run this again." }
  if ($found.Count -eq 1) {
    $app = $found[0]; Send-Graph PATCH "v1.0/applications/$($app.id)" $body | Out-Null
    Write-Host "Reusing the existing app '$DisplayName' and making sure its settings are right."
  } else {
    $body.displayName = $DisplayName; $app = Send-Graph POST 'v1.0/applications' $body
    Write-Host "Created the app '$DisplayName'."
  }

  $sp = (Send-Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'" $null).value | Select-Object -First 1
  if (-not $sp) { $sp = Send-Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId } }
  $graphSp = (Send-Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'" $null).value | Select-Object -First 1
  $scopeText = ($Scopes.Keys -join ' ')
  $grant = (Send-Graph GET "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)' and consentType eq 'AllPrincipals' and resourceId eq '$($graphSp.id)'" $null).value | Select-Object -First 1
  if ($grant) { Send-Graph PATCH "v1.0/oauth2PermissionGrants/$($grant.id)" @{ scope = $scopeText } | Out-Null }
  else { Send-Graph POST 'v1.0/oauth2PermissionGrants' @{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = $scopeText } | Out-Null }
  Write-Host 'Granted admin consent for the sign-in scopes.'

  $signUpOff = @{ '@odata.type' = '#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp'; isSignUpAllowed = $false }
  $flow = (Send-Graph GET 'v1.0/identity/authenticationEventsFlows' $null).value | Where-Object { $_.displayName -eq $FlowName } | Select-Object -First 1
  if ($flow) {
    Send-Graph PATCH "v1.0/identity/authenticationEventsFlows/$($flow.id)" @{ '@odata.type' = '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow'; onInteractiveAuthFlowStart = $signUpOff } | Out-Null
    Write-Host "Reusing the user flow '$FlowName' and making sure sign-up is off."
  } else {
    $flow = Send-Graph POST 'v1.0/identity/authenticationEventsFlows' @{
      '@odata.type' = '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow'
      displayName = $FlowName
      onInteractiveAuthFlowStart = $signUpOff
      onAuthenticationMethodLoadStart = @{ '@odata.type' = '#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp'; identityProviders = @(@{ id = 'EmailOtpSignup-OAUTH' }) }
      onAttributeCollection = @{
        '@odata.type' = '#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp'
        attributes = @(@{ id = 'email'; displayName = 'Email Address'; description = 'Email address of the user'; userFlowAttributeType = 'builtIn'; dataType = 'string' })
        attributeCollectionPage = @{ views = @(@{ inputs = @(@{ attribute = 'email'; label = 'Email Address'; inputType = 'text'; hidden = $true; editable = $false; writeToDirectory = $true; required = $true }) }) }
      }
    }
    Write-Host "Created the user flow '$FlowName' with email one-time passcode sign-in and sign-up turned off."
  }
  $linked = (Send-Graph GET "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications" $null).value
  if (-not ($linked | Where-Object { $_.appId -eq $app.appId })) {
    Send-Graph POST "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications" @{ '@odata.type' = '#microsoft.graph.authenticationConditionApplication'; appId = $app.appId } | Out-Null
    Write-Host "Added the app to '$FlowName'."
  }

  $end = (Get-Date).ToUniversalTime().AddMonths(24).ToString('o')
  $pw = Send-Graph POST "v1.0/applications/$($app.id)/addPassword" @{ passwordCredential = @{ displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')"; endDateTime = $end } }
  if ($found.Count -eq 1) { Write-Host 'Added a new client secret. Older secrets were left alone; delete them once the new one works.' }

  Write-Host ''
  Write-Host 'Paste these into the Booster Rocket setup page now. The secret is shown only this once.'
  Write-Host "  Tenant subdomain: $subdomain"
  Write-Host "  Tenant ID:        $tenant"
  Write-Host "  Client ID:        $($app.appId)"
  Write-Host "  Client secret:    $($pw.secretText)"
  Write-Host "  Secret expires:   $(([datetime]$pw.endDateTime).ToUniversalTime().ToString('yyyy-MM-dd'))"
} finally {
  Disconnect-MgGraph | Out-Null
}
