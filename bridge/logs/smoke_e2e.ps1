$ErrorActionPreference = 'Stop'
$bridge = 'http://127.0.0.1:8765'

# 1. TTS: text -> wav bytes (CosyVoice remote)
$text = [char]0x4F60 + [char]0x597D + [char]0xFF0C + [char]0x6211 + [char]0x662F + [char]0x5C0F + [char]0x96C5
$obj = @{ text = $text }
$json = $obj | ConvertTo-Json
$payload = [System.Text.Encoding]::UTF8.GetBytes($json)
$send = New-Object System.Net.WebClient
$send.Headers['Content-Type'] = 'application/json; charset=utf-8'
$wav = $send.UploadData("$bridge/api/tts", 'POST', $payload)
$wavPath = Join-Path $PSScriptRoot '_smoke_tts.wav'
[System.IO.File]::WriteAllBytes($wavPath, $wav)
Write-Output ("TTS_OK bytes=" + $wav.Length)

# 2. STT: wav -> text (remote sh_asr_service)
$sttClient = New-Object System.Net.WebClient
$sttClient.Headers['Content-Type'] = 'audio/wav'
$audioBytes = [System.IO.File]::ReadAllBytes($wavPath)
$resp = [System.Text.Encoding]::UTF8.GetString($sttClient.UploadData("$bridge/api/stt", 'POST', $audioBytes))
Write-Output ("STT_RESP " + $resp)
