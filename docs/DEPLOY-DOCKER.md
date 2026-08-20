# Docker 部署指南(全新服务器)

服务器**只需装 Docker**,MySQL / Redis / Node 全在容器里,与宿主机版本无关。

整套由四个容器组成:

| 容器 | 作用 | 对外端口 |
|------|------|----------|
| `web` (nginx) | 托管后台前端 + 反代 `/api` 到后端 | `HTTP_PORT`(默认 8090)= 后台管理界面 |
| `server` (NestJS) | 授权中心后端 API | `API_PORT`(默认 8848)= 其他项目/SDK 对接 |
| `mysql` | 数据库 | ❌ 仅容器内网 |
| `redis` | 防重放 / 限流 | ❌ 仅容器内网 |

**两个对外端口各司其职:**

- **8090** — 你自己开浏览器管理:`http://服务器IP:8090`
- **8848** — 其他项目对接授权中心:`http://服务器IP:8848/api/v1/...`

(后台界面内部也会反代到后端,所以两个端口都能到达 API,互不影响。)

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

- `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` — 数据库口令,自定义强口令
- `SEED_ADMIN_PASSWORD` — 初始管理员密码
- `PUBLIC_BASE_URL` — 有域名填 `https://你的域名`;没域名填 `http://服务器IP:8090`
- `HTTP_PORT` — 后台管理界面端口,默认 `8090`,想用 80 就填 `80`
- `API_PORT` — 后端 API 直连端口,默认 `8848`,给其他项目对接用

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

看到 `授权中心已启动` 即成功。浏览器打开 `http://服务器IP:8090`,用 `.env` 里的管理员账号登录。

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

## 六、上 HTTPS(建议)

两种方式二选一:

1. **前面再套一层 Nginx / 宝塔反代**:域名指向服务器,反代到 `http://127.0.0.1:8090`,证书在外层处理(最简单)。
2. **用 Caddy 自动证书**:另起一个 Caddy 容器 `reverse_proxy web:80`,自动签发 Let's Encrypt。

上 HTTPS 后记得把 `.env` 的 `PUBLIC_BASE_URL` 改成 `https://你的域名` 并 `docker compose up -d`。

---

## 七、安全提醒

- `.env` 含全部密钥,已被 `.gitignore` 忽略,**不要提交、不要外发**。
- MySQL / Redis **不对外暴露端口**,只有 `HTTP_PORT`(后台)和 `API_PORT`(对接)对外,减少攻击面。
- 登录后第一件事:在后台把初始管理员密码改掉。
- 服务器防火墙只放行 `HTTP_PORT`、`API_PORT`(和 22)。
