import { describe, expect, it, vi } from "vitest";
import { installFatalErrorGuards } from "./fatalErrorGuards.js";

describe("fatal error guards", () => {
  it("logs unhandled rejections and uncaught exceptions, then restores listeners", () => {
    const logger = { error: vi.fn() };
    const restore = installFatalErrorGuards({ logger });

    const rejection = new Error("provider socket died");
    process.emit("unhandledRejection", rejection, Promise.resolve());
    expect(logger.error).toHaveBeenCalledWith(
      { err: rejection },
      "unhandled rejection in session daemon; continuing",
    );

    const failure = new Error("abort escaped");
    // process.emit lacks an uncaughtException overload; emit through the
    // untyped EventEmitter surface instead.
    const emitter: NodeJS.EventEmitter = process;
    emitter.emit("uncaughtException", failure, "uncaughtException");
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, origin: "uncaughtException" },
      "uncaught exception in session daemon; continuing",
    );

    const before = process.listenerCount("unhandledRejection");
    restore();
    expect(process.listenerCount("unhandledRejection")).toBe(before - 1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
