const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const configPath = path.join(root, 'src', 'Config.js');

const src = fs.readFileSync(configPath, 'utf8');
const updated = src.replace(/APP_VERSION:\s*'[^']*'/, "APP_VERSION: '" + version + "'");
if (updated === src && !src.includes("APP_VERSION: '" + version + "'")) {
  console.error('[sync-version] Config.js에서 APP_VERSION 항목을 찾지 못했습니다.');
  process.exit(1);
}
fs.writeFileSync(configPath, updated);
console.log('[sync-version] Config.APP_VERSION = ' + version);
