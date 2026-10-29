// matter.js's log to stderr with the integration's level prefixes. Imported
// right after stdout.js, before the rest of matter.js.

import { Logger, LogLevel } from '@matter/general';

const LEVELS = ['DEBUG', 'INFO', 'INFO', 'WARN', 'ERROR', 'ERROR'];

Logger.destinations.default.write = (text, message) => {
  const level = LEVELS[message?.level ?? 1] ?? 'INFO';
  for (const line of String(text).split('\n')) if (line.trim()) process.stderr.write(`${level} ${line}\n`);
};
Logger.level = LogLevel(process.env.MATTER_LOG_LEVEL || 'NOTICE');
