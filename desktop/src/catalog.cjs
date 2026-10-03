const { validName } = require('./cli.cjs');

function filterArgs(provider, region) {
  const args = ['size', 'list', '--json'];
  for (const [key, value] of Object.entries({ provider, region })) {
    if (typeof value !== 'string' || (value && (!validName(value) || value.length > 63))) throw new Error(`Invalid ${key}.`);
    if (value) args.push(`--${key}`, value);
  }
  return args;
}

function parseCatalog(output, requestedRegion) {
  const data = JSON.parse(output);
  if (!validName(data.provider?.name) || !Array.isArray(data.providers) || !Array.isArray(data.sizes) || !Array.isArray(data.plans)) throw new Error('Invalid machine catalog.');
  const provider = data.provider.name;
  const region = requestedRegion || data.provider.default_region || '';
  filterArgs(provider, region);
  const providers = data.providers.filter(item => validName(item.name)).map(item => ({ name: item.name, label: typeof item.label === 'string' ? item.label : item.name }));
  const choices = new Map();
  function add(value, plan, cents) {
    if (!validName(value) || value.length > 63 || !plan || plan.available !== true) return;
    const regions = Array.isArray(plan.regions) ? plan.regions.filter(validName) : [];
    if (region && regions.length && !regions.includes(region)) return;
    const prices = Array.isArray(plan.prices) ? plan.prices : [];
    const price = prices.find(price => price.region === region) || prices.find(price => !price.region);
    let hourly = null, monthly = null, currency = 'USD';
    if (Number.isInteger(cents) && cents >= 0) { hourly = cents / 100; monthly = hourly * 730; }
    else if (price && Number.isFinite(price.hourly) && price.hourly >= 0 && /^[A-Z]{3}$/.test(price.currency)) {
      hourly = price.hourly; monthly = Number.isFinite(price.monthly) && price.monthly > 0 ? price.monthly : hourly * 730; currency = price.currency;
    }
    const number = value => Number.isFinite(value) && value >= 0 ? value : null;
    if (!choices.has(value)) choices.set(value, { value, cpus: number(plan.vcpus), memoryGB: plan.memory_mb > 0 ? plan.memory_mb / 1024 : null, diskGB: number(plan.disk_gb), description: typeof plan.description === 'string' ? plan.description : '', regions, hourly, monthly, currency });
  }
  for (const size of data.sizes) add(size.name, size.plan, size.hourly_price_cents);
  return { provider, region, providers, regions: [...new Set([region, ...[...choices.values()].flatMap(choice => choice.regions)].filter(Boolean))].sort(), choices: [...choices.values()] };
}

function createArgs(name, settings, catalog) {
  if (!validName(name) || name.length > 63) throw new Error('Use up to 63 lowercase letters, numbers, and hyphens.');
  if (!settings || !catalog || settings.provider !== catalog.provider || settings.region !== catalog.region || !catalog.choices.some(choice => choice.value === settings.size)) throw new Error('Reload creation settings and choose an available size.');
  const args = ['create', name, '--no-sync', '--provider', settings.provider, '--size', settings.size];
  if (settings.region) args.push('--region', settings.region);
  return args;
}
module.exports = { filterArgs, parseCatalog, createArgs };
