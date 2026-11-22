"""最小阿里云 RPC 客户端：支持自定义 endpoint 与 API Version。

只依赖标准库。凭据只从环境变量读取，不落盘、不进日志。
签名算法与 aliyun-ecs-one-liner 技能一致（RPC 风格 V1，HMAC-SHA1）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

AK_ID = "ALIBABA_CLOUD_ACCESS_KEY_ID"
AK_SECRET = "ALIBABA_CLOUD_ACCESS_KEY_SECRET"

ENDPOINTS = {
    "ecs": ("https://ecs.aliyuncs.com/", "2014-05-26"),
    "vpc": ("https://vpc.aliyuncs.com/", "2016-04-28"),
}


class ApiError(RuntimeError):
    def __init__(self, code, message, request_id="", http_status=0):
        self.code, self.message = code, message
        self.request_id, self.http_status = request_id, http_status
        super().__init__(f"[{code}] {message} (RequestId={request_id})")


def _pct(v):
    return quote(str(v), safe="-_.~")


def call(action, params=None, svc="ecs", region="cn-hongkong", timeout=30):
    ak_id = os.environ.get(AK_ID, "").strip()
    ak_secret = os.environ.get(AK_SECRET, "").strip()
    if not ak_id or not ak_secret:
        raise RuntimeError(f"缺少环境变量 {AK_ID} / {AK_SECRET}")

    endpoint, version = ENDPOINTS[svc]
    p = dict(params or {})
    p.setdefault("RegionId", region)
    p.update({
        "Action": action, "Format": "JSON", "Version": version,
        "AccessKeyId": ak_id, "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": uuid.uuid4().hex,
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    canonical = "&".join(f"{_pct(k)}={_pct(p[k])}" for k in sorted(p))
    string_to_sign = "GET&%2F&" + _pct(canonical)
    sig = base64.b64encode(
        hmac.new((ak_secret + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    p["Signature"] = sig
    url = endpoint + "?" + "&".join(f"{_pct(k)}={_pct(p[k])}" for k in sorted(p))

    try:
        req = Request(url, method="GET", headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            status = resp.status
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        status = exc.code
    except (URLError, OSError, TimeoutError) as exc:
        raise RuntimeError(f"网络失败 {action}: {type(exc).__name__}") from None

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        payload = {"Code": "InvalidResponse", "Message": body[:200]}
    if status >= 400 or "Code" in payload:
        raise ApiError(payload.get("Code", f"HTTP{status}"),
                       payload.get("Message", "?"), payload.get("RequestId", ""), status)
    return payload
