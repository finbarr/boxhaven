// Test-only entry point. Production has no mock mode or CLI override.
const { startApp } = require('../src/main.cjs');
startApp({ cliPath: process.env.TEST_BH_CLI, userData: process.env.TEST_USER_DATA });
