const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const excludedEntries = new Set(['node_modules', 'server-configs', 'server-tasks', 'kanbanBoards.json', 'jiraBoards.json', '.env', '.DS_Store']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(command, args, options = {}) {
    return execFileSync(command, args, { timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options });
}

function pm2Process(name) {
    const processes = JSON.parse(run('pm2', ['jlist'], { encoding: 'utf8' }));
    return processes.find(process => process.name === name);
}

async function waitForReady(name, readyFile, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const process = pm2Process(name);
        let ready;
        try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch { /* Not ready yet. */ }
        if (process?.pm2_env.status === 'online' && process.pid && ready?.pid === process.pid) return;
        await sleep(Math.max(1, Math.min(1000, deadline - Date.now())));
    }
    throw new Error(`PM2 process ${name} did not log in to Discord within ${timeoutMs / 1000} seconds.`);
}

function applyConfig(configPath, name, root, releaseDir, readyFile) {
    const existing = pm2Process(name);
    // PM2 can retain pm_exec_path and pm_cwd on startOrRestart. Replace this
    // named process when changing releases so it actually runs the new files.
    if (existing && (existing.pm2_env.pm_exec_path !== path.join(releaseDir, 'bot.js') || existing.pm2_env.pm_cwd !== releaseDir)) {
        run('pm2', ['delete', name], { stdio: 'inherit' });
    }
    run('pm2', ['startOrRestart', configPath, '--only', name, '--update-env'], {
        stdio: 'inherit',
        env: { ...process.env, BOT_PM2_NAME: name, BOT_RELEASE_DIR: releaseDir, BOT_DATA_DIR: root, BOT_ENV_FILE: path.join(root, '.env'), BOT_READY_FILE: readyFile }
    });
}

async function deployMain({ root = process.env.BOT_REPO_DIR || path.join(__dirname, '..'), name = process.env.BOT_PM2_NAME || 'the-bot' } = {}) {
    root = fs.realpathSync(root);
    const deployDir = path.join(root, '.deploy');
    const releasesDir = path.join(deployDir, 'releases');
    const stateFile = path.join(deployDir, 'state.json');
    fs.mkdirSync(releasesDir, { recursive: true });
    run('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: root });
    const sha = run('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: root, encoding: 'utf8' }).trim();
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* First deployment. */ }
    const previous = pm2Process(name);
    if (state?.sha === sha && previous?.pm2_env.status === 'online' && previous.pm2_env.pm_cwd === state.releaseDir) return { changed: false, sha };

    // An old main cannot replace a newer Kanban installation until the deployment code is merged.
    run('git', ['cat-file', '-e', `${sha}:scripts/deploy.js`], { cwd: root });
    run('git', ['cat-file', '-e', `${sha}:ecosystem.config.js`], { cwd: root });
    const entries = run('git', ['ls-tree', '--name-only', sha], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(entry => entry && !excludedEntries.has(entry));
    const releaseDir = fs.mkdtempSync(path.join(releasesDir, `${sha.slice(0, 12)}-`));
    const archive = run('git', ['archive', '--format=tar', sha, '--', ...entries], { cwd: root });
    run('tar', ['-xf', '-', '-C', releaseDir], { input: archive });
    const readyFile = path.join(releaseDir, '.ready.json');
    let switched = false;
    try {
        console.log(`Preparing main ${sha.slice(0, 12)}.`);
        run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: releaseDir, stdio: 'inherit' });
        // Tests use temporary storage and never open the production .env file.
        run('npm', ['run', 'check'], { cwd: releaseDir, stdio: 'inherit' });
        run('npm', ['test'], { cwd: releaseDir, stdio: 'inherit' });
        switched = true;
        applyConfig(path.join(releaseDir, 'ecosystem.config.js'), name, root, releaseDir, readyFile);
        await waitForReady(name, readyFile);
        const temporaryState = `${stateFile}.tmp`;
        fs.writeFileSync(temporaryState, JSON.stringify({ sha, releaseDir, name, deployedAt: new Date().toISOString() }, null, 2));
        fs.renameSync(temporaryState, stateFile);
        run('pm2', ['save'], { stdio: 'inherit' });
        // Only delete releases created by this script; retain this and the preceding installation.
        const keep = new Set([releaseDir, previous?.pm2_env.pm_cwd]);
        for (const entry of fs.readdirSync(releasesDir, { withFileTypes: true })) {
            const candidate = path.join(releasesDir, entry.name);
            if (entry.isDirectory() && /^[a-f0-9]{12}-[A-Za-z0-9]+$/.test(entry.name) && !keep.has(candidate)) fs.rmSync(candidate, { recursive: true });
        }
        console.log(`Deployed ${sha.slice(0, 12)}; Discord login confirmed.`);
        return { changed: true, sha, releaseDir };
    } catch (error) {
        if (switched && previous) {
            console.error('Deployment failed. Restoring the preceding PM2 script.');
            const rollbackConfig = path.join(deployDir, 'rollback.config.js');
            fs.writeFileSync(rollbackConfig, `module.exports = ${JSON.stringify({ apps: [{ name, script: previous.pm2_env.pm_exec_path, cwd: previous.pm2_env.pm_cwd, interpreter: previous.pm2_env.exec_interpreter, instances: 1, exec_mode: 'fork', watch: false, wait_ready: false, env: { BOT_DATA_DIR: root, BOT_ENV_FILE: path.join(root, '.env'), BOT_READY_FILE: previous.pm2_env.BOT_READY_FILE || '' } }] })};\n`);
            applyConfig(rollbackConfig, name, root, previous.pm2_env.pm_cwd, previous.pm2_env.BOT_READY_FILE || '');
        }
        throw error;
    }
}

if (require.main === module) {
    deployMain().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { deployMain, waitForReady, excludedEntries };
