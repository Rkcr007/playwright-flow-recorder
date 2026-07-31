#!/usr/bin/env node
// Scaffold flow-recorder into an existing test repo.
//
//   flow-recorder init [--force] [--no-skill] [--dir <projectDir>]
//
// Detects your framework, step directories, feature directory and any locator
// JSON maps, writes a `flow-recorder.config.json` you can edit, installs the
// agent skill into .claude/skills/, and adds the working directory to .gitignore.
//
// Fully non-interactive on purpose — safe in CI and in a Docker build, and the
// generated config is a plain file you are meant to review and adjust.

const fs = require('fs');
const path = require('path');
const { makeFlag, DEFAULTS } = require('./config');
const { CONFIG_NAMES, LOCAL_NAMES } = require('./config');

const HELP = `
flow-recorder init — detect your framework and write a config

Usage
  flow-recorder init [options]

Options
  --dir <path>     Project directory to scaffold (default: cwd)
  --force          Overwrite an existing flow-recorder.config.json
  --agent <list>   Where to point your assistant at the conversion instructions:
                   agents (AGENTS.md), cursor, copilot, all. Default: whichever
                   of those files already exist in the repo.
  --no-skill       Skip installing .claude/skills/record-flow/SKILL.md
  -h, --help       Show this help

Every project gets .flow-recorder/CONVERT.md — vendor-neutral instructions that
Cursor, Copilot, Windsurf, Aider, ChatGPT or a human can all work from. Commit it.
`;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.flow-recorder',
  'allure-results', 'allure-report', 'reports', 'test-results', '.next', '.nuxt', 'vendor',
]);

const STEP_DIR_CANDIDATES = [
  'features/step_definitions',
  'features/steps',
  'features/support/steps',
  'tests/features/src/steps',
  'tests/features/steps',
  'test/features/steps',
  'src/steps',
  'src/test/steps',
  'tests/steps',
  'test/steps',
  'steps',
  'e2e/steps',
  'cypress/support/step_definitions',
];

const FEATURE_DIR_CANDIDATES = [
  'features',
  'tests/features/specs',
  'tests/features',
  'test/features',
  'src/features',
  'e2e/features',
  'cypress/e2e',
  'tests/e2e',
];

const PRIMARY_HINTS = ['predefined', 'common', 'shared', 'base', 'generic', 'global'];

const readPkg = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (_) {
    return null;
  }
};

const detectFramework = (pkg) => {
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  if (has('@cucumber/cucumber') || has('cucumber')) return 'cucumber-playwright';
  if (has('codeceptjs')) return 'codeceptjs';
  if (has('@playwright/test')) return 'playwright-test';
  if (has('cypress')) return 'cypress';
  if (has('@wdio/cli')) return 'webdriverio';
  return 'generic';
};

// Shallow-ish recursive search for JSON files that look like selector maps.
const findLocatorFiles = (root, depth = 0, acc = []) => {
  if (depth > 3 || acc.length >= 8) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      findLocatorFiles(full, depth + 1, acc);
    } else if (/(locator|selector)s?.*\.json$/i.test(e.name)) {
      // Must parse as a flat-ish object to be a plausible selector map.
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length) acc.push(full);
      } catch (_) {
        /* not JSON we can use */
      }
    }
  }
  return acc;
};

const listStepFiles = (dir, acc = [], depth = 0) => {
  if (depth > 4) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) listStepFiles(full, acc, depth + 1);
    } else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
};

// The "primary" step file is the shared library that must always be indexed.
// Prefer a name hint; fall back to the largest file, which in practice is the
// catch-all step library.
const detectPrimaryStepFile = (stepDirs, root) => {
  const files = stepDirs.flatMap((d) => listStepFiles(path.resolve(root, d)));
  if (!files.length) return '';
  const hinted = files.find((f) => PRIMARY_HINTS.some((h) => path.basename(f).toLowerCase().includes(h)));
  const pick =
    hinted ||
    files
      .map((f) => ({ f, size: (() => { try { return fs.statSync(f).size; } catch (_) { return 0; } })() }))
      .sort((a, b) => b.size - a.size)[0].f;
  return path.basename(pick);
};

// The command the agent should use to dry-run a freshly generated scenario.
// Prefer an existing npm script — a project's own script already carries the
// right config flags, env vars and reporters.
const detectDryRunCommand = (pkg, framework) => {
  const scripts = (pkg && pkg.scripts) || {};
  const names = Object.keys(scripts);
  const preferred = names.find((n) => /^(test:e2e|e2e|test:spec|testspec|test)$/i.test(n)) ||
    names.find((n) => /(spec|feature|cucumber|e2e)/i.test(n));
  if (preferred) return 'npm run ' + preferred;
  if (framework === 'cucumber-playwright') return 'npx cucumber-js';
  if (framework === 'playwright-test') return 'npx playwright test';
  if (framework === 'codeceptjs') return 'npx codeceptjs run';
  if (framework === 'cypress') return 'npx cypress run';
  return '';
};

const appendGitignore = (root, lines) => {
  const file = path.join(root, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (_) {
    current = '';
  }
  const missing = lines.filter((l) => !current.split(/\r?\n/).some((c) => c.trim() === l));
  if (!missing.length) return [];
  const block =
    (current && !current.endsWith('\n') ? '\n' : '') + '\n# flow-recorder\n' + missing.join('\n') + '\n';
  fs.writeFileSync(file, current + block);
  return missing;
};

const runInit = (argv = []) => {
  const flag = makeFlag(argv);
  if (flag('help', false) || argv.includes('-h')) {
    console.log(HELP.trim());
    return 0;
  }

  const dirFlag = flag('dir', null);
  const root = path.resolve(dirFlag && dirFlag !== true ? String(dirFlag) : process.cwd());
  const force = !!flag('force', false);
  const wantSkill = !flag('no-skill', false);

  if (!fs.existsSync(root)) {
    console.error('No such directory: ' + root);
    return 1;
  }

  const target = path.join(root, CONFIG_NAMES[0]);
  const existing = CONFIG_NAMES.map((n) => path.join(root, n)).find((p) => fs.existsSync(p));
  if (existing && !force) {
    console.log('Config already exists: ' + existing);
    console.log('Re-run with --force to overwrite, or just edit it by hand.');
    return 0;
  }

  const pkg = readPkg(root);
  const framework = detectFramework(pkg);
  const stepDirs = STEP_DIR_CANDIDATES.filter((d) => fs.existsSync(path.join(root, d)));
  const featureDir = FEATURE_DIR_CANDIDATES.find((d) => fs.existsSync(path.join(root, d))) || DEFAULTS.conventions.featureDir;
  const locatorPaths = findLocatorFiles(root);
  const locatorFiles = {};
  for (const p of locatorPaths) {
    const key = path.basename(p, '.json').replace(/locators?|selectors?/gi, '').replace(/[^a-z0-9]/gi, '') || 'default';
    locatorFiles[Object.keys(locatorFiles).length === 0 && key === '' ? 'default' : key || 'default'] =
      path.relative(root, p);
  }
  const primaryStepFile = detectPrimaryStepFile(stepDirs, root);

  const cfg = {
    attachPort: DEFAULTS.attachPort,
    startUrl: '',
    outDir: DEFAULTS.outDir,
    indexFile: DEFAULTS.indexFile,
    chromeProfileDir: DEFAULTS.chromeProfileDir,
    userMode: 'expert',
    agentName: 'the AI agent',
    conventions: {
      framework,
      featureDir,
      stepLibrary: stepDirs.length ? stepDirs : [],
      primaryStepFile,
      locatorFiles,
      testDataFiles: [],
      scenarioOpener: '',
      dryRunCommand: detectDryRunCommand(pkg, framework),
      tags: ['@recorded', '@wip'],
      notes: '',
    },
  };

  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');

  // --- the vendor-neutral conversion contract ----------------------------------
  // Written for EVERY project, whatever assistant the team uses. Claude Code gets a
  // skill it can run on its own; without this, everyone else got nothing in their
  // repo at all and had to go and find a prompt in the package's docs. Same
  // instructions, resolved against this project's real paths, in a file any
  // assistant can be pointed at — including one that only reads what you paste.
  const convertPath = path.join(root, path.dirname(DEFAULTS.outDir), 'CONVERT.md');
  const tpl = path.join(__dirname, '..', 'skills', 'convert', 'CONVERT.template.md');
  if (fs.existsSync(tpl)) {
    const subs = {
      CONFIG: path.relative(root, target),
      OUTDIR: DEFAULTS.outDir,
      INDEX: DEFAULTS.indexFile,
      FEATUREDIR: featureDir,
      FRAMEWORK: framework,
      DRYRUN: cfg.conventions.dryRunCommand || '(not set — add conventions.dryRunCommand)',
      TAGS: cfg.conventions.tags.join(' '),
    };
    const body = fs.readFileSync(tpl, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in subs ? subs[k] : m));
    fs.mkdirSync(path.dirname(convertPath), { recursive: true });
    fs.writeFileSync(convertPath, body);
  }
  const convertRel = path.relative(root, convertPath);

  // --- point each assistant at it where that assistant actually looks ----------
  // One pointer line per tool, in the file that tool reads by convention. Created
  // when absent, appended to when present, never duplicated — these are files the
  // user owns and may have written a lot of their own rules into.
  const POINTER = 'When converting a browser recording into a test, follow ' + convertRel + '.';
  const pointerTargets = [
    { tool: 'agents', file: 'AGENTS.md', heading: '# Agent instructions' },
    { tool: 'cursor', file: path.join('.cursor', 'rules', 'flow-recorder.mdc'), heading: '---\nalwaysApply: true\n---' },
    { tool: 'copilot', file: path.join('.github', 'copilot-instructions.md'), heading: '# Copilot instructions' },
  ];
  const wantedAgents = String(flag('agent', '') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const pointers = [];
  for (const t of pointerTargets) {
    const abs = path.join(root, t.file);
    // Default: write only where the tool is already in use. `--agent` forces one in.
    const wanted = wantedAgents.length ? wantedAgents.includes(t.tool) || wantedAgents.includes('all') : fs.existsSync(abs);
    if (!wanted) continue;
    try {
      if (fs.existsSync(abs)) {
        const cur = fs.readFileSync(abs, 'utf8');
        if (cur.includes(convertRel)) continue; // already pointed there
        fs.writeFileSync(abs, cur.replace(/\s*$/, '') + '\n\n' + POINTER + '\n');
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, t.heading + '\n\n' + POINTER + '\n');
      }
      pointers.push(t.file);
    } catch (_) {}
  }

  // --- install the Claude Code skill -------------------------------------------
  // Claude Code can drive the whole session (follow the clicks live, drain the
  // queue), which is more than a pointer can express — so it keeps a real skill.
  let skillPath = null;
  if (wantSkill) {
    const src = path.join(__dirname, '..', 'skills', 'record-flow', 'SKILL.md');
    const destDir = path.join(root, '.claude', 'skills', 'record-flow');
    const dest = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest) && !force) {
        console.log('Skill already installed, leaving it alone: ' + path.relative(root, dest));
      } else {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
        skillPath = path.relative(root, dest);
      }
    }
  }

  // Ignore what is GENERATED, not the whole namespace. `.flow-recorder/` wholesale
  // would also bury CONVERT.md, which exists precisely to be committed and shared
  // with the team's assistants. Recordings carry typed values and URLs and must
  // never be committed; the index is derived from the repo and would only churn.
  const ignored = appendGitignore(root, [DEFAULTS.outDir + '/', DEFAULTS.indexFile, LOCAL_NAMES[0]]);

  // --- report ----------------------------------------------------------------
  console.log('\nWrote ' + path.relative(root, target) + '\n');
  console.log('  framework        ' + framework + (pkg ? '  (from package.json)' : '  (no package.json — guessed)'));
  console.log('  featureDir       ' + featureDir + (fs.existsSync(path.join(root, featureDir)) ? '' : '  (does not exist yet)'));
  console.log('  stepLibrary      ' + (stepDirs.length ? stepDirs.join(', ') : '(none found — set this by hand)'));
  console.log('  primaryStepFile  ' + (primaryStepFile || '(none)'));
  console.log(
    '  locatorFiles     ' + (Object.keys(locatorFiles).length ? JSON.stringify(locatorFiles) : '(none found — optional)')
  );
  console.log('\nAgent instructions:    ' + convertRel + '  (works with any assistant — commit it)');
  if (pointers.length) {
    console.log('Pointed at it from:    ' + pointers.join(', '));
  } else {
    console.log('                       no AGENTS.md / .cursor / .github here — add a pointer');
    console.log('                       yourself, or: flow-recorder init --agent agents,cursor,copilot');
  }
  if (skillPath) console.log('Claude Code skill:     ' + skillPath + '  (drives the session end to end)');
  if (ignored.length) console.log('Added to .gitignore:   ' + ignored.join(', '));

  const gaps = [];
  if (!stepDirs.length) gaps.push('conventions.stepLibrary is empty — point it at your step definition folder(s)');
  if (framework === 'generic') gaps.push('framework could not be detected — set it if you use Cucumber/Playwright Test/CodeceptJS');
  if (gaps.length) {
    console.log('\nReview these before recording:');
    for (const g of gaps) console.log('  • ' + g);
  }

  console.log('\nNext:');
  console.log('  1. flow-recorder doctor      # verify the wiring');
  console.log('  2. flow-recorder index       # build the reuse index');
  console.log('  3. flow-recorder chrome      # start a debuggable browser, log in');
  console.log('  4. flow-recorder record      # attach and record a segment');
  return 0;
};

module.exports = { runInit, HELP };

if (require.main === module) {
  try {
    process.exit(runInit(process.argv.slice(2)));
  } catch (e) {
    console.error('flow-recorder init failed: ' + e.message);
    process.exit(1);
  }
}
