$ErrorActionPreference = 'Stop'
$bridge = 'http://127.0.0.1:8765'

$obj = @{ text = [char]0x4F60 + [char]0x597D + [char]0xFF0C + [char]0x6211 + [char]0x662F + [char]0x5C0F + [char]0x96C5 + [char]0xFF0C + [char]0x4ECA + [char]0x5929 + [char]0x5929 + [char]0x6C14 + [char]0x771F + [char]0x4E0D + [char]0x9519 + [char]0x3002 }
$json = $obj | ConvertTo-Json
$payload = [System.Text.Encoding]::UTF8.GetBytes($json)
Write-Output ("BODY " + $json)

try {
    $resp = Invoke-RestMethod -Uri "$bridge/api/dh/speak" -Method Post -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 15
    Write-Output ("SPEAK_RESP " + ($resp | ConvertTo-Json -Compress))
} catch {
    $body = ""
    try { $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $sr.ReadToEnd() } catch {}
    Write-Output ("SPEAK_ERR " + $body)
}

for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Seconds 3
    $st = Invoke-RestMethod -Uri "$bridge/api/dh/status" -TimeoutSec 8
    Write-Output ("POLL " + $st.state + " done=" + $st.done_segments + "/" + $st.total_segments + " video=" + $st.video_file)
    if ($st.state -eq 'done' -or ($st.total_segments -gt 0 -and $st.done_segments -ge $st.total_segments)) { break }
}
