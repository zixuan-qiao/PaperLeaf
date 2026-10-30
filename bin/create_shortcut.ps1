param(
    [string]$ShortcutName = "PaperLeaf.lnk",
    [string]$TargetPath = "",
    [string]$Arguments = "",
    [string]$WorkingDirectory = "",
    [string]$IconLocation = ""
)

$desk = ""
try {
    $reg = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" -ErrorAction SilentlyContinue
    if ($reg.Desktop) {
        $desk = [System.Environment]::ExpandEnvironmentVariables($reg.Desktop)
    }
} catch {}

if (-not $desk -or -not (Test-Path $desk)) {
    $desk = [Environment]::GetFolderPath("Desktop")
}

if (-not (Test-Path $desk)) {
    $desk = Join-Path $env:USERPROFILE "Desktop"
}

$shortcutFile = Join-Path $desk $ShortcutName

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutFile)
$sc.TargetPath = $TargetPath
if ($Arguments) { $sc.Arguments = $Arguments }
if ($WorkingDirectory) { $sc.WorkingDirectory = $WorkingDirectory }
if ($IconLocation) { $sc.IconLocation = $IconLocation }
$sc.Description = "PaperLeaf - 本地免配置学术工作台"
$sc.Save()

Write-Output "[OK] Shortcut created at: $shortcutFile"
