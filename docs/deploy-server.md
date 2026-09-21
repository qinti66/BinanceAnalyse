# 服务器部署说明（Ubuntu，对外访问）

## 要求

- **Node ≥22.18 且 <23，或 ≥23.6**（`package.json` 的 `engines`）。原因：`.mjs` 脚本直接 import `lib/*.ts`，依赖类型剥离默认开启；更早的版本会在 `.ts` 上报一个看起来像代码 bug 的语法错误。推荐装 Node 22 LTS 的最新版（≥22.18）。
- 解压归档需要 `unzip`（`sudo apt install unzip`），只在用 `fetch-archive.mjs` 时才用到。
- 仓库里没有 `.nvmrc`，版本以 `engines` 为准。

## 步骤（顺序不能换）

```bash
cd /home/ubuntu/Tool/BinanceAnalyse
node --version                 # 必须满足上面的要求，否则停
node scripts/check-binance-net.mjs   # 网络门禁：直连 200 才继续；451 或超时就停下报告，不要绕
npm run install:ci
npm run build
```

## 站点登录（对外监听的前提）

站点的所有页面和 `/api/*` 都要先登录。账号在服务器上的 `.dev.vars` 里配置，**不要提交到仓库**（`.dev.vars*` 已被 gitignore）：

```
AUTH_USERNAME=你的用户名
AUTH_PASSWORD=你的密码
SESSION_SECRET=至少16个字符，建议32个以上的随机字符
```

```bash
chmod 600 .dev.vars
```

- 生成随机 SESSION_SECRET：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- 不配置 `AUTH_USERNAME` 时登录关闭，仅用于本机开发。
- 登录 5 次失败会锁定该来源地址 15 分钟；会话 7 天有效；修改密码或 SESSION_SECRET 后需重启服务，旧会话（改了 SESSION_SECRET 时）全部失效。
- ⚠️ **当前是明文 HTTP**：密码和会话 cookie 在网络上不加密，处于同一网络路径的人可以看到。要真正安全需要在前面加 HTTPS（例如 Caddy/Nginx 反向代理并申请证书），这一步没有做。

## 启动

```bash
HOST=0.0.0.0 PORT=8085 npm start
```

- `HOST` 默认 `127.0.0.1`，`PORT` 默认 `8787`；本机开发不受影响。
- `HOST` 不是回环地址时，`scripts/start.mjs` 会：① 检查 `.dev.vars` 里三个变量都在、`SESSION_SECRET` ≥16 个字符，否则拒绝启动；② 把 `.dev.vars` 复制到 `dist/server/`（wrangler 从配置文件所在目录读它，权限 600）；③ 启动后**真的发一次匿名请求**，确认它被重定向到 `/login`，否则立刻停止服务（宁可停也不裸奔）。
- pm2 常驻示例：`HOST=0.0.0.0 PORT=8085 pm2 start npm --name alpha-radar -- start`。

## wrangler dev 在 0.0.0.0 下的注意点

- 站点是用 `wrangler dev --local` 跑的（Cloudflare Workers 本地运行时），不是专门的生产服务器；对外用时建议前面加反向代理。
- 我在本机（Windows）实测了 `npm run build` + `npm start` 的生产路径：未登录的 `/api/*` 返回 401、页面 307 到 `/login`、登录后放行、登出后失效。**没有在 Ubuntu 上实测**，没有发现额外的 Host 校验，但 0.0.0.0 监听本身是在服务器上第一次验证。
- `--inspector-port 0` 已保留（不开放调试端口）。

## 数据更新（没有定时任务，手动触发）

- 项目一贯**不引入调度器**，全部手动触发：
  - 指标快照：`node scripts/collect-indicators.mjs`（完整一轮约 600 个合约，几千个请求；受限速器约束，约 10–15 分钟）。
  - 简版市场快照：`npm run collect:market`（6 个合约）。
- 页面上"更新"按钮走的是另一个只监听 `127.0.0.1:8791` 的本机服务（`scripts/indicator-service.mjs`），**从别人的浏览器访问不到它**，服务器部署上不要指望页面按钮。需要更新就在服务器上手动跑上面的命令。
- 频率：由使用者决定；不要为了"看起来新"缩短间隔。`/futures/data/` 族限额按 IP 计（900 次 / 5 分钟已由限速器遵守）。遇到 403/418/429/451，脚本会停下，**不要重试或换路径**。
- **服务器到币安直连是否可用尚未验证**——以上面 `check-binance-net.mjs` 的结果为准。
