# -*- coding: utf-8 -*-
"""向远端 CosyVoice 注册克隆音色（stdlib multipart，避免 shell 特殊字符转义问题）"""
import json
import sys
import urllib.request
import uuid

BASE = "http://192.168.2.218:8300"
WAV = r"d:\supmain\dsh-voice-ai-girlfriend\人物专属克隆音色.wav"
PROMPT_TEXT = (
    "<|endofprompt|>晚上好，谢谢你来看我。有人问我为什么喜欢这条酒红色的裙子，"
    "我说因为红色会让人想起很多温柔的事，比如晚霞，比如炉火，"
    "比如一个愿意听我说话的你。今天的风很轻，我很高兴能遇见你。"
)
NAME = "xiaoya_clone"

boundary = "----bridge" + uuid.uuid4().hex


def field(name: str, value: str) -> bytes:
    return (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
    ).encode("utf-8") + value.encode("utf-8") + b"\r\n"


with open(WAV, "rb") as f:
    wav_bytes = f.read()

body = b""
body += field("prompt_text", PROMPT_TEXT)
body += field("name", NAME)
body += (
    f'--{boundary}\r\nContent-Disposition: form-data; name="prompt_wav"; '
    f'filename="{NAME}.wav"\r\nContent-Type: audio/wav\r\n\r\n'
).encode("utf-8") + wav_bytes + b"\r\n"
body += f"--{boundary}--\r\n".encode("utf-8")

req = urllib.request.Request(
    f"{BASE}/v1/voice/register",
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as resp:
    result = json.loads(resp.read().decode("utf-8"))

print(json.dumps(result, ensure_ascii=False))
