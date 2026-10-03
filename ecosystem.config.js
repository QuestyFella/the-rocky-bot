const path = require('path');
const releaseDir = process.env.BOT_RELEASE_DIR || __dirname;
const dataDir = process.env.BOT_DATA_DIR || __dirname;

module.exports = {
    apps: [{
        name: process.env.BOT_PM2_NAME || 'the-bot',
        script: path.join(releaseDir, 'bot.js'),
        cwd: releaseDir,
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        wait_ready: true,
        listen_timeout: 30000,
        kill_timeout: 5000,
        restart_delay: 5000,
        env: {
            NODE_ENV: 'production',
            BOT_DATA_DIR: dataDir,
            BOT_ENV_FILE: process.env.BOT_ENV_FILE || path.join(dataDir, '.env'),
            BOT_READY_FILE: process.env.BOT_READY_FILE || ''
        }
    }]
};
