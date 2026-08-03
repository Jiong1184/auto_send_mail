# Auto-Check Script (Windows PowerShell) — runs Claude Code in headless mode to check for email replies.
# Designed to be invoked by Windows Task Scheduler every N minutes.
#
# Setup:
#   1. Ensure Claude Code CLI is installed and authenticated: claude setup-token
#   2. Enable via /card-followup main menu → "Enable auto-polling"
#   3. Create a scheduled task (see instructions at end of this file)
#
# Task Scheduler trigger example:
#   Trigger: Daily, Repeat every 5 minutes, Duration: Indefinitely
#   Action: Start a program → pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\auto_send_mail\scripts\auto-check.ps1"

param()

$ErrorActionPreference = "Stop"

$PROJECT_DIR = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DATA_DIR    = Join-Path $PROJECT_DIR "data"
$LOG_FILE    = Join-Path $DATA_DIR "auto-check.log"
$LOCK_FILE   = Join-Path $env:TEMP "auto-check-crm.lock"
$MAX_LOG_SIZE_MB = 50

# ── Ensure data directory exists ──────────────────────────────
if (-not (Test-Path $DATA_DIR)) {
    New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
}

# ── Mutex: prevent overlapping runs ────────────────────────────
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open($LOCK_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
catch {
    # Another instance is already running
    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ⏭ Previous check still running, skipping."
    Add-Content -Path $LOG_FILE -Value $msg
    Write-Host $msg
    exit 0
}

try {
    # ── Log rotation: keep max 50MB ──────────────────────────────
    if (Test-Path $LOG_FILE) {
        $logItem = Get-Item $LOG_FILE
        $logSizeMB = $logItem.Length / 1MB
        if ($logSizeMB -gt $MAX_LOG_SIZE_MB) {
            $lines = Get-Content $LOG_FILE -Tail 20000
            $lines | Set-Content $LOG_FILE
            $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 📜 Log rotated (was $([math]::Round($logSizeMB, 1))MB, exceeding ${MAX_LOG_SIZE_MB}MB limit)."
            Add-Content -Path $LOG_FILE -Value $msg
        }
    }

    # ── Environment ──────────────────────────────────────────────
    Set-Location $PROJECT_DIR
    $env:HOME = $env:USERPROFILE

    # ── Run Claude in headless mode ──────────────────────────────
    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 🔍 Starting auto-check..."
    Add-Content -Path $LOG_FILE -Value $msg

    claude -p "automatically check for replies and process them. If autoApproveDrafts is ON, send auto-replies immediately. If OFF, just record replies and classify intent." `
        --permission-mode auto `
        --output-format json `
        --max-budget-usd 2 `
        >> $LOG_FILE 2>&1

    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ✅ Auto-check complete."
    Add-Content -Path $LOG_FILE -Value $msg
}
catch {
    $msg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ❌ Auto-check failed: $_"
    Add-Content -Path $LOG_FILE -Value $msg
    Write-Host $msg
    exit 1
}
finally {
    # ── Release lock ─────────────────────────────────────────────
    if ($lockStream) {
        $lockStream.Close()
        $lockStream.Dispose()
    }
}

<#
.SYNOPSIS
Windows Task Scheduler setup instructions

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Method 1: PowerShell (recommended — run as Administrator)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$action = New-ScheduledTaskAction -Execute "pwsh.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PROJECT_DIR\scripts\auto-check.ps1`""

$trigger = New-ScheduledTaskTrigger -Daily -At "00:00" `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "CRM-Auto-Check" `
    -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description "Auto-check CRM email replies every 5 minutes"

# To remove: Unregister-ScheduledTask -TaskName "CRM-Auto-Check" -Confirm:$false

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Method 2: GUI (Task Scheduler)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open Task Scheduler (taskschd.msc)
2. Create Basic Task → Name: "CRM-Auto-Check"
3. Trigger: Daily → Start: today 00:00 → Repeat every: 5 minutes → Duration: Indefinitely
4. Action: Start a program
   - Program: pwsh.exe (or powershell.exe)
   - Arguments: -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\auto_send_mail\scripts\auto-check.ps1"
5. Finish

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#>
