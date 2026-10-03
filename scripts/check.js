const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const files = ['bot.js', 'taskStorage.js', 'ecosystem.config.js'];
for (const directory of ['commands', 'utils', 'scripts', 'test']) {
    if (fs.existsSync(path.join(root, directory))) {
        files.push(...fs.readdirSync(path.join(root, directory)).filter(file => file.endsWith('.js')).map(file => path.join(directory, file)));
    }
}
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Syntax checked ${files.length} files.`);
