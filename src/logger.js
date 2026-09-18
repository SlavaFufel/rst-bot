const LEVELS = ['debug', 'info', 'warn', 'error'];

function timestamp() {
  return new Date().toISOString();
}

function make(level) {
  return (...args) => {
    const prefix = `[${timestamp()}] ${level.toUpperCase()}`;
    if (level === 'error' || level === 'warn') console.error(prefix, ...args);
    else console.log(prefix, ...args);
  };
}

export const log = Object.freeze(
  Object.fromEntries(LEVELS.map((level) => [level, make(level)])),
);
