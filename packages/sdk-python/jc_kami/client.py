"""卡密平台客户端。"""

import hashlib
import hmac
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from .device import resolve_device_id
from .errors import ErrorCode, LicenseError
from .storage import MemoryStorage, SecureStorage

_DEFAULT_TIMEOUT = 10.0
_DEFAULT_RETRIES = 2


class LicenseClient:
    """授权客户端。

    两种用法：

    **桌面模式**（默认）——自动生成本机设备指纹，凭据保存在本地文件::

        client = LicenseClient(
            app_id="my_tool", server_url="https://license.example.com",
            plugin_id="my_tool_default", plugin_token="pk_...", plugin_secret="sk_...",
        )
        client.activate("XXXXX-XXXXX-XXXXX-XXXXX-XXXXX")
        client.verify()

    **服务端模式**——网站后端代表终端用户调用，设备标识与令牌由调用方保管::

        client = LicenseClient(..., device_id=user_device, use_local_storage=False)
        result = client.activate(key)
        save_to_db(user_id, result["license_token"])
        client.verify(license_token=load_from_db(user_id))

    :param app_id: 应用标识，后台创建应用时确定
    :param server_url: 授权中心地址
    :param plugin_id: 接入端标识
    :param plugin_token: 接入端 Token
    :param plugin_secret: 签名密钥。服务端接入请放环境变量，不要下发给终端
    :param client_version: 当前客户端版本，用于版本策略判断
    :param channel: 升级通道，``stable`` 或 ``beta``
    :param device_id: 覆盖设备指纹。服务端模式必须显式提供
    :param device_name: 设备展示名，便于用户在后台辨认自己的机器
    :param storage_dir: 本地状态目录，默认 ``~/.jc-kami/<app_id>``
    :param use_local_storage: 是否使用本地文件保存凭据，服务端模式应设为 False
    :param timeout: 单次请求超时秒数
    :param max_retries: 可重试错误的最大重试次数
    :param on_policy: 每次拿到策略时的回调，用于展示公告、处理升级
    """

    def __init__(
        self,
        app_id,
        server_url,
        plugin_id,
        plugin_token,
        plugin_secret,
        client_version=None,
        channel="stable",
        device_id=None,
        device_name=None,
        storage_dir=None,
        use_local_storage=True,
        timeout=_DEFAULT_TIMEOUT,
        max_retries=_DEFAULT_RETRIES,
        on_policy=None,
    ):
        for name, value in (
            ("app_id", app_id), ("server_url", server_url), ("plugin_id", plugin_id),
            ("plugin_token", plugin_token), ("plugin_secret", plugin_secret),
        ):
            if not value:
                raise ValueError("%s 不能为空" % name)

        self.app_id = app_id
        self.server_url = server_url.rstrip("/")
        self.plugin_id = plugin_id
        self.plugin_token = plugin_token
        self.plugin_secret = plugin_secret
        self.client_version = client_version
        self.channel = channel
        self.device_name = device_name or socket.gethostname()
        self.timeout = timeout
        self.max_retries = max_retries
        self.on_policy = on_policy

        base_dir = storage_dir or os.path.join(
            os.path.expanduser("~"), ".jc-kami", app_id
        )
        if device_id:
            self.device_id = device_id
        elif use_local_storage:
            self.device_id = resolve_device_id(os.path.join(base_dir, "device.salt"))
        else:
            raise ValueError("服务端模式（use_local_storage=False）必须显式提供 device_id")

        self._storage = (
            SecureStorage(os.path.join(base_dir, "license.dat"), self.device_id)
            if use_local_storage
            else MemoryStorage()
        )

    # ------------------------------------------------------------------ 对外接口

    def activate(self, license_key, idempotency_key=None):
        """首次激活。成功后凭据保存到本地（桌面模式）。"""
        result = self._request(
            "POST",
            "/api/v1/license/activate",
            {
                "app_id": self.app_id,
                "license_key": license_key.strip(),
                "device_id": self.device_id,
                "device_name": self.device_name,
                "client_version": self.client_version,
                "channel": self.channel,
            },
            idempotency_key=idempotency_key,
        )
        self._persist(result)
        self._emit_policy(result.get("policy"))
        return result

    def verify(self, license_token=None):
        """启动校验，也是最常调用的方法。

        正常路径走在线验证；网络不通时，若距上次成功验证未超过服务端下发的离线宽限期，
        则本地放行并在结果里标记 ``offline=True``。超过宽限期一律拒绝——不会因为
        「可能只是网络问题」而放行。

        :param license_token: 服务端模式下由调用方传入；桌面模式留空，自动读本地
        """
        state = None
        if license_token is None:
            state = self._storage.read()
            if not state:
                raise LicenseError(
                    ErrorCode.NOT_ACTIVATED_LOCALLY, "尚未激活，请先输入卡密激活"
                )
            license_token = state["license_token"]

        try:
            result = self._request(
                "POST",
                "/api/v1/license/verify",
                {
                    "app_id": self.app_id,
                    "license_token": license_token,
                    "device_id": self.device_id,
                    "client_version": self.client_version,
                    "channel": self.channel,
                },
            )
        except LicenseError as exc:
            # 只有网络层失败才考虑宽限期。服务端明确拒绝（封禁、过期、关停）一律照办。
            if exc.code != ErrorCode.NETWORK_UNAVAILABLE or state is None:
                raise
            return self._fallback_offline(state)

        self._persist(result, license_id=(state or {}).get("license_id"))
        self._emit_policy(result.get("policy"))
        return result

    def deactivate(self, reason=None, license_token=None, idempotency_key=None):
        """主动解绑当前设备，也就是「换绑」。会消耗一次换绑配额。"""
        if license_token is None:
            state = self._storage.read()
            if not state:
                raise LicenseError(ErrorCode.NOT_ACTIVATED_LOCALLY, "本机尚未激活")
            license_token = state["license_token"]

        result = self._request(
            "POST",
            "/api/v1/license/deactivate",
            {
                "app_id": self.app_id,
                "license_token": license_token,
                "device_id": self.device_id,
                "reason": reason,
            },
            idempotency_key=idempotency_key,
        )
        self._storage.clear()
        return result

    def status(self, license_key=None, license_id=None):
        """查询授权状态。只读，不签发令牌，也不影响本地状态。"""
        params = {"app_id": self.app_id, "device_id": self.device_id}
        if license_key:
            params["license_key"] = license_key.strip()
        elif license_id:
            params["license_id"] = license_id
        else:
            state = self._storage.read()
            if not state:
                raise LicenseError(
                    ErrorCode.NOT_ACTIVATED_LOCALLY, "需要提供卡密或先完成激活"
                )
            params["license_id"] = state["license_id"]
        return self._request("GET", "/api/v1/license/status", params=params)

    def fetch_policy(self, client_version=None):
        """拉取远程管控策略。未激活时也能调用。"""
        params = {"app_id": self.app_id, "device_id": self.device_id}
        version = client_version or self.client_version
        if version:
            params["client_version"] = version
        if self.channel:
            params["channel"] = self.channel
        result = self._request("GET", "/api/v1/license/policy", params=params)
        policy = result.get("policy")
        self._emit_policy(policy)
        return policy

    def check_update(self, current_version=None):
        """问一句「有没有新版本」，返回可直接交给 Updater 的 UpdatePlan。

        注意这一步只是拿到描述，真正装不装、什么时候装由调用方决定；
        Updater.apply 会在安装前重新验签，不会因为这里说有新版就无条件信任。
        """
        from .updater import UpdatePlan

        policy = self.fetch_policy(client_version=current_version) or {}
        return UpdatePlan(self.app_id, policy.get("upgrade"))

    def has_local_license(self):
        """本地是否存有激活凭据。只是个快速判断，不代表授权仍然有效。"""
        try:
            return self._storage.read() is not None
        except LicenseError:
            return False

    def clear_local(self):
        """清除本地凭据，不通知服务端。"""
        self._storage.clear()

    # ------------------------------------------------------------------ 内部

    def _emit_policy(self, policy):
        if policy and self.on_policy:
            self.on_policy(policy)

    def _persist(self, result, license_id=None):
        self._storage.write(
            {
                "license_id": result.get("license_id") or license_id,
                "license_token": result["license_token"],
                "token_expires_at": result.get("token_expires_at"),
                "expires_at": result.get("expires_at"),
                "offline_grace_hours": result.get("offline_grace_hours", 0),
                "last_verified_at": _now_iso(),
                "device_id": self.device_id,
                "app_id": self.app_id,
            }
        )

    def _fallback_offline(self, state):
        grace_hours = state.get("offline_grace_hours") or 0
        if grace_hours <= 0:
            raise LicenseError(
                ErrorCode.NETWORK_UNAVAILABLE,
                "当前授权要求必须联网验证，请检查网络连接",
            )

        elapsed = time.time() - _parse_iso(state["last_verified_at"])
        if elapsed > grace_hours * 3600 or elapsed < 0:
            raise LicenseError(
                ErrorCode.NETWORK_UNAVAILABLE,
                "已离线 %d 小时，超过 %d 小时宽限期，请联网后重试"
                % (round(elapsed / 3600), grace_hours),
            )

        # 宽限期不能给已到期的授权续命
        expires_at = state.get("expires_at")
        if expires_at and _parse_iso(expires_at) <= time.time():
            raise LicenseError(ErrorCode.LICENSE_EXPIRED, "授权已到期")

        return {
            "success": True,
            "offline": True,
            "license_id": state["license_id"],
            "status": "active",
            "expires_at": expires_at,
            "is_permanent": expires_at is None,
            "offline_grace_hours": grace_hours,
            "license_token": state["license_token"],
            "token_expires_at": state.get("token_expires_at"),
            "policy": None,
        }

    def _sign(self, method, url_path, body):
        """按 DEVELOPMENT.md 8.7 组装签名。"""
        timestamp = str(int(time.time()))
        nonce = str(uuid.uuid4())
        body_hash = hashlib.sha256(body).hexdigest()
        payload = "\n".join([method.upper(), url_path, timestamp, nonce, body_hash])
        signature = hmac.new(
            self.plugin_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return timestamp, nonce, signature

    def _request(self, method, path, body=None, params=None, idempotency_key=None):
        url_path = path
        if params:
            # 去掉 None，并保证查询串顺序稳定：签名算的就是这个字符串
            clean = {k: v for k, v in params.items() if v is not None}
            url_path = path + "?" + urllib.parse.urlencode(clean)

        payload = (
            json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if body is not None
            else b""
        )

        last_error = None
        for attempt in range(self.max_retries + 1):
            # 每次重试都重新签名：时间戳和 nonce 必须是新的，否则会被判定重放
            timestamp, nonce, signature = self._sign(method, url_path, payload)
            headers = {
                "Authorization": "Bearer " + self.plugin_token,
                "X-Plugin-Id": self.plugin_id,
                "X-Timestamp": timestamp,
                "X-Nonce": nonce,
                "X-Signature": signature,
            }
            if payload:
                headers["Content-Type"] = "application/json"
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key

            request = urllib.request.Request(
                self.server_url + url_path,
                data=payload if payload else None,
                headers=headers,
                method=method.upper(),
            )

            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as exc:
                error = _http_error(exc)
                if not error.retryable or attempt == self.max_retries:
                    raise error
                last_error = error
            except Exception as exc:
                # DNS、连接被拒、超时统一归为网络不可用，交给离线宽限期处理
                error = LicenseError(
                    ErrorCode.NETWORK_UNAVAILABLE, "无法连接授权服务器: %s" % exc
                )
                if attempt == self.max_retries:
                    raise error
                last_error = error

            _backoff(attempt, last_error)

        raise last_error or LicenseError(ErrorCode.INTERNAL_ERROR, "请求失败")


def _http_error(exc):
    try:
        data = json.loads(exc.read().decode("utf-8") or "{}")
    except Exception:
        data = {}
    return LicenseError(
        data.get("code") or ErrorCode.INTERNAL_ERROR,
        data.get("message") or ("请求失败（HTTP %s）" % exc.code),
        http_status=exc.code,
        request_id=data.get("request_id"),
        details=data.get("details"),
    )


def _backoff(attempt, error):
    # 限流错误优先听服务端的 retry_after，其余用指数退避
    retry_after = (error.details or {}).get("retry_after") if error else None
    delay = min(float(retry_after), 30.0) if retry_after else 0.5 * (2 ** attempt)
    time.sleep(delay)


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value):
    """把 ISO 8601 字符串转成 Unix 秒。兼容 Python 3.8 不认 'Z' 后缀的问题。"""
    text = value.replace("Z", "+00:00")
    return datetime.fromisoformat(text).timestamp()
