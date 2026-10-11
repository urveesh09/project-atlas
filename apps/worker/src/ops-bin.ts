import { ConfigError } from '@atlas/control';
import { runOps } from './ops.js';

// Set the exit code and let open sockets close: process.exit() during socket teardown
// trips a libuv assertion on Windows.
runOps(process.env, process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof ConfigError ? error.message : 'Operator command failed'}\n`);
    process.exitCode = 1;
  },
);
