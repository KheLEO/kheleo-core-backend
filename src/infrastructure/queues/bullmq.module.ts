import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  QUEUE_GTI_RECALCULATION,
  QUEUE_MATCHMAKING,
  QUEUE_SCOUT_ALERTS,
} from '../../common/constants/queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('queue.redisHost', 'localhost'),
          port: config.get<number>('queue.redisPort', 6379),
          password: config.get<string>('queue.redisPassword') || undefined,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_GTI_RECALCULATION },
      { name: QUEUE_MATCHMAKING },
      { name: QUEUE_SCOUT_ALERTS },
    ),
  ],
  exports: [BullModule],
})
export class BullmqModule {}
