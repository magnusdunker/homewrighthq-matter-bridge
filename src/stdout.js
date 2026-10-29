// Imported before anything else. stdout is the protocol with HomewrightHQ,
// so console output, also from dependencies while they load, goes to stderr,
// which is the integration's log. No imports here: they would run first.

const toStderr = (level) => (...a) => process.stderr.write(`${level} ${a.join(' ')}\n`);
console.log = console.info = toStderr('INFO');
console.debug = toStderr('DEBUG');
