# XKWController 接入改造方案

**目标项目**：`/Volumes/Data/zxxk-0817`（Python + pywebview，PyInstaller onefile）
**目标**：让远程管控真正生效 + 接入远程自动更新（版本目录切换方案）

> **分工**：卡密平台侧（jc-kami）无需任何改动，能力已就绪。本方案只改 XKWController 项目。

---

## 0. 现状体检（改之前先理解这三点）

### ① 授权已接通，但远程管控是摆设

`lib/license_client.py` 的 `verify()` 拿到的响应**本来就带 `policy`**（关停、维护、公告、升级全在里面），
但 `gui.py:313 _verify_license()` 只从 result 里取了 `offline`，`policy` 直接被丢掉。

**后果**：后台按「立即关停」，客户端照跑不误；推送公告，客户端收不到。

**好消息**：因为 policy 已经在响应里，阶段一**不需要新增任何接口调用**，只是把丢掉的东西捡起来用。

### ② 数据目录位置很理想，更新零风险

`lib/runtime.py` 里 `DATA_ROOT` 打包后是 `%LOCALAPPDATA%/XKWController`，**不在 exe 旁边**。
所以换掉 exe 时，授权状态（`data/license/license.json`）、配置、断点全都不受影响，**用户不用重新激活**。

### ③ 打包是 onefile

`xkw_gui.spec` 的 `EXE()` 吃掉了 `a.binaries` 和 `a.datas` 且没有 `COLLECT` → 单文件模式，产物 66MB。
更新是全量下载（onefile 的固有代价，无法做增量）。

---

## 1. 改造后的目录结构

```
XKWController/                      ← 安装目录，分发的 zip 解压到这里
├── launcher.exe                    ← 新增：启动器，快捷方式指向它，几乎永不更新
├── current.txt                     ← 新增：内容是版本号，如 1.0.2
└── versions/
    ├── 1.0.1/XKWController.exe     ← 旧版留着，出问题可秒回滚
    └── 1.0.2/XKWController.exe     ← 当前版本（66MB onefile）

%LOCALAPPDATA%/XKWController/       ← 用户数据，更新永不触碰（现状即如此，不用改）
├── data/license/license.json
├── data/checkpoints/
└── config...
```

**分发形态变化**：从「发一个 exe」变成「发一个 zip」，用户解压后双击 `launcher.exe`。

---

## 2. 阶段一：让远程管控真正生效

### 2.1 `lib/license_client.py` — 暴露 policy，并支持未激活时拉取

**改动 A：`_request` 支持 GET**（当前写死 POST）

```python
def _request(self, path, payload=None, method="POST", params=None):
    url_path = path
    if params:
        clean = {k: v for k, v in params.items() if v is not None}
        # 顺序必须稳定：服务端按 req.originalUrl 验签，签的就是这个完整字符串
        url_path = path + "?" + urllib.parse.urlencode(clean)

    body = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        if payload is not None else b""
    )
    last_error = None
    for attempt in range(3):
        timestamp = str(int(time.time()))
        nonce = str(uuid.uuid4())
        # 注意：GET 也要用带 query 的完整 path 参与签名
        signature = self.sign(self.plugin_secret, method, url_path, timestamp, nonce, body)
        headers = {
            "Authorization": f"Bearer {self.plugin_token}",
            "Accept": "application/json",
            "User-Agent": f"XKWController/{self.client_version} (Desktop License Client)",
            "X-Plugin-Id": self.plugin_id,
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
            "X-Signature": signature,
        }
        if body:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.server_url + url_path,
            data=body or None,
            method=method,
            headers=headers,
        )
        # ...以下 try/except 原样保留...
```

> 文件顶部需要 `import urllib.parse`。

**改动 B：新增 `fetch_policy()`**

```python
def fetch_policy(self):
    """不带卡密的策略拉取。未激活时也能调用，用于开机就问一句
    「我还能不能跑、要不要升级」。"""
    result = self._request(
        "/api/v1/license/policy",
        method="GET",
        params={
            "app_id": self.app_id,
            "device_id": self.device_id(),
            "client_version": self.client_version,
            "channel": "stable",
        },
    )
    return result.get("policy") or {}
```

**改动 C：`verify()` 里把 policy 单独留出来**

`verify()` 末尾 `self._save_state(result)` 之前，policy 不要存进 state（它是易变的），
改成返回体里带上但存盘时剔除：

```python
result["last_verified_at"] = int(time.time())
policy = result.get("policy") or {}
self._save_state({k: v for k, v in result.items() if k != "policy"})
result["policy"] = policy      # 仍然返回给调用方
return result
```

### 2.2 `gui.py` — 解读策略

**改动 A：`_verify_license()` 把 policy 带出来**（约 313 行）

```python
def _verify_license(self, force=False):
    now = time.time()
    if not force and self._license_cache.get("result") and now - self._license_cache["ts"] < 300:
        return self._license_cache["result"]
    client = self._license_client()
    try:
        result = client.verify()
        auth = {"ok": True, "enabled": True, "authorized": True,
                "license": client.local_status(),
                "offline": bool(result.get("offline")),
                "policy": result.get("policy") or {}}          # ← 新增
    except Exception as exc:
        auth = {"ok": False, "enabled": True, "authorized": False,
                "code": getattr(exc, "code", "LICENSE_ERROR"), "error": str(exc),
                "license": client.local_status(),
                "policy": self._safe_fetch_policy()}            # ← 新增：未激活也拿策略
    self._license_cache = {"ts": now, "result": auth}
    return auth

def _safe_fetch_policy(self):
    """未激活或验证失败时兜底拉一次策略：这样公告和强制升级提示仍然能显示。
    网络不通就返回空 dict，绝不能让它把授权流程带崩。"""
    try:
        return self._license_client().fetch_policy()
    except Exception:
        return {}
```

**改动 B：新增给前端调用的策略接口**（AppBridge 里，和 `get_license_status` 并列）

```python
def get_policy(self, force=False):
    """给前端用的远程管控视图。所有判断都在服务端做完，这里只负责如实转达。"""
    auth = self._verify_license(force=force)
    policy = auth.get("policy") or {}
    upgrade = policy.get("upgrade") or {}
    return {
        "kill_switch": bool(policy.get("kill_switch")),
        "kill_message": policy.get("kill_message") or "",
        "maintenance": bool(policy.get("maintenance")),
        "maintenance_message": policy.get("maintenance_message") or "",
        "notice": policy.get("notice"),          # {level,title,content} 或 None
        "upgrade": {
            "available": bool(upgrade.get("available")),
            "required": bool(upgrade.get("required")),
            "latest_version": upgrade.get("latest_version") or "",
            "release_notes": upgrade.get("release_notes") or "",
            "message": upgrade.get("message") or "",
        },
        "ttl": int(policy.get("policy_ttl_seconds") or 300),
        "current_version": license_settings.CLIENT_VERSION,
    }
```

**改动 C：启动时先看关停**（`run_gui()` 里，`webview.create_window` 之前）

```python
def run_gui():
    prepare_runtime()
    # 关停是紧急熔断：窗口都不该开，避免用户以为软件还能用
    try:
        bridge_probe = AppBridge()
        policy = bridge_probe.get_policy(force=True)
        if policy["kill_switch"]:
            _show_blocking_message("服务已停止", policy["kill_message"] or "该软件已停止服务，请联系客服")
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception:
        pass  # 网络问题不能挡住启动，正常进入后再由前端轮询处理
    ...
```

`_show_blocking_message` 用 webview 弹个简单窗口，或退而用 `tkinter.messagebox`：

```python
def _show_blocking_message(title, message):
    try:
        import tkinter as tk
        from tkinter import messagebox
        tk.Tk().withdraw()
        messagebox.showerror(title, message)
    except Exception:
        sys.stderr.write(f"{title}: {message}\n")
```

### 2.3 `web/` — 展示公告与升级提示

**`web/index.html`**：在 `#license-modal` 之后加两个容器

```html
<!-- 公告 -->
<div class="modal-backdrop hidden" id="notice-modal">
  <section class="modal">
    <button class="icon-btn" data-notice-close>×</button>
    <p class="eyebrow" id="notice-level">通知</p>
    <h2 id="notice-title"></h2>
    <p id="notice-content"></p>
    <button class="btn primary wide" data-notice-close>我知道了</button>
  </section>
</div>

<!-- 升级 -->
<div class="modal-backdrop hidden" id="upgrade-modal">
  <section class="modal">
    <button class="icon-btn" id="upgrade-close">×</button>
    <p class="eyebrow">SOFTWARE UPDATE</p>
    <h2>发现新版本 <span id="upgrade-version"></span></h2>
    <p id="upgrade-notes"></p>
    <div id="upgrade-progress" class="hidden"><div id="upgrade-bar"></div><small id="upgrade-text"></small></div>
    <button class="btn primary wide" id="upgrade-now">立即更新</button>
    <small id="upgrade-hint"></small>
  </section>
</div>
```

**`web/app.js`**：加策略处理（跟现有 `checkLicense` 一个风格）

```javascript
let noticeSeen = localStorage.getItem('noticeSeen') || '';

async function checkPolicy(force = false) {
  const p = await api().get_policy(force);
  state.policy = p;

  // 关停：最高优先级，直接锁死界面
  if (p.kill_switch) {
    document.body.innerHTML =
      `<div class="killed"><h1>服务已停止</h1><p>${escapeHtml(p.kill_message)}</p></div>`;
    return p;
  }

  // 维护：只影响新激活，给个提示即可
  if (p.maintenance && !state.license?.authorized) {
    toast(p.maintenance_message || '系统维护中，暂停新卡激活', 'error');
  }

  // 公告：同一条别反复弹
  if (p.notice) {
    const sig = p.notice.title + '|' + p.notice.content;
    if (sig !== noticeSeen) {
      $('#notice-level').textContent =
        ({info: '通知', warning: '注意', critical: '重要'})[p.notice.level] || '通知';
      $('#notice-title').textContent = p.notice.title || '';
      $('#notice-content').textContent = p.notice.content || '';
      setPageModal('#notice-modal', true);
      noticeSeen = sig;
      localStorage.setItem('noticeSeen', sig);
    }
  }

  // 升级
  if (p.upgrade.available) {
    $('#upgrade-version').textContent = p.upgrade.latest_version;
    $('#upgrade-notes').textContent = p.upgrade.release_notes || p.upgrade.message || '';
    // 强制升级：关不掉，但一定要留下更新入口，别让用户卡死
    $('#upgrade-close').style.display = p.upgrade.required ? 'none' : '';
    $('#upgrade-hint').textContent = p.upgrade.required ? '此版本必须更新后才能继续使用' : '';
    setPageModal('#upgrade-modal', true);
  }
  return p;
}

$$('[data-notice-close]').forEach(b => b.onclick = () => setPageModal('#notice-modal', false));
$('#upgrade-close').onclick = () => setPageModal('#upgrade-modal', false);

// 启动时跑一次，之后按服务端建议的间隔轮询（别自己写死更短的，会撞限流）
checkPolicy(true).then(p => setInterval(() => checkPolicy(false), (p?.ttl || 300) * 1000));
```

**阶段一到此为止就能演示**：后台一键关停 → 客户端打不开；推送公告 → 弹窗；设最低版本 → 老版本被拒。

---

## 3. 阶段二：接入更新能力

### 3.1 拷贝两个文件（零依赖，不用装包）

```bash
cp /Volumes/Data/jucesoft/jc-kami/packages/sdk-python/jc_kami/updater.py   lib/license_updater.py
cp /Volumes/Data/jucesoft/jc-kami/packages/sdk-python/jc_kami/_ed25519.py  lib/_ed25519.py
```

`lib/license_updater.py` 顶部的两处 import 要改成本项目的相对路径：

```python
# 原来
from . import _ed25519
from .errors import ErrorCode, LicenseError
# 改成
from lib import _ed25519
from lib.license_client import LicenseError
# 并把文件里所有 ErrorCode.XXX 替换为字符串，例如：
#   _fail("...", ErrorCode.NETWORK_ERROR)  →  _fail("...", "NETWORK_ERROR")
# 同时把 _fail 改成：
#   def _fail(message, code="INTERNAL_ERROR"): raise LicenseError(code, message)
```

### 3.2 `lib/license_settings.py` 加公钥

```python
# 后台：应用管理 → 远程管控 → 更新验签公钥 → 复制
UPDATE_PUBLIC_KEY = "3+ZKBSoNjhpEEsRU..."   # 32 字节 base64
```

> ⚠️ **必须硬编码**。绝不能改成从服务器下载——那样篡改响应的人可以连公钥一起换掉，验签就完全失效了。
> `license_settings.py` 已被 gitignore，公钥本身是公开信息，写进去没有泄密问题。

### 3.3 `gui.py` 加更新方法

```python
def _app_root(self):
    """安装根目录（launcher.exe 和 versions/ 所在处）。

    注意不是 DATA_ROOT：数据在 %LOCALAPPDATA%，而版本目录要跟 launcher 放一起。
    """
    env = os.environ.get("XKW_APP_ROOT")
    if env and os.path.isdir(env):
        return env
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        parent = os.path.dirname(exe_dir)              # <root>/versions
        if os.path.basename(parent) == "versions":
            return os.path.dirname(parent)             # <root>
        return exe_dir                                 # 没走 launcher 时的兜底
    return os.path.dirname(os.path.abspath(__file__))

def apply_update(self):
    """下载并安装新版本。失败不会影响当前正在跑的版本。"""
    from lib.license_updater import UpdatePlan, Updater
    from lib import license_settings

    auth = self._verify_license(force=True)
    policy = auth.get("policy") or {}
    plan = UpdatePlan(license_settings.APP_ID, policy.get("upgrade"))
    if not plan.available:
        return {"ok": False, "error": "当前已是最新版本"}

    updater = Updater(root=self._app_root(), public_key=license_settings.UPDATE_PUBLIC_KEY)
    try:
        def on_progress(got, total):
            self._update_progress = {"got": got, "total": total}
        result = updater.apply(plan, progress=on_progress)
    except Exception as exc:
        return {"ok": False, "code": getattr(exc, "code", "UPDATE_FAILED"), "error": str(exc)}

    return {"ok": True, "version": result.version, "need_restart": True}

def get_update_progress(self):
    p = getattr(self, "_update_progress", None) or {"got": 0, "total": 0}
    pct = int(p["got"] * 100 / p["total"]) if p["total"] else 0
    return {"got": p["got"], "total": p["total"], "percent": pct}

def restart_app(self):
    """启动 launcher 后退出自己，由 launcher 拉起新版本。"""
    from lib.license_updater import Updater
    from lib import license_settings
    updater = Updater(root=self._app_root(), public_key=license_settings.UPDATE_PUBLIC_KEY)
    started = updater.restart()
    if started:
        self.shutdown()
        os._exit(0)
    return {"ok": started, "error": "" if started else "未找到启动器，请手动重启"}
```

### 3.4 `web/app.js` 接更新按钮

```javascript
$('#upgrade-now').onclick = async () => {
  const btn = $('#upgrade-now');
  btn.disabled = true; btn.textContent = '正在下载...';
  $('#upgrade-progress').classList.remove('hidden');

  const timer = setInterval(async () => {
    const p = await api().get_update_progress();
    $('#upgrade-bar').style.width = p.percent + '%';
    $('#upgrade-text').textContent =
      `${(p.got / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`;
  }, 500);

  const r = await api().apply_update();
  clearInterval(timer);
  btn.disabled = false; btn.textContent = '立即更新';

  if (!r.ok) { toast(r.error, 'error'); return; }
  toast('更新完成，正在重启', 'success');
  setTimeout(() => api().restart_app(), 800);
};
```

**SDK 已经替你做掉的事**（不用自己写）：sha256 校验、**Ed25519 验签**、路径穿越防护、
原子切换版本目录、旧版本清理（默认保留 2 个可回滚）、下载超声明大小中止。

---

## 4. 阶段三：启动器 + 版本目录

### 4.1 新建 `launcher.py`（项目根目录）

直接用模板：`/Volumes/Data/jucesoft/jc-kami/packages/sdk-python/templates/launcher.py`

**要改两处**：

```python
ENTRY = "XKWController.exe"     # Windows；macOS 上是 "XKWController"
```

并在 `main()` 启动子进程时把根目录传下去（省得主程序猜路径）：

```python
env = dict(os.environ, XKW_APP_ROOT=root)
completed = subprocess.run([entry] + sys.argv[1:], cwd=version_dir, env=env)
```

模板已经处理好：指针失效自动退到最新可用版本、versions 为空时弹错误框而不是静默退出。

### 4.2 新建 `launcher.spec`

```python
# -*- mode: python ; coding: utf-8 -*-
a = Analysis(["launcher.py"], pathex=[], binaries=[], datas=[], hiddenimports=[])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [],
          name="launcher", debug=False, strip=False, upx=False, console=False)
```

启动器**只需打包一次**，以后发版不用再动它。

### 4.3 改打包脚本

`build_windows.bat` 末尾追加（打包成可分发的 zip）：

```bat
REM 读取版本号，与 license_settings.CLIENT_VERSION 保持一致
for /f "tokens=2 delims== " %%v in ('findstr "CLIENT_VERSION" lib\license_settings.py') do set VER=%%~v

REM 组装分发目录
rmdir /s /q release 2>nul
mkdir release\versions\%VER%
copy dist\XKWController.exe release\versions\%VER%\
copy dist\launcher.exe release\
echo %VER%> release\current.txt

REM 打成 zip 分发给用户
powershell -command "Compress-Archive -Path release\* -DestinationPath XKWController-%VER%.zip -Force"

REM 另外单独打一个只含 exe 的 zip，用于上传到卡密平台做增量发布
powershell -command "Compress-Archive -Path dist\XKWController.exe -DestinationPath update-%VER%.zip -Force"
```

**两个 zip 用途不同**：
- `XKWController-<版本>.zip` —— 给新用户的完整安装包（含 launcher）
- `update-<版本>.zip` —— 上传到卡密平台的更新包（只有主程序）

---

## 5. 发版流程（每次改完代码就这么走）

1. **改版本号**：`lib/license_settings.py` 的 `CLIENT_VERSION`（如 `1.0.1` → `1.0.2`）
   > 服务端靠版本号比大小判断新旧，不改号就不会提示更新。
2. **打包**：跑 `build_windows.bat`，得到 `update-1.0.2.zip`
3. **上传发布**：后台 → 版本发布 → 新建版本
   - 版本号 `1.0.2`
   - 包形态 **单文件**（onefile）
   - 安装策略 **版本目录切换**
   - 剥掉外层目录 **开**
   - 启动入口 `XKWController.exe`
   - 上传 `update-1.0.2.zip`
4. **点发布** ← 签名在这一刻生成
5. 老客户端下次轮询（默认 5 分钟内）就收到更新提示

**灰度建议**：先放量 10%，观察一天没问题再拉到 100%。
**出问题**：后台把该版本「归档」，新客户端就不会再拿到它；已装的用户改 `current.txt` 回上个版本即可。

---

## 6. 必须避开的坑

| 坑 | 说明 | 怎么做 |
|---|---|---|
| **装在 Program Files 更新会失败** | 普通用户对该目录没有写权限，`versions/` 建不出来 | 装到 `%LOCALAPPDATA%\XKWController` 或 D 盘，安装包里写清楚 |
| **macOS 上更新后启动不了** | zip 解压会丢执行位（644） | 已在 SDK 侧修复（恢复 rwx，同时丢弃 setuid 防提权）。确认用的是最新的 `updater.py` |
| **忘了改版本号** | 服务端认为客户端已是最新，不下发更新 | 发版第一步就改 `CLIENT_VERSION` |
| **公钥从服务器读** | 篡改响应者可连公钥一起换，验签形同虚设 | 硬编码在 `license_settings.py` |
| **自己写死轮询间隔** | 比 `policy_ttl_seconds` 短会撞限流 | 用服务端返回的 `ttl` |
| **强制升级把用户卡死** | `required=true` 时关掉了更新入口 | 强制升级弹窗可以不许关，但**必须留更新按钮** |
| **数据目录别挪** | 现在在 `%LOCALAPPDATA%`，正好在版本目录外 | 保持现状，不要改成 exe 同级 |

---

## 7. 验收清单

**阶段一**
- [ ] 后台开「立即关停」→ 客户端启动被拦，显示后台配置的提示语
- [ ] 后台关掉关停 → 客户端恢复正常
- [ ] 后台推送公告 → 客户端弹窗，级别对应样式；重启后同一条不再重复弹
- [ ] 后台开「维护模式」→ 新设备激活被拒，已激活设备照常使用
- [ ] 后台设「最低可用版本」高于当前 → 客户端被拒并提示升级

**阶段二 + 三**
- [ ] 发布新版本 → 客户端 5 分钟内提示更新
- [ ] 点「立即更新」→ 进度条走动 → 完成后自动重启到新版本
- [ ] `versions/` 下同时存在新旧两个版本，`current.txt` 指向新版
- [ ] 更新后**授权状态还在**（不用重新输卡密）、配置和断点都在
- [ ] 手动把 `current.txt` 改回旧版本号 → 重启后跑的是旧版（回滚可用）
- [ ] 断网状态下点更新 → 报错但当前版本照常能用
- [ ] 删掉 `versions/<当前版本>/` 目录 → launcher 自动退到另一个可用版本

**安全**（可选，验证签名确实在生效）
- [ ] 把 `UPDATE_PUBLIC_KEY` 改成别的值 → 更新时报「签名验证失败，拒绝安装」

---

## 8. 平台侧配置（在卡密后台做，不涉及代码）

1. 应用管理 → 找到该应用 → **远程管控** → 复制「更新验签公钥」
2. 部署到正式环境后，`lib/license_settings.py` 的 `SERVER_URL` 改成 `https://auth.555c.cn`
3. 确认服务端 `.env` 的 `PUBLIC_BASE_URL` 已填 `https://auth.555c.cn`
   > 漏配的话下发的下载地址会缺域名，客户端下载会失败。服务端启动日志里会有告警。
