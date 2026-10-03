import type { LookupAddress } from 'node:dns';
import net from 'node:net';
import { vi } from 'vitest';

// Route the real dispatcher's sockets to an offline HTTP fixture only after
// its connection lookup succeeds. No fixture address is used as DNS evidence.
export function routeUploadSourceToFixture(port: number) {
  const connectedAddresses: string[] = [];
  const originalConnect = net.connect;
  const connect = vi.spyOn(net, 'connect').mockImplementation(((options: net.TcpNetConnectOpts) => {
    if (Number(options.port) !== 80) return originalConnect(options);
    const socket = new net.Socket({
      signal: (options as net.TcpNetConnectOpts & net.SocketConstructorOpts).signal,
    });
    queueMicrotask(() => {
      const connectFixture = () => socket.connect({ host: '127.0.0.1', port });
      if (options.lookup && !net.isIP(options.host ?? '')) {
        options.lookup(options.host ?? '', { all: true }, (error, addresses) => {
          if (error) return void socket.destroy(error);
          connectedAddresses.push(...(addresses as LookupAddress[]).map(({ address }) => address));
          connectFixture();
        });
      } else {
        connectedAddresses.push(options.host ?? '');
        connectFixture();
      }
    });
    return socket;
  }) as typeof net.connect);
  return { connectedAddresses, restore: () => connect.mockRestore() };
}
