#!/usr/bin/env node
// Builds a REUSE INDEX of the step definitions and locators that already exist in
// your project, so the AI converter matches a recording against what you have
// instead of inventing duplicates.
//
//   flow-recorder index [--steps <substr>[,<substr>]] [--env <locatorKey>] [--out <file>]
//
// --steps  narrows which step files are indexed (matched against file names).
//          Files listed in `conventions.primaryStepFile` are ALWAYS included.
// --env    limits the locator index to one key from `conventions.locatorFiles`.
//
// Scoping matters: an index of 140 steps from 3 relevant files converts far more
// accurately than 400 steps from 17 files, because the agent can actually read it.
//
// Output: `indexFile` from config (default .flow-recorder/step-index.json)

const fs = require('fs');
const path = require('path');
const { loadConfig, makeFlag, validateConventions } = require('./config');

const STEP_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.flow-recorder']);

const HELP = `
flow-recorder index — build the reuse index of existing steps and locators

Usage
  flow-recorder index [options]

Options
  --steps <a,b>   Only index step files whose name contains one of these substrings
                  (conventions.primaryStepFile is always included)
  --env <key>     Only index this key from conventions.locatorFiles
  --out <file>    Write the index here (default: config indexFile)
  -h, --help      Show this help

Requires a config file describing your project. Create one with:  flow-recorder init
`;

// Recursive walk, skipping vendor/build dirs. Cucumber projects commonly nest
// step definitions (features/step_definitions/<domain>/*.js), which a flat
// readdir would miss entirely.
const walkStepFiles = (dir, depth = 0, acc = []) => {
  if (depth > 6) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkStepFiles(full, depth + 1, acc);
    } else if (STEP_EXTS.includes(path.extname(e.name)) && !/\.d\.ts$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
};

// Accept locatorFiles as an object, an array, or a single string.
const normaliseLocatorFiles = (v) => {
  if (!v) return {};
  if (typeof v === 'string') return { default: v };
  if (Array.isArray(v)) {
    const out = {};
    v.forEach((f, i) => {
      out[path.basename(String(f), '.json') || 'set' + i] = f;
    });
    return out;
  }
  return v;
};

const buildIndex = (argv = []) => {
  const flag = makeFlag(argv);
  if (flag('help', false) || argv.includes('-h')) {
    console.log(HELP.trim());
    return 0;
  }

  const envOnly = flag('env', null);
  const stepFilter = flag('steps', null);
  const loaded = loadConfig();
  const conv = loaded.cfg.conventions || {};

  if (!loaded.configFile) {
    console.error('No flow-recorder config found (searched up from ' + process.cwd() + ').');
    console.error('The reuse index needs to know where your steps and locators live.');
    console.error('Create one with:  flow-recorder init');
    return 1;
  }

  const issues = validateConventions(loaded);
  for (const i of issues) console.error('WARN  ' + i.label + ' does not exist: ' + i.value);

  // --- collect step definition files ---
  const found = [];
  for (const entry of conv.stepLibrary || []) {
    const p = loaded.resolve(entry);
    if (!p || !fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) found.push(...walkStepFiles(p));
    else found.push(p);
  }

  // `primaryStepFile` is the shared library that must survive any --steps filter.
  // Matched by basename substring OR path suffix, so both "predefined" and
  // "features/steps/common.js" work.
  const primaries = (Array.isArray(conv.primaryStepFile) ? conv.primaryStepFile : [conv.primaryStepFile])
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  const isPrimary = (file) => {
    const lower = file.toLowerCase();
    const base = path.basename(lower);
    return primaries.some((p) => base.includes(p) || lower.endsWith(p));
  };

  const stepFiles = stepFilter
    ? found.filter((f) => {
        if (isPrimary(f)) return true;
        const base = path.basename(f).toLowerCase();
        return String(stepFilter)
          .toLowerCase()
          .split(',')
          .some((s) => s.trim() && base.includes(s.trim()));
      })
    : found;

  // --- extract step patterns (string and regex styles, all Cucumber keywords) ---
  const steps = [];
  const KEYWORDS = '(?:Given|When|Then|And|But|defineStep|Step)';
  for (const file of [...new Set(stepFiles)]) {
    let src = '';
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const rel = path.relative(loaded.projectRoot, file);
    // Fresh regexes per file: a shared /g regex carries lastIndex between files.
    const stringDef = new RegExp(KEYWORDS + "\\s*\\(\\s*(['\"`])((?:\\\\\\1|.)*?)\\1", 'g');
    const regexDef = new RegExp(KEYWORDS + '\\s*\\(\\s*\\/((?:\\\\\\/|[^/])+)\\/[a-z]*\\s*,', 'g');
    let m;
    while ((m = stringDef.exec(src))) steps.push({ pattern: m[2], style: 'expression', file: rel });
    while ((m = regexDef.exec(src))) steps.push({ pattern: m[1], style: 'regex', file: rel });
  }

  // --- collect locators (entirely optional: many projects keep them in page objects) ---
  const locators = {};
  for (const [envKey, rel] of Object.entries(normaliseLocatorFiles(conv.locatorFiles))) {
    if (envOnly && envOnly !== true && envKey !== envOnly) continue;
    const p = loaded.resolve(rel);
    if (!p || !fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      locators[envKey] = { file: rel, count: Object.keys(data).length, entries: data };
    } catch (e) {
      console.error('WARN  could not parse ' + rel + ': ' + e.message);
    }
  }

  const index = {
    generatedAt: new Date().toISOString(),
    projectRoot: loaded.projectRoot,
    framework: conv.framework || 'generic',
    scope: { steps: stepFilter === true ? null : stepFilter, env: envOnly === true ? null : envOnly },
    stepFiles: [...new Set(stepFiles)].map((f) => path.relative(loaded.projectRoot, f)),
    stepCount: steps.length,
    steps,
    locators,
  };

  const outFlag = flag('out', null);
  const outFile = outFlag && outFlag !== true ? path.resolve(process.cwd(), String(outFlag)) : loaded.indexFile;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(index, null, 2));

  console.log('Indexed ' + steps.length + ' step definitions from ' + index.stepFiles.length + ' file(s):');
  for (const f of index.stepFiles) console.log('  - ' + f);
  for (const [k, v] of Object.entries(locators)) {
    console.log('Locators [' + k + ']: ' + v.count + ' entries (' + v.file + ')');
  }
  if (!steps.length && !Object.keys(locators).length) {
    console.log('\nNothing was indexed. Check `conventions.stepLibrary` / `conventions.locatorFiles` in');
    console.log(loaded.configFile);
    console.log('(If your project keeps selectors in page objects rather than a JSON map, that is fine —');
    console.log(' point the agent at those files in `conventions.notes` instead.)');
  }
  console.log('\nWrote ' + outFile);
  return 0;
};

module.exports = { buildIndex, HELP };

if (require.main === module) {
  try {
    process.exit(buildIndex(process.argv.slice(2)));
  } catch (e) {
    console.error('flow-recorder index failed: ' + e.message);
    process.exit(1);
  }
}
