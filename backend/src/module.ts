import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { CommercialPolicy } from "./policy.js";
import type { ProviderRegistry } from "./providers.js";
import type { StateStore } from "./state.js";
import type { BackendDatabaseMigration } from "./database.js";

export type BackendTeam = {
  id: string;
  name: string;
  slug?: string;
};

export type BackendUserContext = {
  userID: string;
  email: string;
  orgID: string;
  teams: BackendTeam[];
};

export type BackendRequest = {
  headers: Record<string, string | string[] | undefined>;
};

export type BackendReply = {
  code(statusCode: number): { send(payload: unknown): unknown };
};

export type BackendModuleContext = {
  database: Database.Database;
  store: StateStore;
  providers: ProviderRegistry;
  apiPublicURL: string;
  appPublicURL: string;
  authenticate(request: BackendRequest, reply: BackendReply): Promise<BackendUserContext | undefined>;
  resolveTeam(user: BackendUserContext, reference: string): { team?: BackendTeam; error?: string };
  teamRole(request: BackendRequest, teamID: string, userID: string): Promise<string>;
  roleCanManage(role: string): boolean;
  isAdministrator(user: BackendUserContext): boolean;
  requestPolicyReconciliation(): void;
};

export type BackendModuleRuntime = {
  commercialPolicy?: CommercialPolicy;
  registerRoutes?(app: FastifyInstance, context: BackendModuleContext): void | Promise<void>;
  close?(): void | Promise<void>;
};

export type BackendModule = {
  name: string;
  migrations: BackendDatabaseMigration[];
  start(context: BackendModuleContext): BackendModuleRuntime;
};
