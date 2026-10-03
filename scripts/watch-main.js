const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const root = path.resolve(process.env.BOT_REPO_DIR || path.join(__dirname, '..'));
const interval = Math.max(10000, Number(process.env.DEPLOY_INTERVAL_MS) || 60000);
let stopping = false;
let child;
let timer;

function checkMain() {
    // Use the deployed version of the deployment script after the first release.
    let deployScript = path.join(__dirname, 'deploy.js');
    try {
        const state = JSON.parse(fs.readFileSync(path.join(root, '.deploy', 'state.json'), 'utf8'));
        const latestScript = path.join(state.releaseDir, 'scripts', 'deploy.js');
        if (fs.existsSync(latestScript)) deployScript = latestScript;
    } catch { /* First deployment. */ }
    child = execFile('flock', ['-n', path.join(root, '.deploy', 'deploy.lock'), process.execPath, deployScript], {
        cwd: root,
        env: { ...process.env, BOT_REPO_DIR: root },
        timeout: 300000,
        maxBuffer: 2 * 1024 * 1024
    }, error => {
        if (error) console.error(`Main deployment check failed (exit ${error.code}). It will retry in ${interval / 1000}s.`);
        child = null;
        if (!stopping) timer = setTimeout(checkMain, interval);
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
}

function shutdown() {
    stopping = true;
    clearTimeout(timer);
    // Let an active deployment finish instead of interrupting an install or rollback.
    if (!child) process.exit(0);
}

fs.mkdirSync(path.join(root, '.deploy'), { recursive: true });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Watching origin/main every ${interval / 1000}s for ${process.env.BOT_PM2_NAME || 'the-bot'}.`);
checkMain();
