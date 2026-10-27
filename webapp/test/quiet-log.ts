import { configureLog, parseLogLevel } from "../src/server/log";

/** The test run's log level: errors only, unless TEST_LOG_LEVEL says otherwise (preloaded, see bunfig.toml). */
export const TEST_LOG_LEVEL = parseLogLevel(process.env.TEST_LOG_LEVEL || "error");
configureLog({ level: TEST_LOG_LEVEL });
