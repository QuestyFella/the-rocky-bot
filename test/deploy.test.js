const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { deployMain, waitForReady } = require('../scripts/deploy');

function fixture(t) {
    const temporaryDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-deploy-')));
    const root = path.join(temporaryDir, 'repo');
    const origin = path.join(temporaryDir, 'origin.git');
    const bin = path.join(temporaryDir, 'bin');
    fs.mkdirSync(root);
    fs.mkdirSync(bin);
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Deployment Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'server-configs'));
    fs.mkdirSync(path.join(root, 'server-tasks'));
    fs.copyFileSync(path.join(__dirname, '..', 'ecosystem.config.js'), path.join(root, 'ecosystem.config.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'deploy.js'), path.join(root, 'scripts', 'deploy.js'));
    fs.writeFileSync(path.join(root, 'bot.js'), '// test bot\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'node_modules', 'old.js'), '// tracked legacy dependency');
    for (const file of ['.env', 'server-configs/guild.json', 'server-tasks/guild.json', 'kanbanBoards.json']) fs.writeFileSync(path.join(root, file), 'original data');
    git(['add', '.']);
    git(['commit', '-m', 'Test deployment source']);
    git(['init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', 'origin', 'main']);
    for (const file of ['.env', 'server-configs/guild.json', 'server-tasks/guild.json', 'kanbanBoards.json']) fs.writeFileSync(path.join(root, file), 'live data');
    const statePath = path.join(temporaryDir, 'pm2.json');
    const callsPath = path.join(temporaryDir, 'calls.jsonl');
    fs.writeFileSync(statePath, JSON.stringify([{ name: 'the-bot', pid: 77, pm2_env: { status: 'online', pm_cwd: root, pm_exec_path: path.join(root, 'bot.js'), exec_interpreter: process.execPath } }]));
    const npmScript = `#!${process.execPath}\nconst fs=require('fs'); fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(['npm',...process.argv.slice(2)])+'\\n'); if(process.env.FAKE_INSTALL_FAIL==='yes')process.exit(1);\n`;
    const pm2Script = `#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(['pm2',...args])+'\\n');
if(args[0]==='jlist')console.log(fs.readFileSync(process.env.FAKE_PM2,'utf8'));
if(args[0]==='delete')fs.writeFileSync(process.env.FAKE_PM2,'[]');
if(args[0]==='startOrRestart'){
    const app=require(args[1]).apps[0];
    const p={name:app.name,pid:88,pm2_env:{status:'online',pm_cwd:app.cwd,pm_exec_path:app.script,exec_interpreter:process.execPath,...app.env}};
    fs.writeFileSync(process.env.FAKE_PM2,JSON.stringify([p]));
    if(process.env.FAKE_RESTART_FAIL==='yes'&&!args[1].includes('rollback'))process.exit(1);
    if(app.env.BOT_READY_FILE)fs.writeFileSync(app.env.BOT_READY_FILE,JSON.stringify({pid:p.pid}));
}
`;
    fs.writeFileSync(path.join(bin, 'npm'), npmScript, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'pm2'), pm2Script, { mode: 0o755 });
    const previousEnv = { PATH: process.env.PATH, FAKE_PM2: process.env.FAKE_PM2, FAKE_CALLS: process.env.FAKE_CALLS, FAKE_INSTALL_FAIL: process.env.FAKE_INSTALL_FAIL, FAKE_RESTART_FAIL: process.env.FAKE_RESTART_FAIL };
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_PM2: statePath, FAKE_CALLS: callsPath });
    delete process.env.FAKE_INSTALL_FAIL;
    delete process.env.FAKE_RESTART_FAIL;
    t.after(() => {
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    });
    return { root, statePath, callsPath, calls: () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('main deploy builds a separate release, preserves live data, confirms login, and skips unchanged commits', async t => {
    const f = fixture(t);
    const result = await deployMain({ root: f.root });
    assert.equal(result.changed, true);
    assert.notEqual(result.releaseDir, f.root);
    for (const file of ['.env', 'server-configs/guild.json', 'server-tasks/guild.json', 'kanbanBoards.json']) {
        assert.equal(fs.readFileSync(path.join(f.root, file), 'utf8'), 'live data');
        assert.equal(fs.existsSync(path.join(result.releaseDir, file)), false);
    }
    assert.equal(fs.existsSync(path.join(result.releaseDir, 'node_modules', 'old.js')), false);
    assert.deepEqual(f.calls().filter(call => call[0] === 'npm').map(call => call.slice(1)), [['ci', '--omit=dev', '--no-audit', '--no-fund'], ['run', 'check'], ['test']]);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath))[0].pm2_env.BOT_DATA_DIR, f.root);
    assert.ok(f.calls().some(call => call[0] === 'pm2' && call[1] === 'delete' && call[2] === 'the-bot'));
    const before = f.calls().filter(call => call[1] === 'startOrRestart').length;
    assert.equal((await deployMain({ root: f.root })).changed, false);
    assert.equal(f.calls().filter(call => call[1] === 'startOrRestart').length, before);
});

test('failed preparation leaves the existing PM2 process running', async t => {
    const f = fixture(t);
    process.env.FAKE_INSTALL_FAIL = 'yes';
    await assert.rejects(deployMain({ root: f.root }));
    assert.equal(JSON.parse(fs.readFileSync(f.statePath))[0].pid, 77);
    assert.equal(f.calls().some(call => call[1] === 'startOrRestart'), false);
    assert.equal(fs.existsSync(path.join(f.root, '.deploy', 'state.json')), false);
});

test('a failed PM2 restart restores the original script and leaves deployment state uncommitted', async t => {
    const f = fixture(t);
    process.env.FAKE_RESTART_FAIL = 'yes';
    await assert.rejects(deployMain({ root: f.root }));
    const current = JSON.parse(fs.readFileSync(f.statePath))[0];
    assert.equal(current.pm2_env.pm_exec_path, path.join(f.root, 'bot.js'));
    assert.equal(current.pm2_env.pm_cwd, f.root);
    assert.equal(fs.existsSync(path.join(f.root, '.deploy', 'state.json')), false);
    assert.equal(f.calls().filter(call => call[1] === 'startOrRestart').length, 2);
});

test('readiness requires the current PM2 PID rather than a stale ready file', async t => {
    const f = fixture(t);
    const readyFile = path.join(f.root, 'ready.json');
    fs.writeFileSync(readyFile, JSON.stringify({ pid: 76 }));
    await assert.rejects(waitForReady('the-bot', readyFile, 10), /did not log in/);
    fs.writeFileSync(readyFile, JSON.stringify({ pid: 77 }));
    await waitForReady('the-bot', readyFile, 1000);
});
