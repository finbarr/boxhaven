import { createContext, ReactNode, useContext } from "react";
import { AuthUser, TeamInfo } from "./api";

// Session snapshot owned by the authed _console layout route. Child routes
// (boxes, team, images, device) consume it instead of re-querying
// whoami or threading props through every component.
export type ConsoleSession = {
  token: string;
  user?: AuthUser;
  teams: TeamInfo[];
  activeTeam?: TeamInfo;
  isAdmin: boolean;
};

const ConsoleContext = createContext<ConsoleSession | null>(null);

export function ConsoleProvider({ value, children }: { value: ConsoleSession; children: ReactNode }) {
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleSession {
  const session = useContext(ConsoleContext);
  if (!session) throw new Error("useConsole must be used inside the console layout");
  return session;
}
