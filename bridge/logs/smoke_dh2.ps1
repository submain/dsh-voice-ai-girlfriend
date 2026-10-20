$ErrorActionPreference = 'Stop'
$bridge = 'http://127.0.0.1:8765'

# 1. switch avatar to new material
$sw = @{ avatar = 'smile_avatar.mp4' }
$j = $sw | ConvertTo-Json
$p = [System.Text.Encoding]::UTF8.GetBytes($j)
$wc = New-Object System.Net.WebClient
$wc.Headers['Content-Type'] = 'application/json; charset=utf-8'
$resp = [System.Text.Encoding]::UTF8.GetString($wc.UploadData("$bridge/api/persona/set", 'POST', $p))
Write-Output ("SWITCH_RESP " + $resp)

# 2. submit speak task
$obj = @{ text = [char]0x4F60 + [char]0x597D + [char]0xFF0C + [char]0x6211 + [char]0x662F + [char]0x5C0F + [char]0x96C5 + [char]0xFF0C + [char]0x4ECA + [char]0x5929 + [char]0x5929 + [char]0x6C14 + [char]0x771F + [char]0x4E0D + [char]0x9519 + [char]0x3002 }
$json2 = $obj | ConvertTo-Json
$p2 = [System.Text.Encoding]::UTF8.GetBytes($json2)
$resp2 = [System.Text.Encoding]::UTF8.GetString($wc.UploadData("$bridge/api/dh/speak", 'POST', $p2))
Write-Output ("SPEAK_RESP " + $resp2)

# 3. poll
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Seconds 3
    $st = Invoke-RestMethod -Uri "$bridge/api/dh/status" -TimeoutSec 8
    Write-Output ("POLL " + $st.state + " done=" + $st.done_segments + "/" + $st.total_segments + " video=" + $st.video_file)
    if ($st.state -eq 'done' -or ($st.total_segments -gt 0 -and $st.done_segments -ge $st.total_segments)) { break }
}
