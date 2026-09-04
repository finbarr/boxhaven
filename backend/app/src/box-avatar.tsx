import type { Machine } from "./api";

const colors = ["#43806a", "#5289a6", "#ac7242", "#8673a8", "#bc6c76", "#799247", "#537c98"];

// A small family of friends for the servers in the logo. Provider identity
// survives renames and team moves; no stored images or generation service.
export function BoxAvatar({ machine }: { machine: Machine }) {
  const identity = `${machine.provider || ""}:${machine.provider_id || machine.preview_hostname || machine.name}`;
  let hash = 2166136261;
  for (const char of identity) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const color = colors[hash % colors.length];
  const hat = (hash >>> 8) % 5;
  const glasses = (hash >>> 16) % 3 === 0;
  return (
    <svg className="box-avatar" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="62" height="62" rx="18" fill={color} opacity=".1" />
      <ellipse cx="33" cy="55" rx="18" ry="3" fill={color} opacity=".18" />
      <path d="M18 16 45 13 51 19V49Q51 53 46 54L18 52Z" fill={color} stroke="#30493f" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="14" y="17" width="31" height="36" rx="7" fill="#fbf7ec" stroke="#30493f" strokeWidth="1.5" />
      <rect x="18" y="21" width="23" height="19" rx="5" fill={color} opacity=".18" />
      <g fill="#30493f">
        <ellipse cx="24" cy="29" rx="1.8" ry="2.4" />
        <ellipse cx="35" cy="29" rx="1.8" ry="2.4" />
      </g>
      <path d="M27 34Q29.5 37 32 34" fill="none" stroke="#30493f" strokeWidth="1.6" strokeLinecap="round" />
      {glasses ? <path d="M20 26H27V32H20ZM32 26H39V32H32ZM27 28H32" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" /> : null}
      <circle cx="21" cy="45" r="2" fill={color} />
      <path d="M27 45H38M21 49H38" stroke={color} strokeWidth="2" strokeLinecap="round" />
      {hat === 0 ? <g stroke="#43806a" strokeWidth="1.5" strokeLinejoin="round"><path d="M30 17V10" /><path d="M30 13Q19 13 21 6Q31 5 30 13M30 11Q30 3 38 5Q40 12 30 11" fill="#8fac68" /></g> : null}
      {hat === 1 ? <g stroke={color} strokeWidth="1.5"><path d="M29 17V8" /><circle cx="29" cy="7" r="3" fill="#e6bd62" /></g> : null}
      {hat === 2 ? <path d="M22 17 27 4 36 17Z" fill={color} stroke="#30493f" strokeWidth="1.3" strokeLinejoin="round" /> : null}
      {hat === 3 ? <g fill={color} stroke="#30493f" strokeWidth="1.3" strokeLinejoin="round"><path d="M17 18 17 8 25 17M34 17 42 8 43 20" /></g> : null}
      {hat === 4 ? <g fill="#e6bd62" stroke="#997037" strokeWidth="1"><path d="m29 5 2.4 4.8 5.3.8-3.9 3.8.9 5.3-4.7-2.5-4.7 2.5.9-5.3-3.9-3.8 5.3-.8Z" /></g> : null}
    </svg>
  );
}
