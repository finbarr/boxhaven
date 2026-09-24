import { createServer } from "node:net";

// Keep both sockets open during allocation so the OS cannot return the same
// free port for the API and app. Release them immediately before test startup.
export async function availableSmokeURLs() {
  const servers = [];
  try {
    for (let index = 0; index < 2; index++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map((server) => `http://127.0.0.1:${server.address().port}`);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map((server) =>
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}
