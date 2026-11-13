#!/usr/bin/env node
/**
 * npm run lint — syntax-check every server-side file, then lint the console (ESLint, zero warnings allowed).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dirs = ['src', 'scripts', 'tests', 'cli', 'intercept', 'sdk', 'sag-mcp-proxy', '.'];
const skip = new Set(['node_modules', 'console', '.git', 'certs', 'dist']);
const files = [];
function walk(dir, depth) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); }
        else if (/\.(js|cjs)$/.test(e.name)) files.push(full);
    }
}
for (const d of dirs) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    if (d === '.') for (const e of fs.readdirSync(full)) { if (/\.(js|cjs)$/.test(e)) files.push(path.join(full, e)); }
    else walk(full, 0);
}
let bad = 0;
for (const f of [...new Set(files)]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad += 1; console.error(`✗ ${path.relative(root, f)}\n${r.stderr}`); }
}
console.log(`${files.length} server-side files syntax-checked, ${bad} problem${bad === 1 ? '' : 's'}.`);
if (bad) process.exit(1);
const c = spawnSync('npm', ['--prefix', 'console', 'run', 'lint', '--silent'], { cwd: root, stdio: 'inherit' });
if (c.status !== 0) process.exit(c.status || 1);
console.log('console: ESLint clean.');
