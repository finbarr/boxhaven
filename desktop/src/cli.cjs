const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const { join, delimiter } = require('node:path');
const { stripVTControlCharacters } = require('node:util');

function cliEnvironment(env = process.env) {
  const home = env.HOME || homedir();
  return {
    ...env,
    PATH: [...new Set([join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH || '').split(delimiter), '/usr/bin', '/bin'])].join(delimiter),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
}

function runCLI(cliPath, args, { cwd = homedir(), env = cliEnvironment(), timeout = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cliPath, args, { cwd, env, timeout, signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stripVTControlCharacters(stderr).trim();
        reject(new Error(detail || (error.killed ? 'BoxHaven took too long to respond. Try refreshing.' : error.message)));
      } else resolve(stdout);
    });
    child.stdin.end();
  });
}

function parseMachines(output) {
  const data = JSON.parse(output);
  if (!Array.isArray(data.machines)) throw new Error('The BoxHaven CLI returned an invalid box list.');
  return data.machines.map(machine => {
    if (!validName(machine.name) || typeof machine.status !== 'string') throw new Error('The BoxHaven CLI returned an invalid box.');
    // Send only display data to the renderer; credentials stay with the CLI.
    return {
      name: machine.name, status: machine.status,
      identity: JSON.stringify([machine.provider, machine.provider_id, machine.created_at]),
      previewURL: previewURL(machine.preview_url),
      team: machine.team_slug || machine.team_name || 'Personal',
      provider: machine.provider || '', region: machine.region || '', size: machine.size || '',
      ready: machine.bootstrap_complete === true && machine.create_state !== 'recovery_required',
    };
  });
}

function previewURL(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function validName(name) {
  return typeof name === 'string' && name.length <= 253 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new Error('Invalid terminal dimensions.');
  return { cols, rows };
}

module.exports = { cliEnvironment, runCLI, parseMachines, validName, terminalSize, previewURL };
