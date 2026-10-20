$ErrorActionPreference = 'Stop'
$wc = New-Object System.Net.WebClient
$bytes = $wc.UploadFile('http://127.0.0.1:9090/asr', 'd:\supmain\dsh-voice-ai-girlfriend\人物专属克隆音色.wav')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
[System.IO.File]::WriteAllText('d:\supmain\dsh-voice-ai-girlfriend\bridge\logs\ref_asr.json', $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'SAVED'
