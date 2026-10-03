const path = require('path');

// Releases share the original installation's data and .env file.
const dataDir = path.resolve(process.env.BOT_DATA_DIR || path.join(__dirname, '..'));

module.exports = { dataDir, dataPath: (...parts) => path.join(dataDir, ...parts) };
