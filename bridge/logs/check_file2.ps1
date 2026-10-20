$b = [System.IO.File]::ReadAllBytes('d:\supmain\dsh-voice-ai-girlfriend\runtime\models\silero-vad\silero_vad_v4.jit')
Write-Output ("SIZE " + $b.Length)
Write-Output ("HEAD " + [System.Text.Encoding]::ASCII.GetString($b[0..15]).Replace([char]10,' ').Replace([char]13,' '))
