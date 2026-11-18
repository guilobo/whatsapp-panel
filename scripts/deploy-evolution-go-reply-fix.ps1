param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$TargetHost,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')][string]$RemoteUser,
  [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $repo "deploy\evolution-go"
$remote = "${RemoteUser}@${TargetHost}"
$remoteDir = "~/evolution-go-deploy"

ssh -i $SshKey $remote "mkdir -p $remoteDir/reply-build && if test -e $remoteDir/docker-compose.override.yml && ! grep -q 'whatsapp-panel/evolution-go:0.7.3-reply1' $remoteDir/docker-compose.override.yml; then echo 'Refusing to overwrite an existing unrelated Compose override.' >&2; exit 2; fi"
if ($LASTEXITCODE -ne 0) { throw "Could not prepare the Evolution Go build directory." }

scp -i $SshKey (Join-Path $buildDir "Dockerfile") ("${remote}:" + $remoteDir + "/reply-build/Dockerfile")
if ($LASTEXITCODE -ne 0) { throw "Dockerfile upload failed." }
scp -i $SshKey (Join-Path $buildDir "evolution-go.patch") ("${remote}:" + $remoteDir + "/reply-build/evolution-go.patch")
if ($LASTEXITCODE -ne 0) { throw "Evolution Go patch upload failed." }
scp -i $SshKey (Join-Path $buildDir "docker-compose.override.yml") ("${remote}:" + $remoteDir + "/docker-compose.override.yml")
if ($LASTEXITCODE -ne 0) { throw "Compose override upload failed." }

ssh -i $SshKey $remote "cd $remoteDir && docker compose build evolution-go && docker compose up -d --no-deps evolution-go && for attempt in 1 2 3 4 5 6 7 8 9 10; do if docker inspect --format '{{.State.Status}}' evolution-go | grep -q '^running$' && curl -fsS http://127.0.0.1:8080/server/ok >/dev/null; then echo 'Evolution Go reply fix is running and healthy.'; exit 0; fi; sleep 3; done; docker inspect --format '{{.State.Status}}' evolution-go >&2; exit 1"
if ($LASTEXITCODE -ne 0) { throw "Evolution Go reply fix failed to build or become healthy." }
