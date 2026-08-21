# dsh-password-gate

给 DeepSeek Harness 的 Web profile（`dsh web`）加访问密码的插件：页面、`/api`、WebSocket 全部需要密码才能访问。打开网页先看到登录页，输入密码后进入。

## 安装

```sh
# 本地开发（在插件目录外执行，或使用绝对路径）
dsh plugin --profile web add file:/path/to/dsh-password-gate

# 或从 GitHub 安装
dsh plugin --profile web add github:nightwhite/dsh-password-gate
```

卸载：

```sh
dsh plugin --profile web remove dsh-password-gate
```

## 设置密码

**不设置任何密码时行为和没装插件完全一样（无需密码）**。只有显式配置了密码才启用门禁：

```sh
npx @deepseek-ai/dsh web                    # 免密码，与原生一致
npx @deepseek-ai/dsh web --password mysecret    # 启用门禁
DSH_WEB_PASSWORD=mysecret npx @deepseek-ai/dsh web   # 启用门禁
```

`--help` 里会多出 `--password` 选项：

```sh
npx @deepseek-ai/dsh web --help
```

## 工作原理

- 插件是 DSH bundle：`package.json` 声明 `dsh.bundle.patch`，patch 层禁用了原 `web-startup` 行（它不认识 `--password`，遇到会直接退出）和原 `webserver` 行，替换为：
  - `web-password-startup`：解析 `--host` / `--port` / `--trusted-host` / `--password`，提供与原版同名的 `webStartup` 服务；
  - `web-password-gate`：子类化 in-box 的 `WebServer`，提供同名的 `webServer` 服务，在转发给已注册路由之前校验会话。
- 登录成功后发放签名 Cookie（`dsh_gate`，HttpOnly + SameSite=Strict，24 小时有效，重启后失效）。
- 未认证请求：浏览器导航 → 登录页；API/XHR → `401 {"error":"unauthorized"}`；WebSocket → 直接断开。
- 未配置密码（无 `--password`、无 `DSH_WEB_PASSWORD`）时门禁完全不介入，请求原样转发。

## 安全说明

- 会话 token 用每次启动随机生成的密钥签名，DSH 重启后所有会话失效。
- 密码比对使用 `timingSafeEqual`，token 校验同样恒定时间。
- 无速率限制；绑定仅支持 `127.0.0.1`（与原版一致，`--host 0.0.0.0` 仍被拒绝）。

## 开发

纯 ESM JavaScript，无构建步骤。

```sh
npm run check   # 语法检查
```

运行时依赖全部为 optional peerDependencies，经 parent-walk 解析到 `$DSH_HOME/profiles/node_modules` 的 in-box 拷贝（与 sealos-skills 同策略），避免同一包出现多份拷贝。
