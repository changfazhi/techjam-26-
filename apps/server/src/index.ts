import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { FileArtifactBroker } from "./session/broker.js";
import { SessionCoordinator } from "./session/coordinator.js";
import { createSchemaRegistry } from "./session/schemas/index.js";
import { SessionStore } from "./session/session-store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const sessions = new SessionStore(store);
const coordinator = new SessionCoordinator({
  agents: service,
  sessions,
  schemas: createSchemaRegistry(),
  broker: new FileArtifactBroker(),
  workspacePathFor: (agentId) => workspaces.workspacePath(agentId),
});

const app = await createApp(config, service, { sessions, coordinator });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
