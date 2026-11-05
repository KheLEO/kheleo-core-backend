import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io, Socket } from 'socket.io-client';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import {
  WsAuthGuard,
  AuthenticatedNamespace,
  AuthenticatedSocket,
} from '../../src/infrastructure/realtime/ws-auth.guard';
import { WsEventGateway } from '../../src/infrastructure/realtime/ws-event.gateway';
import { RoomAccessService } from '../../src/infrastructure/realtime/room-access.service';
import { MatchmakingGateway } from '../../src/modules/matchmaking/matchmaking.gateway';
import { SecurityFixture } from './security-gti.fixture';

type Events = Record<string, (...args: unknown[]) => void>;
export type TestClient = Socket<Events, Events>;
export async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Socket assertion timed out')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function createSocketFixture(fixture: SecurityFixture) {
  const http = createServer();
  const ioServer = new Server(http, { serveClient: false });
  const auth = new WsAuthGuard(new JwtStrategy(fixture.auth.config, fixture.prisma));
  const access = new RoomAccessService(fixture.prisma);
  const events = new WsEventGateway(auth, access);
  const matchmaking = new MatchmakingGateway(auth, access);
  const ready = new Set<string>();
  const waiters = new Map<string, () => void>();
  for (const [path, gateway] of [
    ['/ws/events', events],
    ['/ws/matchmaking', matchmaking],
  ] as const) {
    const namespace = ioServer.of(path) as unknown as AuthenticatedNamespace;
    gateway.server = namespace;
    gateway.afterInit(namespace);
    namespace.on('connection', (client) => {
      void gateway.handleConnection(client).then(() => {
        ready.add(client.id);
        waiters.get(client.id)?.();
      });
    });
  }
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing socket port');
  const clients: TestClient[] = [];
  const client = (
    path = '/ws/events',
    token?: string,
    mechanism: 'auth' | 'header' | 'query' = 'auth',
  ): TestClient => {
    const socket = io(`http://127.0.0.1:${address.port}${path}`, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      ...(token
        ? mechanism === 'auth'
          ? { auth: { token } }
          : mechanism === 'header'
            ? { extraHeaders: { authorization: `Bearer ${token}` } }
            : { query: { token } }
        : {}),
    }) as TestClient;
    clients.push(socket);
    return socket;
  };
  const connect = async (socket: TestClient): Promise<void> => {
    await deadline(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (error: unknown) => reject(error));
        socket.connect();
      }),
    );
    const id = socket.id!;
    if (!ready.has(id)) await deadline(new Promise<void>((resolve) => waiters.set(id, resolve)));
  };
  const serverSocket = (socket: TestClient, path = '/ws/events'): AuthenticatedSocket => {
    const server = ioServer.of(path).sockets.get(socket.id!);
    if (!server) throw new Error('Socket not connected');
    return server as unknown as AuthenticatedSocket;
  };
  const close = async (): Promise<void> => {
    for (const socket of clients) socket.disconnect();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    if (http.listening)
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
  };
  return { auth, events, matchmaking, client, connect, serverSocket, close, ioServer };
}
