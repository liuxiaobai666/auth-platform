# Docker 部署指南(全新服务器)

服务器**只需装 Docker**,MySQL / Redis / Node 全在容器里,与宿主机版本无关。

整套由四个容器组成:

| 容器 | 作用 | 对外端口 |
|------|------|----------|
| `caddy` | 反向代理 + 自动 HTTPS(域名入口) | `80` / `443` |
| `web` (nginx) | 托管后台前端 + 反代 `/api` 到后端 | `HTTP_PORT`(默认 8090)= IP 直连备用 |
| `server` (NestJS) | 授权中心后端 API | `API_PORT`(默认 8848)= IP 直连备用 |
| `mysql` | 数据库 | ❌ 仅容器内网 |
| `redis` | 防重放 / 限流 | ❌ 仅容器内网 |

**正式入口是一个域名(方案 A):** `CADDY_DOMAIN`(如 `auth.555c.cn`)

- 后台管理界面 → `https://auth.555c.cn/`
- 其他项目对接 → `https://auth.555c.cn/api/v1/...`

Caddy 会自动申请并续期 Let's Encrypt 证书。`8090`/`8848` 只是用 IP 直连的备用入口,只用域名的话可以不放行。

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

**同时:把域名解析到本机。** 在你的 DNS 服务商给域名(如 `auth.555c.cn`)加一条 **A 记录**指向本服务器公网 IP。Caddy 签发证书要求域名已能解析到本机、且 **80 和 443 端口对公网放行**。

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

- `CADDY_DOMAIN` — 你的域名,如 `auth.555c.cn`(A 记录要先解析到本机)
- `PUBLIC_BASE_URL` — 与域名一致,如 `https://auth.555c.cn`
- `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` — 数据库口令,自定义强口令
- `SEED_ADMIN_PASSWORD` — 初始管理员密码
- `HTTP_PORT` / `API_PORT` — IP 直连备用端口,默认 `8090` / `8848`,一般不用动

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

看到 `授权中心已启动` 即成功。等 Caddy 签好证书(首次约十几秒,看 `docker compose logs -f caddy`),浏览器打开 **`https://auth.555c.cn`**,用 `.env` 里的管理员账号登录。

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

## 六、HTTPS(已内置,自动)

HTTPS 由 `caddy` 容器**全自动**处理,无需手动搞证书:

- 前提:`CADDY_DOMAIN` 的 A 记录已解析到本机,且 **80 / 443 对公网放行**。
- 启动后 Caddy 自动向 Let's Encrypt 申请证书并**自动续期**。
- 证书存在 `caddy-data` 数据卷,重建容器不重签。

排查:`docker compose logs -f caddy`。若签发失败,九成是 **DNS 没解析到本机** 或 **80/443 被防火墙/安全组挡了**。

> 换域名:改 `.env` 的 `CADDY_DOMAIN` 和 `PUBLIC_BASE_URL`,再 `docker compose up -d`。

---

## 七、安全提醒

- `.env` 含全部密钥,已被 `.gitignore` 忽略,**不要提交、不要外发**。
- MySQL / Redis **不对外暴露端口**,只走容器内网,减少攻击面。
- 登录后第一件事:在后台把初始管理员密码改掉。
- 防火墙/安全组放行 **80、443**(域名+证书必需)和 **22**。
- 只想用域名访问的话,**8090 / 8848 不必放行**(它们只是 IP 直连的备用入口);要更严可在 compose 里去掉这两个 `ports` 映射。
