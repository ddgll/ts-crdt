/**
 * A minimal logging interface the library emits through instead of calling
 * `console.*` directly. Consumers can supply their own implementation to route
 * output to a structured logger, downgrade noise, or silence the library
 * entirely (see {@link setLogger} and {@link NoopLogger}).
 */
export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

/**
 * The default logger, which forwards everything to the global `console`.
 * Matches the historical behaviour of the library.
 */
export const consoleLogger: Logger = {
	debug: (...args) => console.debug(...args),
	info: (...args) => console.info(...args),
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
};

/**
 * A logger that discards all output. Useful in tests or embedded contexts where
 * the library should stay silent.
 */
export const noopLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

let currentLogger: Logger = consoleLogger;

/**
 * Overrides the process-wide logger used by library code that does not receive
 * an explicit logger (e.g. {@link Doc}/{@link EgWalker}). Pass {@link noopLogger}
 * to silence the library.
 * @param logger The logger implementation to install.
 */
export function setLogger(logger: Logger): void {
	currentLogger = logger;
}

/**
 * Returns the process-wide logger. Components that accept an explicit logger
 * should prefer that over this fallback.
 */
export function getLogger(): Logger {
	return currentLogger;
}
