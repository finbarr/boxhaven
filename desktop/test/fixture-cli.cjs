#!/usr/bin/env node
const { readFileSync, appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.TEST_BH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
if (args[0] === 'list') {
  if (state.error) { console.error(state.error); process.exit(1); }
  console.log(JSON.stringify({ machines: state.machines }));
} else if (args[0] === 'preview') {
  const box = state.machines.find(box => box.name === args[1]);
  if (!box?.preview_url) { console.error('Preview unavailable'); process.exit(1); }
  appendFileSync(`${file}.previews`, `${JSON.stringify(args)}\n`);
  console.log(JSON.stringify({ url: box.preview_url, authentication: 'public' }));
} else if (args[0] === 'size') {
  setTimeout(() => {
    if (state.catalogError) { console.error(state.catalogError); process.exit(1); }
    const flag = key => args.includes(key) ? args[args.indexOf(key) + 1] : '';
    const provider = flag('--provider') || 'digitalocean';
    const region = flag('--region') || (provider === 'hetzner' ? 'fsn1' : 'nyc3');
    const plan = { slug: 'standard-2', available: true, vcpus: 2, memory_mb: 4096, disk_gb: 80,
      regions: provider === 'hetzner' ? ['fsn1'] : ['nyc3', 'sfo3'], prices: [{ hourly: 0.03, monthly: 20, currency: 'USD' }] };
    const cents = provider === 'hetzner' ? 6 : region === 'sfo3' ? 12 : 10;
    console.log(JSON.stringify({ provider: { name: provider, default_region: region },
      providers: [{ name: 'digitalocean', label: 'DigitalOcean' }, { name: 'hetzner', label: 'Hetzner' }],
      sizes: [{ name: 'small', plan, hourly_price_cents: cents }, { name: 'medium', plan: { ...plan, vcpus: 4, memory_mb: 8192 }, hourly_price_cents: cents * 2 }], plans: [{ ...plan, hourly_price_cents: cents }] }));
  }, state.catalogDelay || 100);
} else if (args[0] === 'rename') {
  appendFileSync(`${file}.renames`, `${JSON.stringify(args)}\n`);
  setTimeout(() => {
    if (state.renameError) { console.error(state.renameError); process.exit(1); }
    const latest = JSON.parse(readFileSync(file, 'utf8'));
    latest.machines.find(box => box.name === args[1]).name = args[2];
    writeFileSync(file, JSON.stringify(latest));
  }, state.renameDelay || 100);
} else if (args[0] === 'create') {
  appendFileSync(`${file}.creations`, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
  setTimeout(() => {
    if (state.createError) { console.error(state.createError); process.exit(1); }
    const latest = JSON.parse(readFileSync(file, 'utf8'));
    latest.machines.push({ name: args[1], provider_id: args[1], provider: args[args.indexOf('--provider') + 1],
      region: args[args.indexOf('--region') + 1], size: args[args.indexOf('--size') + 1], status: 'online', bootstrap_complete: true });
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
