import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/**
 * Replacement for `@deepseek-ai/dsh-web-app/startup`: parses the same web
 * flag family (`--host`, `--port`, `--trusted-host`) plus `--password`, and
 * provides the same `webStartup` service shape with an added `password`
 * field. Rows configured from flags inject this service, so Loader resolves
 * their expressions only after it exists.
 * @module dsh-password-gate/startup
 */
const name = "web-password-startup";

/** Services required before the flags can be resolved. */
const inject = ["cmdlineArgs"];

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
const WEB_STARTUP_SERVICE = "webStartup";

/** This app's command: its flags, its description, and its help text. */
function webCommand() {
	return new Command()
		.name("dsh --profile web")
		.description("Serve the DeepSeek Harness browser UI.")
		.helpOption("-h, --help", "show this help")
		.option("--host <host>", "bind host")
		.option("--port <port>", "listen port; pass 0 to let the OS pick a free one")
		.option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)")
		.option("--password <password>", "require this access password on every route; falls back to DSH_WEB_PASSWORD, then to a random password printed at startup")
		.addHelpText("after", `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --password secret        require a password to open the page
`);
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`
 * or a non-numeric `--port` is a usage error, so on rejection (and on
 * `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
function apply(ctx) {
	const program = webCommand();
	program.action(() => {
		const options = program.opts();
		if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
		if (options.port !== void 0 && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
		ctx.provide(WEB_STARTUP_SERVICE, {
			...options.host !== void 0 && { host: options.host },
			...options.port !== void 0 && { port: Number(options.port) },
			trustedHosts: options.trustedHost ?? [],
			...options.password !== void 0 && { password: options.password }
		});
	});
	parseCmdline(ctx, program);
}

export { WEB_STARTUP_SERVICE, apply, inject, name };
