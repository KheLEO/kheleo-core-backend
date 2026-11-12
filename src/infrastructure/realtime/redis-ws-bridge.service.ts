import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Namespace } from 'socket.io';
import { RedisService } from '../cache/redis.service';

export const WS_RELAY_CHANNEL = 'kheleo:ws:relay';

type WsRelayMessage =
  | {
      readonly type: 'emit';
      readonly namespace: string;
      readonly rooms: readonly string[];
      readonly event: string;
      readonly payload: unknown;
    }
  | {
      readonly type: 'disconnect';
      readonly userId: string;
    };

@Injectable()
export class RedisWsBridge implements OnModuleDestroy {
  private readonly logger = new Logger(RedisWsBridge.name);
  private readonly localNamespaces = new Map<string, Namespace>();
  private readonly disconnectHandlers = new Set<(userId: string) => void>();
  private subscriber?: Redis;
  private subscriberAttached = false;

  constructor(@Optional() private readonly redis?: RedisService) {}

  registerNamespace(name: string, namespace: Namespace): void {
    this.localNamespaces.set(name, namespace);
    this.ensureSubscriber();
  }

  registerDisconnectHandler(handler: (userId: string) => void): void {
    this.disconnectHandlers.add(handler);
  }

  private ensureSubscriber(): void {
    if (this.subscriberAttached) return;
    const client = this.redis?.client;
    if (!client || typeof client.duplicate !== 'function') return;
    this.subscriberAttached = true;
    try {
      const sub = client.duplicate({ lazyConnect: true, enableOfflineQueue: true });
      sub.on('error', (error: unknown) => {
        this.logger.warn(`WS relay Redis subscriber error: ${String(error)}`);
      });
      sub.on('message', (channel: string, raw: string) => {
        if (channel !== WS_RELAY_CHANNEL) return;
        try {
          const msg = JSON.parse(raw) as WsRelayMessage;
          if (msg.type === 'emit') {
            const ns = this.localNamespaces.get(msg.namespace);
            if (ns) {
              const target = msg.rooms.length ? ns.local.to([...msg.rooms]) : ns.local;
              target.emit(msg.event, msg.payload);
            }
          } else if (msg.type === 'disconnect') {
            for (const handler of this.disconnectHandlers) {
              handler(msg.userId);
            }
          }
        } catch {
          // Ignore malformed relay payloads safely.
        }
      });
      void sub
        .connect()
        .then(() => sub.subscribe(WS_RELAY_CHANNEL))
        .catch((error: unknown) => {
          this.logger.warn(`WS relay Redis subscription unavailable: ${String(error)}`);
        });
      this.subscriber = sub;
    } catch (error: unknown) {
      this.logger.warn(`Could not initialize WS relay subscriber: ${String(error)}`);
    }
  }

  publishEmit(namespace: string, rooms: readonly string[], event: string, payload: unknown): void {
    const client = this.redis?.client;
    if (!client || typeof client.publish !== 'function') return;
    const msg: WsRelayMessage = { type: 'emit', namespace, rooms, event, payload };
    void client.publish(WS_RELAY_CHANNEL, JSON.stringify(msg)).catch((err: unknown) => {
      this.logger.warn(`WS relay publish failed for ${event}: ${String(err)}`);
    });
  }

  publishDisconnect(userId: string): void {
    const client = this.redis?.client;
    if (!client || typeof client.publish !== 'function') return;
    const msg: WsRelayMessage = { type: 'disconnect', userId };
    void client.publish(WS_RELAY_CHANNEL, JSON.stringify(msg)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        this.subscriber.disconnect();
      }
      this.subscriber = undefined;
    }
  }
}

