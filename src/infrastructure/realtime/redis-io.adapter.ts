import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { RedisService } from '../cache/redis.service';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;
  private pubClient: Redis | undefined;
  private subClient: Redis | undefined;

  constructor(
    appContext: INestApplicationContext,
    private readonly redisService: RedisService,
    private readonly corsOrigins: readonly string[],
  ) {
    super(appContext);
  }

  async connectToRedis(): Promise<void> {
    this.pubClient = this.redisService.client.duplicate({ lazyConnect: true });
    this.subClient = this.redisService.client.duplicate({ lazyConnect: true });
    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: [...this.corsOrigins],
        methods: ['GET', 'POST'],
      },
    }) as ReturnType<IoAdapter['createIOServer']> & {
      adapter: (adapter: unknown) => void;
    };

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    return server;
  }

  async close(server: Parameters<IoAdapter['close']>[0]): Promise<void> {
    await super.close(server);
    await Promise.allSettled([
      this.pubClient?.quit() ?? Promise.resolve('OK'),
      this.subClient?.quit() ?? Promise.resolve('OK'),
    ]);
    this.pubClient = undefined;
    this.subClient = undefined;
  }
}
