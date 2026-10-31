// Tests run under Node, where the Workers runtime module doesn't exist.
// Code that reads `env` at import time gets an empty environment.
export const env = {};
