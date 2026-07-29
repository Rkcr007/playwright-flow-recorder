#!/usr/bin/env node
// Start a Chrome that listens for CDP, using a DEDICATED profile directory.
//
//   flow-recorder chrome [--port <n>] [--profile <dir>] [--url <url>] [--chrome <path>]
//
// Why a dedicated profile: since Chrome 136, --remote-debugging-port is silently
// IGNORED when pointed at your default profile directory (it was an exfiltration
// vector). A separate --user-data-dir is therefore mandatory, not a preference.
// The profile persists, so you log into your app once and stay logged in across
// recording sessions.
//
// This is the single most common setup failure, which is why it's a command
// rather than a copy-paste snippet in the README.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { loadConfig, makeFlag } = require('./config');

const HELP = `
flow-recorder chrome — start a Chrome that the recorder can attach to

Usage
  flow-recorder chrome [options]

Options
  --port <n>        CDP port (default: config attachPort, 9222)
  --profile <dir>   Profile directory (default: ~/.flow-recorder-chrome-profile)
  --url <url>       Open this URL on start
  --chrome <path>   Explicit browser binary to use
  -h, --help        Show this help

Leave this browser open, then run \`flow-recorder record\` in another terminal.
`;

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ],
};

const onPath = (name) => {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    return out && fs.existsSync(out) ? out : null;
  } catch (_) {
    return null;
  }
};

// Last resort: Playwright's own bundled Chromium also speaks CDP.
const bundledChromium = () => {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const p = require(mod).chromium.executablePath();
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      /* not installed / not downloaded */
    }
  }
  return null;
};

const findChrome = (explicit) => {
  if (explicit && explicit !== true) {
    const p = String(explicit);
    if (!fs.existsSync(p)) throw new Error('No browser binary at ' + p);
    return p;
  }
  for (const p of CANDIDATES[process.platform] || []) if (p && fs.existsSync(p)) return p;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const p = onPath(n);
    if (p) return p;
  }
  return bundledChromium();
};

// GET http://127.0.0.1:<port>/json/version — the CDP handshake endpoint.
const cdpVersion = (port, timeoutMs = 1000) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForCdp = async (port, attempts = 30) => {
  for (let i = 0; i < attempts; i++) {
    const v = await cdpVersion(port);
    if (v) return v;
    await sleep(500);
  }
  return null;
};

const startChrome = async (argv = []) => {
  const flag = makeFlag(argv);
  if (flag('help', false) || argv.includes('-h')) {
    console.log(HELP.trim());
    return 0;
  }

  const loaded = loadConfig();
  const portFlag = flag('port', null);
  const port = Number(portFlag && portFlag !== true ? portFlag : loaded.cfg.attachPort) || 9222;
  const profileFlag = flag('profile', null);
  const profile =
    profileFlag && profileFlag !== true ? path.resolve(process.cwd(), String(profileFlag)) : loaded.chromeProfileDir;
  const urlFlag = flag('url', null);
  const url = urlFlag && urlFlag !== true ? String(urlFlag) : loaded.cfg.startUrl || null;

  const already = await cdpVersion(port);
  if (already) {
    console.log('A browser is already listening on CDP port ' + port + ':');
    console.log('  ' + (already.Browser || 'unknown'));
    console.log('\nNothing to do — run `flow-recorder record` to attach.');
    return 0;
  }

  const bin = findChrome(flag('chrome', loaded.cfg.chromePath || null));
  if (!bin) {
    console.error('Could not find a Chrome/Chromium/Edge binary on this machine.');
    console.error('Options:');
    console.error('  • pass one explicitly:  flow-recorder chrome --chrome "/path/to/chrome"');
    console.error('  • set `chromePath` in your flow-recorder config');
    console.error('  • or skip attach mode:  flow-recorder record --launch   (starts logged OUT)');
    return 1;
  }

  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    // Keeps the process alive even if the user closes the last tab by accident.
    '--restore-last-session',
  ];
  if (url) args.push(url);

  console.log('Launching: ' + path.basename(bin));
  console.log('  CDP port: ' + port);
  console.log('  Profile:  ' + profile + (fs.readdirSync(profile).length ? '  (existing — logins preserved)' : '  (new)'));

  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const v = await waitForCdp(port);
  if (!v) {
    console.error('\nThe browser started but never answered on CDP port ' + port + '.');
    console.error('Most likely another process holds that port. Try a different one:');
    console.error('  flow-recorder chrome --port 9333   &&   flow-recorder record --attach 9333');
    return 1;
  }

  console.log('\nReady: ' + (v.Browser || 'browser') + ' on port ' + port + '.');
  console.log('Log into your app in this window, then in another terminal run:');
  console.log('    flow-recorder record' + (port !== 9222 ? ' --attach ' + port : ''));
  return 0;
};

module.exports = { startChrome, findChrome, cdpVersion, waitForCdp, HELP };

if (require.main === module) {
  startChrome(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('flow-recorder chrome failed: ' + e.message);
      process.exit(1);
    });
}
