import type { Machine } from "./api";
import { boxSVG, creatorBadge, boxState, stateLabel } from "../../src/box-art";
export function BoxAvatar({ machine }: { machine: Machine }) {
  return <span className="avatar-wrap" dangerouslySetInnerHTML={{ __html: boxSVG(machine) }} />;
}
export function CreatorBadge({ machine }: { machine: Machine }) {
  const badge = creatorBadge(machine);
  return badge ? <span className="creator-badge" tabIndex={0} title={`Created by ${badge.label}`} aria-label={`Created by ${badge.label}`} style={{ background: badge.color }}>{badge.initials}</span> : null;
}
export function BoxStatus({ machine }: { machine: Machine }) {
  return <span className={`box-status ${boxState(machine)}`}><i />{stateLabel(machine)}</span>;
}
