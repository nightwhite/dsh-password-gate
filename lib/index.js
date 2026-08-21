import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";

/**
 * @deepseek-ai/dsh-host-webserver replacement that password-gates every
 * request and upgrade before the registered routes see it. Subclasses the
 * in-box WebServer (same `webServer` service identity, same route tables,
 * fallback seat, index taps, and port/host getters) and only wraps the
 * server's request/upgrade listeners after the original bind completes:
 * unauthorized browser navigations get a self-contained login page, API/XHR
 * requests get 401 JSON, and WebSocket upgrades are closed.
 *
 * Session: a signed cookie (`expiry.hmac(bootSecret, expiry:password)`) with
 * a per-boot random secret, HttpOnly + SameSite=Strict, 24h lifetime. The
 * password comes from config (the `--password` flag or DSH_WEB_PASSWORD,
 * resolved by the patch row); when neither is set the gate is inactive and
 * the server behaves exactly like the in-box webserver (no login page).
 * @module dsh-password-gate
 */
const COOKIE_NAME = "dsh_gate";
const LOGIN_PATH = "/__dsh_login";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_BODY = 64 * 1024;

var GatedWebServer = class extends WebServer {
	static Config = z.object({
		host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
		port: z.natural().max(65535).required(),
		password: z.string()
	});

	constructor(ctx, config) {
		super(ctx, config);
		this.password = config.password || null;
		this.bootSecret = randomBytes(32);
	}

	/** Wrap the bound server's listeners: check auth, then forward. No password configured — leave the server untouched. */
	async [Service.init]() {
		await super[Service.init]();
		if (this.password === null) return;
		const server = this.server;
		const httpListener = server.listeners("request")[0];
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			this.handleRequest(req, res, httpListener);
		});
		const upgradeListener = server.listeners("upgrade")[0];
		server.removeAllListeners("upgrade");
		server.on("upgrade", (req, socket, head) => {
			if (!this.authorized(req)) {
				socket.destroy();
				return;
			}
			upgradeListener(req, socket, head);
		});
	}

	handleRequest(req, res, next) {
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		if (pathname === LOGIN_PATH) {
			if (req.method === "POST") {
				this.handleLogin(req, res).catch((error) => {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					if (res.headersSent) {
						res.destroy();
						return;
					}
					res.writeHead(400);
					res.end();
				});
				return;
			}
			res.writeHead(302, { Location: "/" });
			res.end();
			return;
		}
		if (this.authorized(req)) {
			next(req, res);
			return;
		}
		if (this.wantsHtml(req)) {
			this.sendLoginPage(res, 200, null);
			return;
		}
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
	}

	async handleLogin(req, res) {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > MAX_LOGIN_BODY) {
				res.writeHead(413);
				res.end();
				return;
			}
		}
		const params = new URLSearchParams(body);
		const candidate = params.get("password") ?? "";
		if (!this.passwordMatches(candidate)) {
			this.sendLoginPage(res, 401, "密码错误，请重试");
			return;
		}
		const expiry = Date.now() + SESSION_TTL_MS;
		const token = `${expiry}.${this.sign(`${expiry}:${this.password}`)}`;
		res.writeHead(302, {
			Location: params.get("redirect") || "/",
			"Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
		});
		res.end();
	}

	authorized(req) {
		const cookie = this.parseCookies(req.headers.cookie ?? "")[COOKIE_NAME];
		if (!cookie) return false;
		const dot = cookie.indexOf(".");
		if (dot === -1) return false;
		const expiry = Number(cookie.slice(0, dot));
		if (!Number.isFinite(expiry)) return false;
		const now = Date.now();
		if (expiry < now - 60_000 || expiry > now + SESSION_TTL_MS) return false;
		const signature = cookie.slice(dot + 1);
		const expected = this.sign(`${expiry}:${this.password}`);
		const a = Buffer.from(signature);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	passwordMatches(candidate) {
		const a = Buffer.from(candidate);
		const b = Buffer.from(this.password);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	sign(payload) {
		return createHmac("sha256", this.bootSecret).update(payload).digest("hex");
	}

	parseCookies(header) {
		const cookies = {};
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq === -1) continue;
			cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
		}
		return cookies;
	}

	wantsHtml(req) {
		const mode = req.headers["sec-fetch-mode"];
		if (mode === "navigate") return true;
		return (req.headers.accept ?? "").includes("text/html");
	}

	sendLoginPage(res, status, error) {
		res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness · 访问密码</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .card { width: min(92vw, 360px); background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px; outline: none; }
  input:focus { border-color: #4f8cff; }
  button { width: 100%; margin-top: 12px; padding: 10px; border: none; border-radius: 8px; background: #2f81f7; color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #1f6feb; }
  .error { color: #ff7b72; font-size: 13px; margin: 0 0 12px; }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>DeepSeek Harness</h1>
    <p class="sub">此实例受访问密码保护，请输入密码</p>
    ${error ? `<p class="error">${error}</p>` : ""}
    <input type="password" name="password" placeholder="访问密码" autofocus required autocomplete="current-password">
    <button type="submit">进入</button>
  </form>
</body>
</html>
`);
	}
};

export { GatedWebServer, GatedWebServer as default };
