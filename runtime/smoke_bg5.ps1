$ErrorActionPreference = 'Stop'
$bridge = 'http://127.0.0.1:8765'

$obj = @{ text = [char]0x4F60 + [char]0x597D + [char]0xFF0C + [char]0x6211 + [char]0x662F + [char]0x5C0F + [char]0x96C5 + [char]0x3002 }
$p2 = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json))
try {
    $r = Invoke-RestMethod -Uri "$bridge/api/dh/speak" -Method Post -ContentType 'application/json; charset=utf-8' -Body $p2 -TimeoutSec 20
    Write-Output ("SPEAK " + ($r | ConvertTo-Json -Compress))
} catch {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output ("SPEAK_ERR " + $sr.ReadToEnd())
}

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    $st = Invoke-RestMethod -Uri "$bridge/api/dh/status" -TimeoutSec 8
    Write-Output ("POLL " + $st.state + " " + $st.done_segments + "/" + $st.total_segments + " " + $st.video_file)
    if ($st.state -eq 'done' -or ($st.total_segments -gt 0 -and $st.done_segments -ge $st.total_segments)) { break }
}
