import pino from "pino";
import { IS_PROD } from "./config.js";

/**
 * Shared application logger.
 *
 * In dev we pipe through `pino-pretty` for readable, colorized terminal output
 * (timestamps + level badges + our messages). In production we emit plain
 * newline-delimited JSON, which is what log collectors expect.
 */
export const logger = pino(
  IS_PROD
    ? { level: process.env.LOG_LEVEL || "info" }
    : {
        level: process.env.LOG_LEVEL || "debug",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
            messageFormat: "{msg}",
          },
        },
      }
);

/** Namespaced child logger, e.g. log("live") -> tags entries with module:"live". */
export const log = (module) => logger.child({ module });
