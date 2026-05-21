import { spawn } from 'node:child_process';

const nodePath = process.execPath;
const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
const bridge = spawn(nodePath, ['scripts/sellersprite-bridge.mjs'], { stdio: 'inherit' });
const vite = spawn(nodePath, [viteBin.pathname, ...process.argv.slice(2)], { stdio: 'inherit' });

function stopChildren(signal = 'SIGTERM') {
  bridge.kill(signal);
  vite.kill(signal);
}

bridge.on('exit', (code) => {
  if (code && !vite.killed) {
    console.error(`[dev] 卖家精灵桥接已退出，code=${code}`);
  }
});

vite.on('exit', (code) => {
  stopChildren();
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  stopChildren('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopChildren();
  process.exit(0);
});
