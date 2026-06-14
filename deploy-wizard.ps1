#Requires -Version 5.1
<#
.SYNOPSIS
    Mooshtaba Bot Deployment Wizard
.DESCRIPTION
    Interactive wizard to deploy mooshtaba-bot to Cloudflare Workers.
    Handles: prerequisites check, secrets setup, D1 database, schema migration, deploy, webhook registration.
#>

param(
    [switch]$SkipPrereqs,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$WorkerName = "mooshtaba-bot-v2"

function Write-Header {
    Clear-Host
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║     Mooshtaba Bot Deployment Wizard      ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ┌─────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "  │  💡 Support us! Use our referral link when signing up  │" -ForegroundColor Yellow
    Write-Host "  │  🔗 https://ai.prox.us.ci/sign-up?aff=35Fw            │" -ForegroundColor Yellow
    Write-Host "  │  💬 Join our community: https://dc.hhhl.cc            │" -ForegroundColor Yellow
    Write-Host "  └─────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Step {
    param([int]$Num, [string]$Text)
    Write-Host "  [$Num] " -ForegroundColor Yellow -NoNewline
    Write-Host $Text
}

function Write-OK { param([string]$Msg) Write-Host "  ✓ $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  ⚠ $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "  ✗ $Msg" -ForegroundColor Red }

# ── Step 1: Prerequisites ──────────────────────────────────────────
function Test-Prerequisites {
    Write-Step 1 "Checking prerequisites..."
    $allGood = $true

    # Node.js
    try {
        $nodeVer = node --version 2>$null
        Write-OK "Node.js $nodeVer"
    } catch {
        Write-Fail "Node.js not found. Install from https://nodejs.org"
        $allGood = $false
    }

    # npm
    try {
        $npmVer = npm --version 2>$null
        Write-OK "npm $npmVer"
    } catch {
        Write-Fail "npm not found."
        $allGood = $false
    }

    # Wrangler
    try {
        $wranglerVer = npx wrangler --version 2>$null
        Write-OK "Wrangler $wranglerVer"
    } catch {
        Write-Warn "Wrangler not found globally. Installing..."
        npm install -g wrangler 2>$null
        Write-OK "Wrangler installed"
    }

    # Git
    try {
        $gitVer = git --version 2>$null
        Write-OK "Git installed"
    } catch {
        Write-Fail "Git not found. Install from https://git-scm.com"
        $allGood = $false
    }

    # Cloudflare login
    $whoami = npx wrangler whoami 2>&1
    if ($whoami -match "Logged in") {
        Write-OK "Cloudflare authenticated"
    } else {
        Write-Warn "Not logged in to Cloudflare. Running login..."
        npx wrangler login
    }

    return $allGood
}

# ── Step 2: Secrets ────────────────────────────────────────────────
function Set-Secrets {
    Write-Step 2 "Configuring secrets..."

    $secretsFile = ".dev.vars"
    $secrets = @{}

    if (Test-Path $secretsFile) {
        Get-Content $secretsFile | ForEach-Object {
            if ($_ -match "^(.+?)=(.*)$") {
                $secrets[$matches[1] = $matches[1].Trim()] = $matches[2].Trim()
            }
        }
    }

    # TELEGRAM_BOT_TOKEN
    if ($secrets["TELEGRAM_BOT_TOKEN"] -and $secrets["TELEGRAM_BOT_TOKEN"] -ne "your_bot_token_here") {
        Write-OK "TELEGRAM_BOT_TOKEN already set"
    } else {
        $token = Read-Host "  Enter TELEGRAM_BOT_TOKEN (from @BotFather)"
        if ($token) { $secrets["TELEGRAM_BOT_TOKEN"] = $token }
    }

    # TOKENROUTER_API_KEY
    if ($secrets["TOKENROUTER_API_KEY"] -and $secrets["TOKENROUTER_API_KEY"] -ne "your_api_key_here") {
        Write-OK "TOKENROUTER_API_KEY already set"
    } else {
        Write-Host ""
        Write-Host "  ┌─────────────────────────────────────────────────────────┐" -ForegroundColor Magenta
        Write-Host "  │  🚀 Get your API key from prox.us.ci                   │" -ForegroundColor Magenta
        Write-Host "  │  Sign up using our referral link to support the project │" -ForegroundColor Magenta
        Write-Host "  └─────────────────────────────────────────────────────────┘" -ForegroundColor Magenta
        Write-Host ""
        $openBrowser = Read-Host "  Open signup page in browser? (Y/n)"
        if ($openBrowser -ne "n") {
            Start-Process "https://ai.prox.us.ci/sign-up?aff=35Fw"
            Write-OK "Opened signup page in browser"
        }
        Write-Host ""
        $key = Read-Host "  Enter TOKENROUTER_API_KEY (from prox.us.ci)"
        if ($key) { $secrets["TOKENROUTER_API_KEY"] = $key }
    }

    # TELEGRAM_WEBHOOK_SECRET
    if ($secrets["TELEGRAM_WEBHOOK_SECRET"]) {
        Write-OK "TELEGRAM_WEBHOOK_SECRET already set"
    } else {
        $webhookSecret = -join ((1..32) | ForEach-Object { '{0:X}' -f (Get-Random -Max 16) })
        $secrets["TELEGRAM_WEBHOOK_SECRET"] = $webhookSecret
        Write-OK "Generated TELEGRAM_WEBHOOK_SECRET"
    }

    # SETUP_SECRET
    if ($secrets["SETUP_SECRET"]) {
        Write-OK "SETUP_SECRET already set"
    } else {
        $setupSecret = -join ((1..32) | ForEach-Object { '{0:X}' -f (Get-Random -Max 16) })
        $secrets["SETUP_SECRET"] = $setupSecret
        Write-OK "Generated SETUP_SECRET"
    }

    # Write .dev.vars
    $secrets.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content $secretsFile -Encoding UTF8
    Write-OK "Secrets saved to .dev.vars"

    # Set production secrets
    if (-not $DryRun) {
        Write-Host ""
        Write-Host "  Setting production secrets..." -ForegroundColor Gray
        foreach ($key in @("TELEGRAM_BOT_TOKEN", "TOKENROUTER_API_KEY", "TELEGRAM_WEBHOOK_SECRET", "SETUP_SECRET")) {
            if ($secrets[$key]) {
                $secrets[$key] | npx wrangler secret put $key 2>$null
                Write-OK "Production secret: $key"
            }
        }
    }
}

# ── Step 3: D1 Database ────────────────────────────────────────────
function Setup-D1 {
    Write-Step 3 "Setting up D1 database..."

    $tomlContent = Get-Content "wrangler.toml" -Raw

    if ($tomlContent -match 'database_id\s*=\s*"([^"]+)"') {
        Write-OK "D1 database already configured (ID: $($matches[1]))"
        $confirm = Read-Host "  Recreate database? (y/N)"
        if ($confirm -ne "y") { return }
    }

    Write-Host "  Creating D1 database..." -ForegroundColor Gray
    $output = npx wrangler d1 create mooshtaba-db 2>&1
    Write-Host $output

    if ($output -match 'database_id\s*=\s*"([^"]+)"') {
        $newId = $matches[1]
        $tomlContent = $tomlContent -replace 'database_id\s*=\s*"[^"]+"', "database_id = `"$newId`""
        $tomlContent | Set-Content "wrangler.toml" -Encoding UTF8
        Write-OK "Database created and wrangler.toml updated"
    } else {
        Write-Fail "Failed to create database"
        return
    }

    # Run schema
    Write-Host "  Running schema migration..." -ForegroundColor Gray
    npx wrangler d1 execute mooshtaba-db --file=src/db/schema.sql --remote
    Write-OK "Schema applied"
}

# ── Step 4: Deploy ─────────────────────────────────────────────────
function Deploy-Bot {
    Write-Step 4 "Deploying to Cloudflare Workers..."

    # Type check
    Write-Host "  Running type check..." -ForegroundColor Gray
    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Type check failed. Fix errors and try again."
        return $false
    }
    Write-OK "Type check passed"

    # Deploy
    Write-Host "  Deploying..." -ForegroundColor Gray
    npm run deploy
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Deploy failed."
        return $false
    }
    Write-OK "Deployed successfully"

    return $true
}

# ── Step 5: Register Webhook ───────────────────────────────────────
function Register-Webhook {
    Write-Step 5 "Registering Telegram webhook..."

    $setupSecret = ""
    if (Test-Path ".dev.vars") {
        Get-Content ".dev.vars" | ForEach-Object {
            if ($_ -match "^SETUP_SECRET=(.+)$") { $setupSecret = $matches[1] }
        }
    }

    if (-not $setupSecret) {
        Write-Fail "SETUP_SECRET not found. Run setup again."
        return
    }

    # Get worker URL from wrangler output or construct it
    $workerUrl = "https://mooshtaba-bot-v2.xlegenda443.workers.dev"
    Write-Host "  Registering webhook at $workerUrl..." -ForegroundColor Gray

    try {
        $response = Invoke-RestMethod -Uri "$workerUrl/setup" -Method POST -Headers @{"X-Setup-Secret"=$setupSecret} -ErrorAction Stop
        Write-OK "Webhook registered successfully"
    } catch {
        Write-Warn "Webhook registration may have failed: $($_.Exception.Message)"
        Write-Host "  You can register manually:" -ForegroundColor Gray
        Write-Host "  curl -X POST `"$workerUrl/setup`" -H `"X-Setup-Secret: $setupSecret`"" -ForegroundColor DarkGray
    }
}

# ── Main ───────────────────────────────────────────────────────────
Write-Header

if (-not $SkipPrereqs) {
    $ok = Test-Prerequisites
    if (-not $ok) {
        Write-Host ""
        Write-Fail "Prerequisites not met. Fix the issues above and try again."
        exit 1
    }
    Write-Host ""
}

Set-Secrets
Write-Host ""

Setup-D1
Write-Host ""

$deployed = Deploy-Bot
if (-not $deployed) { exit 1 }
Write-Host ""

Register-Webhook
Write-Host ""

# ── Summary ────────────────────────────────────────────────────────
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║          Deployment Complete!             ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────────────────┐" -ForegroundColor Magenta
Write-Host "  │  🎉 Thanks for deploying Mooshtaba Bot!                │" -ForegroundColor Magenta
Write-Host "  │  📢 Spread the word - share our referral link:         │" -ForegroundColor Magenta
Write-Host "  │  🔗 https://ai.prox.us.ci/sign-up?aff=35Fw            │" -ForegroundColor Magenta
Write-Host "  │  💬 Join our community for support & updates:          │" -ForegroundColor Magenta
Write-Host "  │  🔗 https://dc.hhhl.cc                                │" -ForegroundColor Magenta
Write-Host "  └─────────────────────────────────────────────────────────┘" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Bot URL:     https://mooshtaba-bot-v2.xlegenda443.workers.dev" -ForegroundColor Cyan
Write-Host "  Health:      https://mooshtaba-bot-v2.xlegenda443.workers.dev/health" -ForegroundColor Cyan
Write-Host "  Webhook Info: https://mooshtaba-bot-v2.xlegenda443.workers.dev/webhook-info" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Gray
Write-Host "    npm run tail         # Live logs" -ForegroundColor DarkGray
Write-Host "    npm run dev          # Local development" -ForegroundColor DarkGray
Write-Host "    npm run deploy       # Redeploy" -ForegroundColor DarkGray
Write-Host ""
