"""Bounded read-only HTTP diagnosis. Credentials and response bodies stay private."""
import json
import os
from pathlib import Path
import time
from urllib.request import getproxies
from curl_cffi import requests

try:
    directory = Path(os.environ.get("WEBGPT_HOME") or Path(os.environ["LOCALAPPDATA"]) / "webgpt-api")
    credential = json.loads((directory / "session.json").read_text(encoding="utf-8"))
    proxy = getproxies().get("https") or getproxies().get("http")
    with requests.Session(impersonate="chrome", proxy=proxy, timeout=20) as session:
        for cookie in credential.get("cookies", []):
            if cookie.get("domain") in ("chatgpt.com", ".chatgpt.com"):
                session.cookies.set(cookie["name"], cookie["value"], domain=cookie["domain"], path=cookie.get("path", "/"))
        start = time.monotonic()
        response = session.get("https://chatgpt.com/backend-api/models", headers={
            "authorization": "Bearer " + credential.get("accessToken", ""),
            "accept": "application/json", "referer": "https://chatgpt.com/",
        }, allow_redirects=False)
        count = None
        if response.status_code == 200:
            body = response.json()
            count = len(body.get("models", []))
        print(json.dumps({"status": response.status_code, "model_count": count,
                          "system_proxy_used": bool(proxy), "elapsed_ms": round((time.monotonic() - start) * 1000)}))
except Exception as error:
    print(json.dumps({"diagnostic_failed": type(error).__name__}))
    raise SystemExit(1)
