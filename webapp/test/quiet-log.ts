import { configureLog, parseLogLevel } from "../src/server/log";

/** The test run's log level: errors only, unless TEST_LOG_LEVEL says otherwise (preloaded, see bunfig.toml). */
configureLog({ level: parseLogLevel(process.env.TEST_LOG_LEVEL || "error") });
