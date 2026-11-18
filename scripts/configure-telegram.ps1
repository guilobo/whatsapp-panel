param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$TargetHost,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')][string]$RemoteUser,
  [Parameter(Mandatory = $true)][string]$BotTokenFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^-?\d+$')][string]$ChatId,
  [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519"
)
$ErrorActionPreference = "Stop"
$botFile = (Resolve-Path -LiteralPath $BotTokenFile).Path
$rawTokenFile = [System.IO.File]::ReadAllText($botFile).Trim()
$tokens = [regex]::Matches($rawTokenFile, '\d{7,12}:[A-Za-z0-9_-]{30,}')
if ($tokens.Count -ne 1) {
  throw "The bot-token file must contain exactly one Telegram token."
}
$token = $tokens[0].Value
$remote = "${RemoteUser}@${TargetHost}"
$remoteScript = @'
set -euo pipefail
IFS= read -r token
IFS= read -r chat
token="$(printf '%s' "$token" | tr -cd 'A-Za-z0-9_:-')"
chat="$(printf '%s' "$chat" | tr -cd '0-9-')"
if [[ ! "$token" =~ ^[0-9]{7,12}:[A-Za-z0-9_-]{30,}$ ]]; then
  printf 'Telegram token input rejected (length %s).\n' "${#token}" >&2
  exit 20
fi
if [[ ! "$chat" =~ ^-?[0-9]+$ ]]; then
  printf 'Telegram chat ID input rejected.\n' >&2
  exit 21
fi
root="$HOME/whatsapp-panel"
env_file="$root/.runtime.env"
if [[ ! -f "$env_file" ]]; then echo 'Panel runtime environment file is missing.' >&2; exit 22; fi
tmp="$(mktemp "$root/.runtime.env.telegram.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk '!/^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=/' "$env_file" > "$tmp"
printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$token" "$chat" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT
docker compose --project-directory "$root" -f "$root/compose.yaml" up -d --force-recreate panel
'@
$script64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = 'eval "$(printf %s ' + $script64 + ' | base64 -d)"'
$sshCommand = Get-Command ssh -ErrorAction Stop
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $sshCommand.Source
$start.ArgumentList.Add("-T")
$start.ArgumentList.Add("-i")
$start.ArgumentList.Add($SshKey)
$start.ArgumentList.Add($remote)
$start.ArgumentList.Add($remoteCommand)
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.UseShellExecute = $false
$start.StandardInputEncoding = [Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $start
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.StandardInput.NewLine = "`n"
$process.StandardInput.WriteLine($token)
$process.StandardInput.WriteLine($ChatId)
$process.StandardInput.Close()
$process.WaitForExit()
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
if ($process.ExitCode -ne 0) {
  throw "Remote Telegram configuration failed (exit $($process.ExitCode)): $stderr"
}
if ($stdout) { Write-Output $stdout.Trim() }
Write-Output "Telegram credentials installed; the panel container was recreated."
