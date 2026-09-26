#!/usr/bin/env node
const { readFileSync, appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.TEST_BH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
if (args[0] === 'list') {
  if (state.error) { console.error(state.error); process.exit(1); }
  console.log(JSON.stringify({ machines: state.machines }));
} else if (args[0] === 'create') {
  appendFileSync(`${file}.creations`, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
  setTimeout(() => {
    if (state.createError) { console.error(state.createError); process.exit(1); }
    const latest = JSON.parse(readFileSync(file, 'utf8'));
    latest.machines.push({ name: args[1], status: 'online', bootstrap_complete: true });
    writeFileSync(file, JSON.stringify(latest));
    console.log('Ready.');
  }, state.createDelay || 100);
} else if (args[0] === 'destroy') {
  appendFileSync(`${file}.destructions`, `${JSON.stringify(args)}\n`);
  setTimeout(() => {
    if (state.destroyError) { console.error(state.destroyError); process.exit(1); }
    const latest = JSON.parse(readFileSync(file, 'utf8'));
    latest.machines = latest.machines.filter(box => box.name !== args[1]);
    writeFileSync(file, JSON.stringify(latest));
    console.log('Destroyed.');
  }, state.destroyDelay || 100);
} else if (args[0] === 'connect') {
  appendFileSync(`${file}.connections`, `${args[1]}\n`);
  process.stdout.write(`\x1b[2J\x1b[H\x1b[32mboxhaven@${args[1]}\x1b[0m:~/project$ \r\nDesktop PTY fixture — not a remote box.\r\n`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let buffer = '';
  process.stdin.on('data', data => {
    for (const char of data.toString()) {
      if (char === '\r') {
        if (buffer === 'exit') process.exit(0);
        process.stdout.write(`\r\nReceived: ${buffer}\r\n$ `); buffer = '';
      } else if (char === '\u0002') { process.exit(0); }
      else { buffer += char; process.stdout.write(char); }
    }
  });
  process.on('SIGWINCH', () => process.stdout.write(`\r\nSIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`));
} else { console.error('Unsupported fixture command'); process.exit(1); }
