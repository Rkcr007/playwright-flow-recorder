#!/usr/bin/env node
// Config resolution is the portability seam — if it misbehaves, the recorder
// silently reads the wrong project's conventions. No browser needed.
//
//   node test/config-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, deepMerge, pageConfig, validateConventions, DEFAULTS } = require('../src/config');

const checks = {};
const check = (label, fn) => {
  try {
    checks[label] = fn() === true;
  } catch (e) {
    checks[label] = false;
    console.log('  (' + label + ' threw: ' + e.message + ')');
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-cfg-'));
const mk = (rel, contents) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return p;
};

// --- 1. zero config: everything falls back to defaults ----------------------
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-bare-'));
const zero = loadConfig({ cwd: bare });
check('no config file → defaults, configFile is null', () =>
  zero.configFile === null && zero.cfg.attachPort === DEFAULTS.attachPort && zero.projectRoot === path.resolve(bare)
);
check('no config file → outDir resolved under cwd', () =>
  zero.outDir === path.resolve(bare, DEFAULTS.outDir)
);

// --- 2. discovery walks UP from a nested directory ---------------------------
mk('flow-recorder.config.json', {
  attachPort: 4321,
  conventions: { framework: 'cucumber-playwright', stepLibrary: ['steps'], primaryStepFile: 'common.js' },
});
mk('steps/common.js', 'Given("user is on web app", () => {});\n');
fs.mkdirSync(path.join(tmp, 'a/b/c'), { recursive: true });

const nested = loadConfig({ cwd: path.join(tmp, 'a/b/c') });
check('config found by walking up from a subdirectory', () => nested.configFile === path.join(tmp, 'flow-recorder.config.json'));
check('projectRoot is the config directory, not the cwd', () => nested.projectRoot === path.resolve(tmp));
check('file values override defaults', () => nested.cfg.attachPort === 4321);
check('unspecified keys keep their defaults', () => nested.cfg.outDir === DEFAULTS.outDir);
check('relative paths resolve against projectRoot', () => nested.outDir === path.resolve(tmp, DEFAULTS.outDir));
check('conventions from file are present', () => nested.cfg.conventions.primaryStepFile === 'common.js');
check('conventions defaults survive a partial conventions block', () =>
  Array.isArray(nested.cfg.conventions.tags) && nested.cfg.conventions.tags.includes('@recorded')
);

// --- 3. local override is deep-merged, not clobbering ------------------------
mk('flow-recorder.config.local.json', { attachPort: 9999, conventions: { framework: 'playwright-test' } });
const withLocal = loadConfig({ cwd: tmp });
check('local override wins over the shared config', () => withLocal.cfg.attachPort === 9999);
check('local override does NOT wipe sibling conventions keys', () =>
  withLocal.cfg.conventions.framework === 'playwright-test' &&
  withLocal.cfg.conventions.primaryStepFile === 'common.js' &&
  withLocal.cfg.conventions.stepLibrary.length === 1
);
check('localConfigFile is reported', () => withLocal.localConfigFile === path.join(tmp, 'flow-recorder.config.local.json'));

// --- 4. CLI overrides beat everything --------------------------------------
const withFlag = loadConfig({ cwd: tmp, overrides: { attachPort: 1234 } });
check('CLI override beats local + file', () => withFlag.cfg.attachPort === 1234);
const withHoles = loadConfig({ cwd: tmp, overrides: { attachPort: undefined, startUrl: undefined } });
check('undefined overrides are ignored, not applied as undefined', () => withHoles.cfg.attachPort === 9999);

// --- 5. package.json key discovery -----------------------------------------
const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-pkg-'));
fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify({ name: 'demo', 'flow-recorder': { attachPort: 7777 } }, null, 2)
);
const fromPkg = loadConfig({ cwd: pkgDir });
check('config read from the package.json "flow-recorder" key', () =>
  fromPkg.cfg.attachPort === 7777 && fromPkg.configSource === 'package.json#flow-recorder'
);

// A package.json WITHOUT the key must not be mistaken for a config file.
const pkgNoKey = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-nokey-'));
fs.writeFileSync(path.join(pkgNoKey, 'package.json'), JSON.stringify({ name: 'demo' }));
check('package.json without the key is not treated as config', () => loadConfig({ cwd: pkgNoKey }).configFile === null);

// --- 6. dedicated file beats package.json in the same directory -------------
fs.writeFileSync(path.join(pkgDir, '.flow-recorder.json'), JSON.stringify({ attachPort: 8888 }));
check('dedicated config file takes precedence over the package.json key', () =>
  loadConfig({ cwd: pkgDir }).cfg.attachPort === 8888
);

// --- 7. ~ expansion for the Chrome profile ---------------------------------
check('~ in chromeProfileDir expands to the home directory', () =>
  loadConfig({ cwd: bare }).chromeProfileDir === path.join(os.homedir(), '.flow-recorder-chrome-profile')
);

// --- 8. convention path validation ----------------------------------------
const goodIssues = validateConventions(loadConfig({ cwd: tmp }));
check('validateConventions passes when paths exist', () => goodIssues.length === 0);

const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-broken-'));
fs.writeFileSync(
  path.join(brokenDir, 'flow-recorder.config.json'),
  JSON.stringify({ conventions: { stepLibrary: ['nope/steps'], locatorFiles: { default: 'gone.json' } } })
);
const badIssues = validateConventions(loadConfig({ cwd: brokenDir }));
check('validateConventions reports each missing path', () =>
  badIssues.length === 2 &&
  badIssues.some((i) => i.label === 'conventions.stepLibrary[0]') &&
  badIssues.some((i) => i.label === 'conventions.locatorFiles.default')
);

// --- 9. malformed JSON fails loudly, naming the file -----------------------
const badJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-badjson-'));
fs.writeFileSync(path.join(badJsonDir, 'flow-recorder.config.json'), '{ "attachPort": 1, }');
check('malformed config throws an error naming the file', () => {
  try {
    loadConfig({ cwd: badJsonDir });
    return false;
  } catch (e) {
    return e.message.includes('flow-recorder.config.json');
  }
});

// --- 10. deepMerge semantics ----------------------------------------------
check('deepMerge replaces arrays wholesale', () =>
  JSON.stringify(deepMerge({ a: [1, 2, 3] }, { a: [9] }).a) === '[9]'
);
check('deepMerge recurses into nested objects', () =>
  deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }).a.b === 1
);

// --- 11. pageConfig is the small, serialisable subset ----------------------
const pc = pageConfig(loadConfig({ cwd: bare }).cfg);
check('pageConfig exposes only the masking/redaction/debounce/agentName subset', () =>
  JSON.stringify(Object.keys(pc).sort()) ===
  '["agentName","maskAllInput","maskPattern","redactUrlParams","typeDebounceMs"]'
);
check('pageConfig maskPattern is a usable regex source', () => new RegExp(pc.maskPattern, 'i').test('cardNumber'));
check('pageConfig redactUrlParams is a usable regex source', () =>
  new RegExp('^(?:' + pc.redactUrlParams + ')$', 'i').test('token')
);
// The page-side script mirrors these two patterns; a default that cannot compile
// there would silently fall back and stop masking what the config asked for.
check('maskPattern spares "author" but catches "auth"', () => {
  const re = new RegExp(DEFAULTS.maskPattern, 'i');
  return re.test('authToken') && !re.test('author');
});

// --- report ---------------------------------------------------------------
let ok = true;
for (const [label, pass] of Object.entries(checks)) {
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
  if (!pass) ok = false;
}
console.log(ok ? '\nCONFIG TEST PASSED (' + Object.keys(checks).length + ' checks)' : '\nCONFIG TEST FAILED');
process.exit(ok ? 0 : 1);
