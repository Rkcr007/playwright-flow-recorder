#!/usr/bin/env node
// What must never reach the recording file.
//
// A recording exists to be handed to an AI agent — often a hosted one, often by
// someone who never opens the JSONL. That makes a leak here silent and permanent,
// so the rules are worth pinning down:
//
//   • typed values are masked by field type/name, and `maskAllInput` masks them all
//     (the only defence when the field is called `j_idt42`);
//   • credential-bearing URL parameters are redacted — in the per-event `url` stamp,
//     in `nav` values, and in `net` query strings. A magic-link or SSO callback is an
//     ordinary thing to record, and the URL is stamped on EVERY event, so one such
//     landing page would otherwise repeat a live token down the whole file;
//   • compound parameter names count: access_token, id_token, X-Auth-Token, apiKey;
//   • ordinary words that merely contain a keyword do NOT: zipcode, monkey, keyword;
//   • the recordings directory git-ignores itself, because recording deliberately
//     works with no `init` and therefore without the project .gitignore entry.
//
//   node test/redaction-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { redactUrl } = require('../src/config');

const CDP_PORT = 9239;
const APP_PORT = 7791;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<h1>App</h1><div style="height:70px"></div>
  <input name="username" placeholder="user">
  <input name="password" type="password">
  <input name="j_idt42">
  <input name="apiKey">
  <button type="button" id="go">Go</button>
  <script>document.getElementById('go').onclick=()=>{
    fetch('/api/session?access_token=NETTOKEN_zzz&zipcode=94107');
  }</script>`;

const record = async ({ page, dir, cfg }) => {
  fs.writeFileSync(path.join(dir, 'flow-recorder.config.json'), JSON.stringify({ outDir: 'rec', ...cfg }));
  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--name', 'red'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  rec.stdout.on('data', (d) => (out += d));
  rec.stderr.on('data', (d) => (out += d));
  await sleep(3000);

  // An SSO callback: token in the query, token in the fragment (implicit grant).
  await page.goto(
    'http://localhost:' + APP_PORT +
      '/login?access_token=URLTOKEN_abc&code=AUTHCODE_xyz&zipcode=94107#id_token=FRAGTOKEN_qqq'
  );
  await sleep(500);
  await page.fill('#inp', 'sso login');
  await page.click('#rec');
  await sleep(400);
  await page.fill('[name=username]', 'jane@acme.com');
  await sleep(1100);
  await page.fill('[name=password]', 'Hunter2Real');
  await sleep(1100);
  await page.fill('[name=j_idt42]', 'SECRET_OBFUSCATED');
  await sleep(1100);
  await page.fill('[name=apiKey]', 'sk-live-DEADBEEF');
  await sleep(1100);
  await page.click('#go');
  await sleep(1200);
  await page.evaluate(() => history.pushState({}, '', '/dash?session=SESSIONID_99&monkey=banana'));
  await sleep(900);
  await page.click('#rec');
  await sleep(600);
  rec.kill('SIGINT');
  await sleep(700);
  const file = fs.readFileSync(path.join(dir, 'rec', 'latest.txt'), 'utf8').trim();
  return { body: fs.readFileSync(file, 'utf8'), out, dir };
};

let browser;
let app;
(async () => {
  app = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":1}');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => app.listen(APP_PORT, r));

  browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();

  const plain = await record({ page, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-red-')), cfg: {} });
  const strict = await record({
    page,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-redall-')),
    cfg: { maskAllInput: true },
  });

  await browser.close();
  app.close();

  const checks = {
    // --- typed values -----------------------------------------------------------
    'a type=password value never appears': !plain.body.includes('Hunter2Real'),
    'a value in a field named apiKey never appears': !plain.body.includes('sk-live-DEADBEEF'),
    'an ordinary field value is still recorded (conversion needs it)':
      plain.body.includes('jane@acme.com'),
    'by default an obfuscated field name (j_idt42) is NOT covered':
      plain.body.includes('SECRET_OBFUSCATED'),
    'maskAllInput covers the obfuscated field': !strict.body.includes('SECRET_OBFUSCATED'),
    'maskAllInput masks ordinary fields too': !strict.body.includes('jane@acme.com'),
    'maskAllInput is announced at startup': /every typed value is masked/.test(strict.out),

    // --- URLs -------------------------------------------------------------------
    'access_token in the page URL is redacted': !plain.body.includes('URLTOKEN_abc'),
    'an oauth code in the page URL is redacted': !plain.body.includes('AUTHCODE_xyz'),
    'id_token in the URL FRAGMENT is redacted (implicit grant)':
      !plain.body.includes('FRAGTOKEN_qqq'),
    'a session id pushed by an SPA route change is redacted':
      !plain.body.includes('SESSIONID_99'),
    'a token in an XHR query string is redacted': !plain.body.includes('NETTOKEN_zzz'),
    'the parameter NAMES survive, so the agent still sees the shape':
      plain.body.includes('access_token=***'),
    'a non-secret parameter is left alone (zipcode)': plain.body.includes('zipcode=94107'),
    'a word merely containing a keyword is left alone (monkey)':
      plain.body.includes('monkey=banana'),

    // --- the directory defends itself -------------------------------------------
    'the recordings dir git-ignores itself without `init`':
      fs.readFileSync(path.join(plain.dir, 'rec', '.gitignore'), 'utf8').includes('*'),
    'the privacy posture is stated at startup': /^Privacy:/m.test(plain.out),

    // --- redactUrl unit-level ----------------------------------------------------
    'redactUrl keeps a clean URL untouched':
      redactUrl('https://app.test/orders/42?page=2') === 'https://app.test/orders/42?page=2',
    'redactUrl strips userinfo passwords':
      !redactUrl('https://joe:s3cret@app.test/x').includes('s3cret'),
    'redactUrl handles a compound name (X-Auth-Token)':
      redactUrl('https://a.test/?X-Auth-Token=abc').includes('***'),
    'redactUrl falls back safely on a malformed URL':
      !redactUrl('not a url ?access_token=abc').includes('abc'),
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log('\n--- default run ---\n' + plain.body);
    console.log('\n--- maskAllInput run ---\n' + strict.body);
  }
  console.log(ok ? '\nREDACTION TEST PASSED' : '\nREDACTION TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  if (browser) await browser.close().catch(() => {});
  if (app) app.close();
  console.error('redaction test crashed: ' + e.message);
  process.exit(1);
});
