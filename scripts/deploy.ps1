param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$TargetHost,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')][string]$RemoteUser,
  [Parameter(Mandatory = $true)][string]$PublicUrl,
  [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519"
)
$ErrorActionPreference = "Stop"
$parsedUrl = $null
if (-not [uri]::TryCreate($PublicUrl, [System.UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.Scheme -ne "https" -or $parsedUrl.UserInfo -or $parsedUrl.Query -or $parsedUrl.Fragment -or $parsedUrl.AbsolutePath -ne "/") {
  throw "PublicUrl must be an HTTPS origin, for example https://panel.example.com."
}
$safePublicUrl = "https://$($parsedUrl.Authority)"
$remote = "${RemoteUser}@${TargetHost}"
$repo = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP ("whatsapp-panel-" + [guid]::NewGuid().ToString("N") + ".tar")
if (-not (Test-Path (Join-Path $repo ".git"))) { throw "Initialize Git and commit the project before deploying." }
git -C $repo archive --format=tar -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
try {
  scp -i $SshKey $archive ("${remote}:/tmp/whatsapp-panel.tar")
  if ($LASTEXITCODE -ne 0) { throw "SCP failed." }
  $remoteCommand = "mkdir -p ~/whatsapp-panel && tar -xf /tmp/whatsapp-panel.tar -C ~/whatsapp-panel && rm /tmp/whatsapp-panel.tar && cd ~/whatsapp-panel && PUBLIC_URL='$safePublicUrl' bash scripts/prepare-server.sh && docker compose up -d --build"
  ssh -i $SshKey $remote $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw "Remote compose deployment failed." }
}
finally { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
