import type { Server } from 'node:http';

/** Test fixture disposal also works after partial startup or repeated cleanup. */
export async function closeFixtureServers(...servers: Array<Server | undefined>): Promise<void> {
  await Promise.all(
    servers.map(async (server) => {
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
}
