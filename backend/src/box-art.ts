/** Shared, deterministic artwork. Only fixed paths and palette values enter SVG. */
export type BoxLook = { name?: string; provider?: string; provider_id?: string; preview_hostname?: string; status?: string; create_state?: string; bootstrap_complete?: boolean; agent_last_seen_at?: string; owner_name?: string; owner_email?: string; user_id?: string };
export const boxFamilies = ['Sprout','Spectacles','Antenna','Cat ears','Beanie','Daisy','Mushroom','Headphones','Bow tie','Sailor','Moon','Comet','Cactus','Acorn','Goggles','Crown','Duck','Bunny','Pixel','Stripe','Freckles','Snail','Beret','Saturn'];
export function identityHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
export function boxIdentity(machine: BoxLook): string { return `${machine.provider || ''}:${machine.provider_id || machine.preview_hostname || machine.name || ''}`; }
export function boxState(machine: BoxLook): string {
  if (machine.status === 'destroying') return 'destroying';
  if (machine.create_state === 'recovery_required' || machine.status === 'recovery required') return 'recovery';
  if (machine.create_state === 'provisioning' || machine.status === 'creating' || machine.bootstrap_complete === false) return 'creating';
  if (machine.status === 'online' || machine.status === 'offline') return machine.status;
  if (machine.agent_last_seen_at) return Date.now() - Date.parse(machine.agent_last_seen_at) <= 300_000 ? 'online' : 'offline';
  return 'unknown';
}
export function stateLabel(machine: BoxLook): string { return ({online:'Online',offline:'Offline',creating:'Creating',recovery:'Recovery required',destroying:'Destroying',unknown:'Unknown'} as Record<string,string>)[boxState(machine)]; }
export function creatorBadge(machine: BoxLook): { label: string; initials: string; color: string } | null {
  const label = machine.owner_name || machine.owner_email;
  if (!label) return null;
  const words = label.split('@')[0].trim().split(/[\s._-]+/u).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0,2)).toUpperCase();
  return { label, initials, color: ['#dcece0','#dde9f4','#f5e8c9','#e9e1f2'][identityHash(machine.user_id || label) % 4] };
}
const accessories = [
  '<path d="M30 20V10M30 13Q16 13 20 5Q32 4 30 13M30 12Q30 1 41 5Q43 13 30 12" fill="#83aa61" stroke="#436c48"/>',
  '<g fill="none" stroke="#4b9ec3" stroke-width="2.6"><circle cx="24" cy="32" r="6"/><circle cx="38" cy="32" r="6"/><path d="M30 32H32"/></g>',
  '<path d="M32 20V8" stroke="#555e5c" stroke-width="3"/><circle cx="32" cy="7" r="4" fill="#e2a44c"/>',
  '<path d="M16 23V7L27 20M38 20 49 7V26" fill="#ac8eba" stroke="#685375" stroke-width="1.5"/>',
  '<path d="M16 21Q16 3 32 5Q49 3 49 21" fill="#b87553"/><rect x="15" y="17" width="35" height="7" rx="3" fill="#d19367"/><path d="M24 8 22 17M32 7V17M40 8 42 17" stroke="#875339"/>',
  '<path d="M33 20V9" stroke="#668655" stroke-width="2"/><g fill="#fffaf0" stroke="#d9d4bf"><circle cx="33" cy="5" r="4"/><circle cx="27" cy="10" r="4"/><circle cx="39" cy="10" r="4"/><circle cx="30" cy="15" r="4"/><circle cx="37" cy="15" r="4"/></g><circle cx="33" cy="10" r="3" fill="#e1b550"/>',
  '<path d="M29 21V12H36V21" fill="#e8d9b7"/><path d="M16 14Q18 0 32 2Q46 2 49 14Z" fill="#b96852"/><g fill="#fff5df"><circle cx="24" cy="9" r="2"/><circle cx="34" cy="6" r="2.5"/><circle cx="41" cy="11" r="2"/></g>',
  '<path d="M13 36V26Q13 9 32 9Q52 9 52 26V37" fill="none" stroke="#528f8d" stroke-width="4"/><rect x="10" y="29" width="7" height="15" rx="3" fill="#3b7776"/><rect x="48" y="29" width="7" height="15" rx="3" fill="#3b7776"/>',
  '<path d="m24 43 8 5 9-5v12l-9-5-8 5Z" fill="#d9af59"/><circle cx="32" cy="49" r="3" fill="#b58b38"/>',
  '<path d="M18 20 14 9Q32 0 50 9L46 20Z" fill="#eee9dc" stroke="#657b8b"/><path d="M19 18H45" stroke="#486477" stroke-width="3"/>',
  '<path d="M32 21V14" stroke="#848574"/><path d="M39 3Q22 0 23 12Q25 21 37 16Q25 12 39 3" fill="#ddba68"/>',
  '<path d="m26 2 3 6 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1Z" fill="#dcb66b"/><path d="M35 7Q45 2 56 13M35 10Q44 8 51 16" fill="none" stroke="#ddba68" stroke-width="2"/>',
  '<path d="M32 21V7M32 15H23V9M32 12H41V6" fill="none" stroke="#6f9b69" stroke-width="6" stroke-linecap="round"/>',
  '<path d="M20 18Q21 2 33 3Q47 3 46 18Z" fill="#b28b5d"/><path d="M17 15Q32 6 49 15V21H17Z" fill="#88674d"/><path d="M32 5V1" stroke="#655644" stroke-width="3"/>',
  '<path d="M16 28H49" stroke="#936d45" stroke-width="5"/><g fill="#cedcdf" stroke="#b9935d" stroke-width="3"><rect x="18" y="24" width="12" height="12" rx="4"/><rect x="33" y="24" width="12" height="12" rx="4"/></g>',
  '<path d="m18 20-2-13 10 5 7-10 7 10 10-5-3 13Z" fill="#cfaa62" stroke="#9a793f"/>',
  '<path d="M22 14Q28 20 42 14Q41 25 29 23Q22 22 22 14" fill="#e8bc56"/><circle cx="28" cy="10" r="6" fill="#edc564"/><path d="M22 9H17L22 13" fill="#cf8948"/><circle cx="28" cy="8" r="1" fill="#39463e"/>',
  '<ellipse cx="24" cy="11" rx="5" ry="11" fill="#e0d4d7"/><ellipse cx="39" cy="11" rx="5" ry="11" fill="#e0d4d7"/><path d="M24 6V16M39 6V16" stroke="#bd8e9c" stroke-width="3"/>',
  '<path d="M20 20V12H27V5H35V12H43V20" fill="#72956a"/><path d="M27 12H35V20H27Z" fill="#4d7651"/>',
  '<path d="M37 19H43V56H37Z" fill="#d8cdb6"/>',
  '<g fill="#c38d76"><circle cx="20" cy="38" r="1"/><circle cx="23" cy="39" r="1"/><circle cx="42" cy="38" r="1"/><circle cx="39" cy="39" r="1"/></g>',
  '<path d="M22 19H44L48 14M44 17V10" fill="none" stroke="#9caa80" stroke-width="3"/><circle cx="31" cy="12" r="9" fill="#bb9467"/><path d="M34 14Q25 17 25 10Q26 5 32 8Q36 12 30 12" fill="none" stroke="#886648" stroke-width="1.5"/>',
  '<path d="M16 20Q9 6 32 5Q47 4 49 16L42 22Z" fill="#8a9b79"/><path d="M32 6 35 1" stroke="#657856" stroke-width="3"/>',
  '<path d="M32 21V11" stroke="#a28c66"/><circle cx="32" cy="9" r="7" fill="#d8b368"/><ellipse cx="32" cy="9" rx="14" ry="4" transform="rotate(-20 32 9)" fill="none" stroke="#b18e52" stroke-width="2"/>',
];
export function boxSVG(machine: BoxLook): string {
  const family = identityHash(boxIdentity(machine)) % accessories.length;
  const state = boxState(machine);
  const asleep = state === 'offline';
  const led = ({online:'#69af79',creating:'#e9a43c',recovery:'#d3554b'} as Record<string,string>)[state] || '#a7ada7';
  const eyes = asleep ? '<path d="M21 31q3 5 6 0M35 31q3 5 6 0" fill="none" stroke="#26332e" stroke-width="2" stroke-linecap="round"/>' : '<g fill="#202c28"><ellipse cx="24" cy="31" rx="2.4" ry="3.2"/><ellipse cx="38" cy="31" rx="2.4" ry="3.2"/></g><g fill="#eee"><circle cx="23.5" cy="30" r=".7"/><circle cx="37.5" cy="30" r=".7"/></g>';
  const mouth = state === 'recovery' ? 'M28 40Q31 35 35 40' : 'M28 37Q31 42 35 37';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="box-avatar" viewBox="0 0 64 64" aria-hidden="true" focusable="false" data-family="${family}" data-state="${state}"><g opacity="${state === 'destroying' ? '.4' : '1'}"><ellipse cx="33" cy="58" rx="20" ry="3" fill="#243a31" opacity=".1"/><rect x="17" y="18" width="36" height="39" rx="9" fill="#515b55" stroke="#38463e"/><rect x="13" y="18" width="35" height="39" rx="8" fill="#929992" stroke="#455249" stroke-width="1.5"/><path d="M19 21H40" stroke="#d5d9cf" stroke-width="2" stroke-linecap="round"/><path d="M50 29H52M50 34H52M50 39H52M19 50H31M19 53H29" stroke="#455249" stroke-width="1.5" stroke-linecap="round"/>${eyes}<path d="${mouth}" fill="none" stroke="#26332e" stroke-width="1.8" stroke-linecap="round"/><circle cx="39" cy="50" r="3" fill="${led}"/>${accessories[family]}</g></svg>`;
}
