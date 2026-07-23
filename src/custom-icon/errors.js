'use strict';

class CustomIconError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CustomIconError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

module.exports = { CustomIconError };
