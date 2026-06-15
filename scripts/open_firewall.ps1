# LocalChat: allow inbound access from the office LAN through Windows Firewall.
# Usage: run PowerShell "as Administrator", then:
#   powershell -ExecutionPolicy Bypass -File scripts\open_firewall.ps1
# To use a different port:
#   powershell -ExecutionPolicy Bypass -File scripts\open_firewall.ps1 -Port 8777

param(
    [int]$Port = 8777
)

$ruleName = "LocalChat (TCP $Port)"

# Require administrator privileges (auto-elevate via UAC if needed)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting administrator privileges (a UAC prompt will appear)..." -ForegroundColor Yellow
    $argList = @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Port", $Port
    )
    try {
        Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList
    } catch {
        Write-Warning "Elevation was cancelled or failed. Re-run PowerShell as Administrator and try again."
    }
    exit
}

# Recreate the rule if it already exists
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# Allow only on office networks (Domain/Private), never on Public networks.
$params = @{
    DisplayName = $ruleName
    Direction   = "Inbound"
    Protocol    = "TCP"
    LocalPort   = $Port
    Action      = "Allow"
    Profile     = "Domain,Private"
}
New-NetFirewallRule @params | Out-Null

Write-Host "Firewall rule added: $ruleName (Domain/Private profiles)" -ForegroundColor Green
Write-Host "Colleagues on the same network can access these URLs:" -ForegroundColor Cyan

# Show this machine's physical LAN IPv4 addresses
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object {
        $line = "  https://{0}:{1}    ({2})" -f $_.IPAddress, $Port, $_.InterfaceAlias
        Write-Host $line
    }
