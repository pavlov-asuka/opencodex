@echo off
setlocal
rem Leave OpenCodex without needing OpenCodex.
rem
rem The dashboard has the same button, but it is served by the gateway — and
rem the case that matters most is the one where the gateway or the bridge is
rem what broke. This touches only the two things that make Codex Desktop route
rem through this project, and needs nothing of ours to be running.
rem
rem Your providers, API keys and model list are NOT touched. Start
rem OpenCodex.exe again and everything comes back.

echo.
echo   Restoring native Codex
echo   =====================
echo.

echo   [1/4] Stopping the OpenCodex gateway (if it is running)...
schtasks /End /TN "OpenCodex Gateway" >nul 2>nul
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dist\server.js*' -and $_.CommandLine -like '*OpenCodex*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

echo   [2/4] Removing the bridge registration from HKCU\Environment...
rem This is the decisive one: while CODEX_CLI_PATH points at the bridge, Codex
rem Desktop launches it no matter what the config file says.
for %%V in (CODEX_CLI_PATH OPENCODEX_NATIVE_CODEX_PATH OPENCODEX_PROVIDER_BRIDGE_PATH OPENCODEX_PROVIDER_SPLIT OPENCODEX_GATEWAY_PORT OPENCODEX_NATIVE_EGRESS) do (
  reg delete "HKCU\Environment" /F /V %%V >nul 2>nul
)
rem Tell running processes the environment changed, so a newly launched Codex
rem does not inherit the old values from an unrefreshed session.
powershell -NoProfile -Command ^
  "$sig='[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; $t=Add-Type -MemberDefinition $sig -Name Env -Namespace Win32 -PassThru; $r=[UIntPtr]::Zero; [void]$t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)" >nul 2>nul

echo   [3/4] Removing the managed block from config.toml...
powershell -NoProfile -Command ^
  "$p = Join-Path $env:USERPROFILE '.codex\config.toml';" ^
  "if (Test-Path $p) {" ^
  "  $c = Get-Content $p -Raw;" ^
  "  $c = [regex]::Replace($c, '(?s)# >>> opencodex managed >>>.*?# <<< opencodex managed (?:>>>|<<<)\r?\n?', '');" ^
  "  $c = [regex]::Replace($c, '(?m)^\s*model_catalog_json\s*=.*$\r?\n?', '');" ^
  "  Set-Content -Path $p -Value ($c.Trim() + \"`n\") -NoNewline;" ^
  "  Write-Host '        config.toml cleaned.'" ^
  "} else { Write-Host '        config.toml not found; nothing to clean.' }"

echo   [4/4] Restarting Codex Desktop...
powershell -NoProfile -Command ^
  "Get-Process -Name 'Codex','ChatGPT' -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>nul
timeout /t 2 /nobreak >nul
start "" "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App" 2>nul

echo.
echo   Done. Codex is running natively again.
echo.
echo   Your providers, API keys and models are untouched — they live in
echo   %%USERPROFILE%%\.opencodex and are picked up again the next time you
echo   start OpenCodex.exe.
echo.
pause
