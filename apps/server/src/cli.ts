/*
 * The operator command, `cli` in the image (docs/deployment.md, "Service
 * tokens from the command line"). Stdout carries only the command's output;
 * logs go to stderr. It starts no web server, no worker and no error
 * reporting, closes the database pool and exits.
 */
import { logToStderr } from "./log-target";

logToStderr();
// Loaded only now: the logger reads the target when it loads.
const { runCli } = await import("./cli/main");
const { closeDb } = await import("./db/client");

const code = await runCli(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
});
await closeDb().catch(() => undefined);
// Exit only once the output is written: a pipe can take it slower than it comes.
const flushed = (stream: NodeJS.WriteStream) => new Promise((resolve) => stream.write("", resolve));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
