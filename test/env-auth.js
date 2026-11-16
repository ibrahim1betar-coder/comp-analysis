// Must be the first import of auth.test.js: static imports are hoisted, so env has to be set in a module of its own.
process.env.AUTH_DISABLED = '0';
process.env.ADMIN_PASSWORD = 'first-admin-pw';
