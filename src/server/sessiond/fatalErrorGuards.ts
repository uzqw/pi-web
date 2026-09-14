/**
 * Process-level guards for asynchronous failures that would otherwise kill the
 * session daemon. Agent model streams (provider fetches) reject with abort,
 * timeout, and socket errors when runs are cancelled or networks flap; those
 * rejections occasionally escape every local catch and surface as an
 * unhandled rejection or uncaught exception. Node's default for either is to
 * terminate the process, which takes every hosted session down with it.
 *
 * The daemon instead logs the failure and keeps serving: a rejected agent
 * stream is already reported to its session through the provider error path,
 * while a truly fatal synchronous fault still exits through the normal throw
 * path (these handlers only observe errors the runtime already classified as
 * unhandled). Shutdown still exits with a non-zero code via process.exitCode.
 */

export interface FatalErrorGuardLogger {
  error(obj: Record<string, unknown>, message: string): void;
}

export interface FatalErrorGuardOptions {
  logger: FatalErrorGuardLogger;
}

type UnhandledRejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
type UncaughtExceptionListener = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;

/**
 * Install the guards. Returns a restore function that removes them, so tests
 * can exercise the listeners without leaking process-level state between
 * cases.
 */
export function installFatalErrorGuards({ logger }: FatalErrorGuardOptions): () => void {
  const onUnhandledRejection: UnhandledRejectionListener = (reason) => {
    logger.error({ err: reason }, "unhandled rejection in session daemon; continuing");
  };
  const onUncaughtException: UncaughtExceptionListener = (error, origin) => {
    logger.error({ err: error, origin }, "uncaught exception in session daemon; continuing");
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  return () => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
}
