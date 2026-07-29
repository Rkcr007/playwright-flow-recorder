// Configuration discovery and resolution.
//
// Everything has a working default, so the recorder runs with NO config file at
// all. A config file only becomes necessary when you want the AI converter to
// know about *your* framework (where step definitions and locators live).
//
// Lookup order — walks up from the current directory to the filesystem root,
// first hit wins:
//   1. flow-recorder.config.json
//   2. .flow-recorder.json
//   3. package.json  →  "flow-recorder": { ... }
//
// The directory containing the winning file is the PROJECT ROOT: every relative
// path in the config resolves against it, so commands work from any subdirectory.
//
// A per-user override file next to it is deep-merged on top and should never be
// committed (ports, profile paths, userMode):
//   flow-recorder.config.local.json  |  .flow-recorder.local.json
//
// Precedence: CLI flag  >  local override  >  config file  >  built-in default.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_NAMES = ['flow-recorder.config.json', '.flow-recorder.json'];
const LOCAL_NAMES = ['flow-recorder.config.local.json', '.flow-recorder.local.json'];
const PACKAGE_KEY = 'flow-recorder';

const DEFAULTS = {
  // --- recorder runtime ---
  attachPort: 9222,
  startUrl: '',
  outDir: '.flow-recorder/recordings',
  indexFile: '.flow-recorder/step-index.json',
  chromeProfileDir: '~/.flow-recorder-chrome-profile',
  chromePath: '',
  // --- capture behaviour ---
  maskPattern: 'pass|pwd|otp|pin|secret|token|cvv|card.?number',
  typeDebounceMs: 900,
  captureNetwork: true,
  // --- agent / conversion ---
  userMode: 'expert', // 'expert' | 'guided'
  agentName: 'the AI agent',
  // Command run when the user clicks ⚡, so the queue actually reaches an agent
  // instead of waiting for one to notice the file. OPT-IN: empty means nothing is
  // ever spawned. String → run through the shell (quotes and pipes work); array →
  // spawned directly with no shell. Context arrives as FLOW_* env vars, never as
  // string interpolation. See runCreateHook in recorder.js.
  onCreate: '',
  conventions: {
    framework: 'generic', // cucumber-playwright | playwright-test | codeceptjs | cypress | generic
    featureDir: 'features',
    stepLibrary: [],
    primaryStepFile: '',
    locatorFiles: {},
    testDataFiles: [],
    scenarioOpener: '',
    dryRunCommand: '',
    tags: ['@recorded', '@wip'],
    notes: '',
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Deep merge, arrays replaced wholesale (predictable for config: a local
// override that lists two step dirs means exactly those two, not four).
const deepMerge = (base, patch) => {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
};

const expandHome = (p) =>
  typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error('Could not parse ' + file + ': ' + e.message);
    err.configFile = file;
    throw err;
  }
};

// Walk up from `startDir` looking for any recognised config file.
const findConfig = (startDir) => {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return { file: p, root: dir, source: name };
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      } catch (_) {
        parsed = null; // a broken package.json is not our problem; keep walking
      }
      if (parsed && isObj(parsed[PACKAGE_KEY])) {
        return { file: pkg, root: dir, source: 'package.json#' + PACKAGE_KEY, inPackage: true };
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
};

const findLocal = (dirs) => {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of LOCAL_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};

/**
 * Build a fully-resolved config.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.cwd]       directory to start the search from
 * @param {object}   [opts.overrides] CLI flags — highest precedence
 * @returns {{
 *   cfg: object, configFile: string|null, localConfigFile: string|null,
 *   configSource: string|null, projectRoot: string,
 *   outDir: string, indexFile: string, chromeProfileDir: string,
 *   resolve: (p: string) => string
 * }}
 */
const loadConfig = (opts = {}) => {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const found = findConfig(cwd);

  let fileCfg = {};
  if (found) {
    const raw = readJson(found.file);
    fileCfg = found.inPackage ? raw[PACKAGE_KEY] : raw;
    if (!isObj(fileCfg)) fileCfg = {};
  }

  const projectRoot = found ? found.root : cwd;
  const localFile = findLocal([projectRoot, cwd]);
  const localCfg = localFile ? readJson(localFile) : {};

  let cfg = deepMerge(DEFAULTS, fileCfg);
  cfg = deepMerge(cfg, localCfg);

  // CLI flags last. `undefined` entries are ignored by deepMerge, so callers can
  // pass a flag object with holes in it.
  cfg = deepMerge(cfg, opts.overrides || {});

  // Relative paths resolve against the project root; absolute ones pass through.
  const resolve = (p) => (p ? path.resolve(projectRoot, expandHome(p)) : p);

  return {
    cfg,
    configFile: found ? found.file : null,
    configSource: found ? found.source : null,
    localConfigFile: localFile,
    projectRoot,
    outDir: resolve(cfg.outDir),
    indexFile: resolve(cfg.indexFile),
    chromeProfileDir: path.resolve(expandHome(cfg.chromeProfileDir)),
    resolve,
  };
};

// Minimal flag parser shared by every command.
//   flag('port', 9222)   → --port 3000
//   flag('headless')     → --headless           (true when present with no value)
const makeFlag = (argv) => (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || String(v).startsWith('--') ? true : v;
};

// The subset of config handed to the in-page script. Keep it small and
// serialisable — it is injected as JSON into every page.
const pageConfig = (cfg) => ({
  maskPattern: cfg.maskPattern || DEFAULTS.maskPattern,
  typeDebounceMs: Number(cfg.typeDebounceMs) || DEFAULTS.typeDebounceMs,
  agentName: cfg.agentName || DEFAULTS.agentName,
});

/**
 * Check that configured convention INPUT paths actually exist. Used by `doctor`
 * and by `index`, because a stepLibrary pointing at a directory that was renamed
 * is the single most common reason conversion silently stops reusing steps: the
 * index comes back empty and the agent writes every step from scratch.
 *
 * Only inputs are checked. `featureDir` is an OUTPUT location — a project that
 * has not written its first feature file yet is perfectly valid, so its absence
 * is not an issue.
 */
const validateConventions = (loaded) => {
  const conv = loaded.cfg.conventions || {};
  const issues = [];
  const check = (label, rel) => {
    if (!rel) return;
    const abs = loaded.resolve(rel);
    if (!fs.existsSync(abs)) issues.push({ label, value: rel, abs });
  };
  (conv.stepLibrary || []).forEach((s, i) => check('conventions.stepLibrary[' + i + ']', s));
  for (const [k, v] of Object.entries(conv.locatorFiles || {})) check('conventions.locatorFiles.' + k, v);
  return issues;
};

module.exports = {
  CONFIG_NAMES,
  LOCAL_NAMES,
  PACKAGE_KEY,
  DEFAULTS,
  deepMerge,
  expandHome,
  findConfig,
  loadConfig,
  makeFlag,
  pageConfig,
  validateConventions,
};
