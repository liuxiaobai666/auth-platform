# jc-kami-sdk (Python)

卡密平台 Python 客户端 SDK。**零依赖**，只用标准库，Python 3.8+。

## 安装

```bash
pip install ./packages/sdk-python
```

或直接把 `jc_kami/` 目录拷进你的项目——它不依赖任何第三方包。

## 桌面应用

自动生成本机设备指纹，凭据保存在本地文件。

```python
from jc_kami import LicenseClient, LicenseError, ErrorCode

client = LicenseClient(
    app_id="my_tool",
    server_url="https://license.example.com",
    plugin_id="my_tool_default",
    plugin_token="pk_...",
    plugin_secret="sk_...",
    client_version="1.0.0",
    on_policy=lambda p: handle_policy(p),   # 处理公告与升级提示
)

# 首次激活
client.activate("XXXXX-XXXXX-XXXXX-XXXXX-XXXXX")

# 每次启动校验
try:
    result = client.verify()
    if result["policy"] and result["policy"]["upgrade"]["required"]:
        show_upgrade_dialog(result["policy"]["upgrade"])
        raise SystemExit(1)
    start_app()
except LicenseError as e:
    if e.code == ErrorCode.NOT_ACTIVATED_LOCALLY:
        show_activation_dialog()
    else:
        show_error(f"[{e.code}] {e.message}")
```

## 服务端（Django / Flask / FastAPI）

网站后端代表终端用户调用。不生成机器指纹，也不写本地文件——设备标识和令牌都由你保管。

```python
client = LicenseClient(
    app_id="my_site",
    server_url="https://license.example.com",
    plugin_id=os.environ["JC_PLUGIN_ID"],
    plugin_token=os.environ["JC_PLUGIN_TOKEN"],
    plugin_secret=os.environ["JC_PLUGIN_SECRET"],
    device_id=f"user-{user.id}",      # 必须显式提供，且要稳定
    use_local_storage=False,
)

result = client.activate(license_key)
db.save_token(user.id, result["license_token"])       # 存进你自己的库

result = client.verify(license_token=db.load_token(user.id))
db.save_token(user.id, result["license_token"])       # 令牌会滚动续期，记得覆盖
```

## 方法

| 方法 | 说明 |
| --- | --- |
| `activate(license_key, idempotency_key=None)` | 首次激活 |
| `verify(license_token=None)` | 启动校验。桌面模式留空自动读本地；网络不通时按宽限期本地放行，结果里 `offline=True` |
| `deactivate(reason=None, license_token=None)` | 解绑本机，消耗一次换绑配额 |
| `status(license_key=None, license_id=None)` | 查询状态，不签发令牌 |
| `fetch_policy()` | 拉取远程管控策略，未激活时也可调用 |
| `has_local_license()` / `clear_local()` | 本地凭据的判断与清除 |

## 错误处理

判断分支只能依赖 `e.code`，不要匹配 `e.message`——文案会改，错误码不会。

```python
try:
    client.verify()
except LicenseError as e:
    if e.code == ErrorCode.LICENSE_EXPIRED:        show_renew_page()
    elif e.code == ErrorCode.DEVICE_LIMIT_EXCEEDED: show_unbind_hint()
    elif e.code == ErrorCode.APP_KILLED:            show_message(e.message)
    elif e.retryable:                               retry_later()
    else:                                           show_error(e)
    # e.request_id 可用于向服务方报障
```

## 本地存储说明

桌面模式在 `~/.jc-kami/<app_id>/`（可用 `storage_dir` 覆盖）保存两个文件：

- `device.salt` —— 设备指纹的随机盐。删掉它等同于换了台机器，需要重新激活或换绑。
- `license.dat` —— 授权状态，用 HMAC-SHA256 做**完整性保护**。

注意这里做的是**防篡改，不是加密**。标准库没有 AES，为了保持零依赖，这里选择了
HMAC 完整性保护：任何手工改动（比如把「上次验证时间」往前挪来骗过离线宽限期）都会
在读取时被发现并抛 `LOCAL_STORAGE_TAMPERED`。

文件里没有卡密明文，只有一枚绑定本机设备指纹的短期令牌，拷到别的机器上服务端也不认。
所以这里的主要矛盾是完整性而不是保密性。真正的授权判断始终在服务端。

## 关于 plugin_secret

签名密钥打包进桌面程序（PyInstaller 等）后可被提取，这是客户端软件授权的固有限制。
服务端接入请把密钥放环境变量里，不要下发给终端。详见 [接入指南](../../docs/INTEGRATION.md)。
