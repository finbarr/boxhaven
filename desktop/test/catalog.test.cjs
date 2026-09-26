const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterArgs, parseCatalog, createArgs } = require('../src/catalog.cjs');
const plan = { slug: 'standard-2', available: true, vcpus: 2, memory_mb: 4096, disk_gb: 80, regions: ['nyc3', 'sfo3'], prices: [{ hourly: .03, monthly: 20, currency: 'USD' }] };
function parse(sizes = [{ name: 'small', plan }], region = '') {
  return parseCatalog(JSON.stringify({ provider: { name: 'digitalocean', default_region: 'nyc3' }, providers: [{ name: 'digitalocean', label: 'DigitalOcean' }], sizes, plans: [plan] }), region);
}
test('backend quotes override wholesale prices and raw plans are not creation choices', () => {
  const catalog = parse([{ name: 'small', plan, hourly_price_cents: 10 }]);
  assert.equal(catalog.choices[0].hourly, .10);
  assert.equal(catalog.choices[0].monthly, 73);
  assert.equal(catalog.choices[0].memoryGB, 4);
  assert.equal(catalog.region, 'nyc3');
  assert.deepEqual(catalog.choices.map(choice => choice.value), ['small']);
});
test('prices match requested region or global price; absent prices are not free', () => {
  const prices = [{ region: 'nyc3', hourly: .04, monthly: 25, currency: 'USD' }, { region: 'sfo3', hourly: .05, monthly: 30, currency: 'USD' }];
  assert.equal(parse([{ name: 'small', plan: { ...plan, prices } }], 'sfo3').choices[0].hourly, .05);
  assert.equal(parse([{ name: 'small', plan: { ...plan, prices: prices.slice(1) } }]).choices[0].hourly, null);
  assert.equal(parse([{ name: 'small', plan: { ...plan, prices: [] } }]).choices[0].monthly, null);
  assert.equal(parse().choices[0].monthly, 20);
});
test('unavailable sizes and regions cannot be selected or submitted', () => {
  const catalog = parse([{ name: 'small', plan: { ...plan, available: false } }, { name: 'elsewhere', plan: { ...plan, regions: ['ams3'] } }]);
  assert.deepEqual(catalog.choices, []);
  assert.throws(() => createArgs('work', { provider: catalog.provider, region: catalog.region, size: 'small' }, catalog), /available size/);
  assert.throws(() => createArgs('work', { provider: catalog.provider, region: 'sfo3', size: 'small' }, parse()), /Reload/);
});
test('creation always supplies validated settings and never syncs local files', () => {
  const catalog = parse();
  const settings = { provider: catalog.provider, region: catalog.region, size: 'small' };
  assert.deepEqual(createArgs('work', settings, catalog), ['create', 'work', '--no-sync', '--provider', 'digitalocean', '--size', 'small', '--region', 'nyc3']);
  assert.throws(() => createArgs('--help', settings, catalog), /lowercase/);
  assert.throws(() => createArgs('work', { ...settings, size: '--help' }, catalog), /available size/);
  assert.throws(() => createArgs('work', { ...settings, size: 'standard-2' }, catalog), /available size/);
  assert.throws(() => filterArgs('', '--help'), /Invalid region/);
  assert.deepEqual(filterArgs('', ''), ['size', 'list', '--json']);
});
