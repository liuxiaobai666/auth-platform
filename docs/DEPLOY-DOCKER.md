# Docker 部署指南(全新服务器)

服务器**只需装 Docker**,MySQL / Redis / Node 全在容器里,与宿主机版本无关。

整套由四个容器组成:

| 容器 | 作用 | 对外端口 |
|------|------|----------|
| `web` (nginx) | 托管后台前端 + 反代 `/api` 到后端 | `HTTP_PORT`(默认 8090) |
| `server` (NestJS) | 授权中心后端 API | `API_PORT`(默认 8848) |
| `mysql` | 数据库 | ❌ 仅容器内网 |
| `redis` | 防重放 / 限流 | ❌ 仅容器内网 |

**HTTPS / 域名由你自己的反代(宝塔 / Nginx)处理**,把域名反代到宿主机 `8090` 端口即可:

- `https://auth.555c.cn/` → 后台管理界面
- `https://auth.555c.cn/api/v1/...` → 后端 API(其他项目对接)

`web` 容器内部已经把 `/api` 转给后端,所以**一个域名反代到 8090** 就同时有了后台和 API,不用单独处理 8848(除非你想给 API 单挂一个域名,那就反代到 8848)。

数据落在三个 Docker 数据卷:`mysql-data`(库)、`redis-data`、`releases`(上传的安装包)。删容器不丢数据。

---

## 一、服务器装 Docker(一次性)

以 Ubuntu / Debian 为例:

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
docker --version && docker compose version
```

> CentOS / 其他系统见 https://docs.docker.com/engine/install/

**同时:把域名 A 记录解析到本机公网 IP**(如 `auth.555c.cn`),稍后你自己的反代要用。

---

## 二、拉代码

```bash
git clone git@gitee.com:izhran/auth-platform.git
cd auth-platform
```

（服务器上没配 gitee SSH key 就用 HTTPS：`git clone https://gitee.com/izhran/auth-platform.git`）

---

## 三、配置环境变量

```bash
cp .env.docker.example .env
```

先生成 5 个随机密钥,每条各跑一次,把输出分别填进 `.env`:

```bash
openssl rand -hex 32
```

对应填入 `.env` 的这几项(`MASTER_ENCRYPTION_KEY` 必须正好 64 位十六进制,`openssl rand -hex 32` 刚好符合):

```
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
LICENSE_TOKEN_SECRET=...
LICENSE_KEY_PEPPER=...
MASTER_ENCRYPTION_KEY=...
```

再改这几项:

- `PUBLIC_BASE_URL` — 你的对外域名,如 `https://auth.555c.cn`(用于生成安装包下载链接)
- `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` — 数据库口令,自定义强口令
- `SEED_ADMIN_PASSWORD` — 初始管理员密码
- `HTTP_PORT` / `API_PORT` — 容器对外端口,默认 `8090` / `8848`,反代指向 8090 即可

> ⚠️ **`LICENSE_KEY_PEPPER` 和 `MASTER_ENCRYPTION_KEY` 一旦上线产生真实卡密后绝不能再改**,否则历史卡密全部失效 / 无法解密。第一次就定好。

---

## 四、启动

```bash
docker compose up -d --build
```

首次会构建镜像 + 拉 MySQL/Redis,耗时几分钟。启动时后端会自动:
建表(migrate deploy) → 创建管理员(幂等) → 启动服务。

看启动日志:

```bash
docker compose logs -f server
```

看到 `授权中心已启动` 即成功。先用 IP 验证:浏览器打开 `http://服务器IP:8090`,用 `.env` 里的管理员账号登录。确认没问题后,再配你自己的反代绑域名(见第六节)。

> 其他项目对接授权中心时,接口基址填 `https://auth.555c.cn/api/v1`。

---

## 五、常用运维

```bash
docker compose ps                 # 看状态
docker compose logs -f server     # 后端日志
docker compose restart server     # 重启后端
docker compose down               # 停(数据卷保留,不丢数据)
docker compose up -d --build      # 改代码后重新构建上线
```

**更新版本:**

```bash
git pull
docker compose up -d --build
```

新迁移会在 `server` 启动时自动 `migrate deploy`,无需手动建表。

**备份数据库:**

```bash
docker compose exec mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" jc_kami' > backup-$(date +%F).sql
```

**备份安装包:** 备份 `releases` 数据卷即可(`docker volume inspect jc-kami_releases` 看物理路径)。

---

## 六、绑域名 + HTTPS(你自己的反代)

容器只对外提供明文端口 `8090`,域名和证书由你现有的反代处理。**一个域名反代到 8090 就够了**(后台和 API 都在里面)。

**宝塔面板:**
1. 新建站点,域名填 `auth.555c.cn`(纯反代站点,不用 PHP)。
2. 站点设置 → 反向代理 → 目标 URL 填 `http://127.0.0.1:8090`,发送域名填 `$host`。
3. 站点设置 → SSL → Let's Encrypt 一键申请证书,开启「强制 HTTPS」。
4. 反代配置里把上传大小放开(否则传大安装包会 413):`client_max_body_size 2100m;`

**手写 Nginx 也一样:**
```nginx
server {
    server_name auth.555c.cn;
    client_max_body_size 2100m;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # 证书由 certbot / 宝塔 自动补全 listen 443 与 ssl_certificate
}
```

配完确认 `PUBLIC_BASE_URL=https://auth.555c.cn` 与域名一致,`docker compose up -d` 生效。

> 想给 API 单独挂域名(如 `api.555c.cn`),就再建一个反代站点指向 `http://127.0.0.1:8848`。

---

## 七、安全提醒

- `.env` 含全部密钥,已被 `.gitignore` 忽略,**不要提交、不要外发**。
- MySQL / Redis **不对外暴露端口**,只走容器内网,减少攻击面。
- 登录后第一件事:在后台把初始管理员密码改掉。
- 对公网只需放行反代用的 **80 / 443**(和 22)。`8090` / `8848` 若只给本机反代用,可在安全组里**不对公网放行**,或让反代走 `127.0.0.1` 即可。
