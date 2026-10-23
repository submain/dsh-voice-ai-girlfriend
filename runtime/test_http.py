# -*- coding: utf-8 -*-
"""探测 dsh web 在宿主上的可达性（带 token + cookie jar，模拟浏览器）"""
import http.cookiejar
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3080"
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

for path in ("/", f"/?token={TOKEN}"):
    url = BASE + path
    try:
        with opener.open(url, timeout=10) as r:
            body = r.read()
            print(f"OK   {path[:28]:28s} status={r.status} bytes={len(body)}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {path[:28]:28s} status={e.code}")
    except Exception as e:  # noqa: BLE001
        print(f"ERR  {path[:28]:28s} {type(e).__name__}: {e}")

print("cookies:", [c.name for c in jar])
