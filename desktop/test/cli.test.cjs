const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMachines, validName, terminalSize, runCLI, cliEnvironment } = require('../src/cli.cjs');

test('machine records are display-only and preserve readiness, team, and liveness', () => {
  assert.deepEqual(parseMachines('{"machines":[]}'), []);
  const [box] = parseMachines(JSON.stringify({ machines: [{ name: 'work', status: 'online', bootstrap_complete: true, team_slug: 'team', token: 'secret', last_command: ['secret'] }] }));
  assert.equal(box.ready, true); assert.equal(box.team, 'team'); assert.equal(box.status, 'online');
  assert.equal(JSON.stringify(box).includes('secret'), false);
  assert.equal(parseMachines('{"machines":[{"name":"broken","status":"recovery required","bootstrap_complete":true,"create_state":"recovery_required"}]}')[0].ready, false);
});
test('untrusted names and terminal dimensions cannot become command arguments', () => {
  for (const name of ['--help', 'a; touch x', 'a\nb', '../work', '']) assert.equal(validName(name), false);
  assert.throws(() => parseMachines('{"machines":[{"name":"--help","status":"online"}]}'));
  assert.throws(() => parseMachines('{}'));
  for (const size of [[NaN, 24], [80, -1], [10000, 24], [80.5, 24]]) assert.throws(() => terminalSize(...size));
  assert.deepEqual(terminalSize(80, 24), { cols: 80, rows: 24 });
});
test('CLI invokes argv without a shell and surfaces clean failures', async () => {
  const literal = '$(touch /tmp/never-run-boxhaven)';
  const output = await runCLI(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(output, literal);
  await assert.rejects(runCLI(process.execPath, ['-e', 'console.error("\\x1b[31mPlease sign in\\x1b[0m"); process.exit(1)']), /Please sign in/);
});
test('GUI launch PATH includes user-installed CLI helpers', () => {
  assert.ok(cliEnvironment({ HOME: '/example', PATH: '/usr/bin' }).PATH.includes('/example/.local/bin'));
});
test('closing the app can cancel a pending CLI operation', async () => {
  const controller = new AbortController();
  const command = runCLI(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(command, /abort/i);
});
