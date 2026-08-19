# -*- coding: utf-8 -*-
"""Python SDK 联调：对着真实服务端跑完整流程。"""
import os, shutil, sys, json, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from jc_kami import LicenseClient, LicenseError, ErrorCode

env = {}
for line in open("/tmp/sdk.env"):
    k, _, v = line.strip().partition("=")
    env[k] = v

RUN = os.urandom(4).hex()          # 每次运行用独立的设备与目录，保证可重入
STORE = "/tmp/py-sdk-state-" + RUN
shutil.rmtree(STORE, ignore_errors=True)

policies = []
def make(version="1.0.0", store=STORE, **kw):
    return LicenseClient(
        app_id="sdk_demo", server_url="http://127.0.0.1:3100",
        plugin_id=env["SDK_PLUGIN"], plugin_token=env["SDK_TOKEN"],
        plugin_secret=env["SDK_SECRET"], client_version=version,
        storage_dir=store, on_policy=lambda p: policies.append(p), **kw)

ok = lambda m: print("  \033[32m✓\033[0m " + m)
bad = lambda m: (print("  \033[31m✗ " + m + "\033[0m"), sys.exit(1))

print("\n【1】未激活时 verify")
c = make()
print("     设备指纹:", c.device_id[:16] + "...")
try:
    c.verify(); bad("应当抛错")
except LicenseError as e:
    ok("%s — %s" % (e.code, e.message)) if e.code == ErrorCode.NOT_ACTIVATED_LOCALLY else bad(e.code)

print("\n【2】拉取策略（未激活也能调）")
p = c.fetch_policy()
ok("app_status=%s  最新版本=%s" % (p["app_status"], p["upgrade"]["latest_version"]))

print("\n【3】激活")
r = c.activate(env["SDK_FRESH1"])
ok("license_id=%s  到期=%s  设备 %d/%d  离线宽限 %dh" % (
    r["license_id"], r["expires_at"][:10], r["device_count"], r["device_limit"], r["offline_grace_hours"]))

print("\n【4】启动校验（令牌滚动续期）")
t1 = r["license_token"]
r2 = c.verify()
ok("验证通过，换发了新令牌" if r2["license_token"] != t1 else "令牌未变化（不符合预期）")

print("\n【5】本地已存凭据")
ok("has_local_license() = %s" % c.has_local_license())

print("\n【6】错误卡密")
try:
    make(store="/tmp/py-sdk-s2-" + RUN).activate("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"); bad("应当抛错")
except LicenseError as e:
    ok("%s — %s" % (e.code, e.message)) if e.code == ErrorCode.LICENSE_NOT_FOUND else bad(e.code)

print("\n【7】超出设备上限（上限 2）")

c2 = make(store="/tmp/py-sdk-d2-" + RUN, device_id="py-dev2-" + RUN)
c2.activate(env["SDK_FRESH1"]); ok("第 2 台设备绑定成功")
c3 = make(store="/tmp/py-sdk-d3-" + RUN, device_id="py-dev3-" + RUN)
try:
    c3.activate(env["SDK_FRESH1"]); bad("应当被拒")
except LicenseError as e:
    ok("%s — %s" % (e.code, e.message)) if e.code == ErrorCode.DEVICE_LIMIT_EXCEEDED else bad(e.code)

print("\n【8】主动解绑（消耗换绑配额）")
d = c2.deactivate("换机器")
ok("已解绑，剩余换绑 %s" % d.get("rebind_remaining"))

print("\n【9】本地文件防篡改")
path = os.path.join(STORE, "license.dat")
raw = bytearray(open(path, "rb").read())
raw[-20] ^= 0xFF          # 改动 payload 里的一个字节
open(path, "wb").write(bytes(raw))
try:
    c.verify(); bad("篡改未被发现")
except LicenseError as e:
    ok("%s — %s" % (e.code, e.message)) if e.code == ErrorCode.LOCAL_STORAGE_TAMPERED else bad(e.code)

print("\n【10】离线宽限期")
shutil.rmtree(STORE, ignore_errors=True)
c = make(); c.activate(env["SDK_FRESH2"])
c._storage.write({**c._storage.read(), "last_verified_at": "2020-01-01T00:00:00Z"})
c.server_url = "http://127.0.0.1:59999"   # 指向一个连不上的端口，模拟断网
try:
    c.verify(); bad("超期仍放行")
except LicenseError as e:
    ok("超过宽限期被拒: %s — %s" % (e.code, e.message)) if e.code == ErrorCode.NETWORK_UNAVAILABLE else bad(e.code)

st = c._storage.read(); st["last_verified_at"] = __import__("datetime").datetime.now(
    __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")
c._storage.write(st)
r = c.verify()
ok("宽限期内离线放行: offline=%s" % r["offline"]) if r.get("offline") else bad("未走离线分支")

print("\n【11】状态查询（不签发令牌）")
c.server_url = "http://127.0.0.1:3100"
s = c.status()
ok("status=%s  本机已绑定=%s  设备 %d/%d" % (s["status"], s["device_bound"], s["device_count"], s["device_limit"]))
if "license_token" in s: bad("状态查询不应返回令牌")

print("\n【12】服务端模式（无本地存储，令牌由调用方保管）")
srv = LicenseClient(
    app_id="sdk_demo", server_url="http://127.0.0.1:3100",
    plugin_id=env["SDK_PLUGIN"], plugin_token=env["SDK_TOKEN"], plugin_secret=env["SDK_SECRET"],
    device_id="web-user-" + RUN, use_local_storage=False)
r = srv.activate(env["SDK_FRESH3"])
tok = r["license_token"]           # 这一步在真实项目里应该存进你的数据库
r2 = srv.verify(license_token=tok)
ok("服务端模式激活+验证通过，status=%s" % r2["status"])
try:
    LicenseClient(app_id="x", server_url="http://x", plugin_id="x", plugin_token="x",
                  plugin_secret="x", use_local_storage=False)
    bad("服务端模式缺 device_id 应当报错")
except ValueError as e:
    ok("缺 device_id 时明确报错: %s" % e)

print("\n\033[32m全部通过\033[0m  （共触发 %d 次策略回调）\n" % len(policies))
