import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { IS_PROD } from "./config.js";

/**
 * Shared application logger.
 *
 * Console: in dev, `pino-pretty` for readable, colorized output; in production,
 * plain newline-delimited JSON on stdout, which is what log collectors expect.
 *
 * File: always, as JSON lines in data/logs/server-<boot date>.log. Terminal
 * output is gone once the window closes, and a session review needs to see feed
 * disconnects, reconnects and errors after the fact. data/ is gitignored.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const level = process.env.LOG_LEVEL || (IS_PROD ? "info" : "debug");
const bootDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10); // IST
const logFile =
  process.env.LOG_FILE ?? path.resolve(__dirname, `../data/logs/server-${bootDate}.log`);

const targets = [
  IS_PROD
    ? { target: "pino/file", level, options: { destination: 1 } }
    : {
        target: "pino-pretty",
        level,
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
          messageFormat: "{msg}",
        },
      },
];
// LOG_FILE="" turns the file off (e.g. for one-off scripts).
if (logFile) targets.push({ target: "pino/file", level, options: { destination: logFile, mkdir: true } });

export const logger = pino({ level }, pino.transport({ targets }));

/** Namespaced child logger, e.g. log("live") -> tags entries with module:"live". */
export const log = (module) => logger.child({ module });
