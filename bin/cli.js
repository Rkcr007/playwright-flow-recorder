#!/usr/bin/env node
// playwright-flow-recorder — single entry point.
//
//   npx playwright-flow-recorder <command> [options]
//
// `record` is the default command, so a bare `npx playwright-flow-recorder`
// starts a recording session.

const VERSION = require('../package.json').version;

const USAGE = `
playwright-flow-recorder v${VERSION}

Record a browser walkthrough as a semantic event stream, then let an AI agent
turn it into tests that reuse the step library you already have.

Usage
  flow-recorder <command> [options]

Commands
  record     Attach to a browser and record segments        (default)
  chrome     Start a Chrome that the recorder can attach to
  init       Detect your framework and write a config file
  index      Build the reuse index of existing steps/locators
  doctor     Diagnose environment, config and browser wiring
  help       Show this message

First run, in your test repo
  npx playwright-flow-recorder init       # writes flow-recorder.config.json
  npx playwright-flow-recorder doctor     # confirm everything resolves
  npx playwright-flow-recorder chrome     # a browser you can log into
  npx playwright-flow-recorder record     # attach; press ⏺ when the flow starts

While recording (on-page widget, top-centre)
  ⏺  name + start a segment      ⏹  stop it (same button)
  ✎  note your intent            ⌥/Alt+Click  assert an element
  ⚡  queue the segment(s) for the agent      ⠿  drag out of the way

Per-command help
  flow-recorder <command> --help
`;

const COMMANDS = {
  record: async (argv) => {
    await require('../src/recorder').record(argv);
    return 0; // record() resolves when the session ends
  },
  chrome: (argv) => require('../src/chrome').startChrome(argv),
  doctor: (argv) => require('../src/doctor').runDoctor(argv),
  init: (argv) => require('../src/init').runInit(argv),
  index: (argv) => require('../src/build-index').buildIndex(argv),
};

// Aliases people will reasonably guess.
const ALIASES = {
  rec: 'record',
  start: 'record',
  setup: 'init',
  check: 'doctor',
  'build-index': 'index',
  reindex: 'index',
  browser: 'chrome',
};

const main = async () => {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (first === 'help' || first === '--help' || first === '-h') {
    console.log(USAGE.trim());
    return 0;
  }

  // No command, or a leading flag → default to `record`.
  const looksLikeFlag = !first || first.startsWith('-');
  const name = looksLikeFlag ? 'record' : ALIASES[first] || first;
  const rest = looksLikeFlag ? argv : argv.slice(1);

  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error('Unknown command: ' + first + '\n');
    console.log(USAGE.trim());
    return 1;
  }
  const code = await cmd(rest);
  return typeof code === 'number' ? code : 0;
};

main()
  .then((code) => {
    // `record` holds the process open on its own; every other command exits here.
    if (code !== 0) process.exit(code);
  })
  .catch((e) => {
    console.error('flow-recorder failed: ' + (e && e.message ? e.message : e));
    if (process.env.FLOW_RECORDER_DEBUG) console.error(e);
    process.exit(1);
  });
