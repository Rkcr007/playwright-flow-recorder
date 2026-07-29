#!/usr/bin/env node
// Preflight diagnostics: answers "why isn't this working?" before you have to ask.
//
//   flow-recorder doctor
//
// Checks the environment, the resolved config, and — importantly — whether the
// convention paths in your config still EXIST. A `stepLibrary` entry pointing at
// a renamed directory is the most common reason conversion quietly stops reusing
// steps: the index comes back empty and the agent writes everything from scratch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, validateConventions, CONFIG_NAMES } = require('./config');
const { findChrome, cdpVersion } = require('./chrome');

const HELP = `
flow-recorder doctor — check the environment, config, and browser wiring

Usage
  flow-recorder doctor [--port <n>]
`;

const ICON = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };

const runDoctor = async (argv = []) => {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail: detail || '' });

  // --- runtime ---------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18 ? 'pass' : 'fail', 'Node ' + process.versions.node, major >= 18 ? '' : 'Node 18 or newer required');
  add('info', 'Platform', process.platform + ' ' + os.release() + ' (' + process.arch + ')');

  // --- playwright ------------------------------------------------------------
  let pwName = null;
  let pwVersion = null;
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      pwVersion = require(mod + '/package.json').version;
      pwName = mod;
      break;
    } catch (_) {
      /* keep looking */
    }
  }
  if (pwName) add('pass', pwName + ' ' + pwVersion, 'resolved');
  else add('fail', 'playwright not found', 'npm i -D playwright   (or run via npx playwright-flow-recorder)');

  // A browser binary is only needed for `record --launch`; attach mode uses your Chrome.
  let bundled = null;
  if (pwName) {
    try {
      const p = require(pwName).chromium.executablePath();
      bundled = p && fs.existsSync(p) ? p : null;
    } catch (_) {
      bundled = null;
    }
  }
  add(
    bundled ? 'pass' : 'warn',
    'Playwright Chromium binary',
    bundled ? bundled : 'not downloaded — needed only for `record --launch`: npx playwright install chromium'
  );

  const systemChrome = (() => {
    try {
      return findChrome(null);
    } catch (_) {
      return null;
    }
  })();
  add(
    systemChrome ? 'pass' : 'warn',
    'System Chrome/Chromium/Edge',
    systemChrome || 'none found — `flow-recorder chrome` will not work; use `record --launch`'
  );

  // --- config ----------------------------------------------------------------
  let loaded = null;
  try {
    loaded = loadConfig();
  } catch (e) {
    add('fail', 'Config file is not valid JSON', e.message);
  }

  if (loaded) {
    if (loaded.configFile) {
      add('pass', 'Config found', loaded.configFile + '  [' + loaded.configSource + ']');
    } else {
      add(
        'warn',
        'No config file',
        'Recording works on defaults, but the agent has no idea where your steps/locators are.\n' +
          '        Create one with `flow-recorder init` (searched for ' +
          CONFIG_NAMES.join(', ') +
          ' upward from ' +
          process.cwd() +
          ')'
      );
    }
    if (loaded.localConfigFile) add('info', 'Local override applied', loaded.localConfigFile);

    add('info', 'Project root', loaded.projectRoot);
    add('info', 'Recordings dir', loaded.outDir);
    add('info', 'Reuse index', loaded.indexFile + (fs.existsSync(loaded.indexFile) ? '  (built)' : '  (not built yet)'));
    add('info', 'Chrome profile', loaded.chromeProfileDir);
    const featureDir = (loaded.cfg.conventions || {}).featureDir;
    if (featureDir) {
      const abs = loaded.resolve(featureDir);
      add('info', 'Feature/spec dir', featureDir + (fs.existsSync(abs) ? '' : '  (will be created on first write)'));
    }
    add('info', 'Framework', (loaded.cfg.conventions || {}).framework || 'generic');
    add('info', 'User mode', loaded.cfg.userMode);

    // What ⚡ actually does. Unset is a legitimate setup (an agent watches the
    // queue file), but it must be stated — assuming ⚡ notifies something when it
    // does not is the difference between a handed-off scenario and a forgotten one.
    const hook = loaded.cfg.onCreate;
    const hookStr = Array.isArray(hook) ? hook.join(' ') : String(hook || '').trim();
    if (hookStr) add('pass', 'onCreate hook (⚡)', hookStr);
    else add('info', 'onCreate hook (⚡)', 'not set — ⚡ writes the queue file only; an agent must read it');

    // Is the output directory actually writable? Fails on read-only mounts and
    // inside some CI sandboxes, and the error surfaces late and confusingly.
    try {
      fs.mkdirSync(loaded.outDir, { recursive: true });
      const probe = path.join(loaded.outDir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      add('pass', 'Recordings dir writable', '');
    } catch (e) {
      add('fail', 'Recordings dir NOT writable', loaded.outDir + ' — ' + e.message);
    }

    // The high-value check: do the configured convention paths still exist?
    if (loaded.configFile) {
      const issues = validateConventions(loaded);
      if (!issues.length) {
        add('pass', 'Convention paths exist', 'stepLibrary / locatorFiles / featureDir all resolve');
      } else {
        for (const i of issues) add('fail', 'Missing path: ' + i.label, i.value + '  →  ' + i.abs);
      }
      const conv = loaded.cfg.conventions || {};
      if (!(conv.stepLibrary || []).length) {
        add('warn', 'conventions.stepLibrary is empty', 'Nothing to reuse — the agent will author every step from scratch');
      }
    }
  }

  // --- CDP -------------------------------------------------------------------
  const portArg = argv.indexOf('--port');
  const port = Number(portArg > -1 ? argv[portArg + 1] : (loaded && loaded.cfg.attachPort) || 9222) || 9222;
  const v = await cdpVersion(port, 1500);
  if (v) add('pass', 'CDP port ' + port + ' is live', v.Browser || '');
  else
    add(
      'warn',
      'Nothing on CDP port ' + port,
      'Start one with `flow-recorder chrome`, or record in a throwaway browser with `record --launch`'
    );

  // --- report ----------------------------------------------------------------
  const width = Math.max(...results.map((r) => r.label.length)) + 2;
  console.log('');
  for (const r of results) {
    console.log(ICON[r.level] + '  ' + r.label.padEnd(width) + r.detail);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log('');
  if (fails) console.log(fails + ' blocking problem(s), ' + warns + ' warning(s).');
  else if (warns) console.log('No blocking problems. ' + warns + ' warning(s) — fine to record.');
  else console.log('All good. Run `flow-recorder record`.');
  return fails ? 1 : 0;
};

module.exports = { runDoctor, HELP };

if (require.main === module) {
  runDoctor(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('flow-recorder doctor failed: ' + e.message);
      process.exit(1);
    });
}
