param(
  [Parameter(Mandatory = $true)][string]$BotTokenFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^-?\d+$')][string]$ChatId
)
$ErrorActionPreference = "Stop"
$rawTokenFile = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $BotTokenFile).Path).Trim()
$tokens = [regex]::Matches($rawTokenFile, '\d{7,12}:[A-Za-z0-9_-]{30,}')
if ($tokens.Count -ne 1) {
  throw "The bot-token file must contain exactly one Telegram token."
}
$token = $tokens[0].Value
$uri = "https://api.telegram.org/bot$token/sendMessage"
$body = @{
  chat_id = $ChatId
  text = "📨 TESTE DO WHATSAPP PANEL`n👤 Pessoa: Contato de teste`n📱 Telefone: não disponível`n💬 Mensagem: aviso de teste do bot Telegram."
} | ConvertTo-Json -Compress
$client = [System.Net.Http.HttpClient]::new()
try {
  $content = [System.Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, "application/json")
  $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
  $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
  if (-not $response.IsSuccessStatusCode -or -not $result.ok) {
    throw "Telegram rejected the test message (HTTP $([int]$response.StatusCode)). Verify that the bot is in the group and can send messages."
  }
  Write-Output "Synthetic Telegram test message sent successfully."
} catch {
  if ($_.Exception.Message -like 'Telegram rejected*') { throw $_ }
  throw "Could not reach the Telegram Bot API; the token and request were not printed."
} finally {
  $client.Dispose()
}
