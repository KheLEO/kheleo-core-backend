import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  QUEUE_GTI_CALCULATION,
  QUEUE_MATCHMAKING,
  QUEUE_SCOUT_ALERTS,
} from '../../common/constants/queue.constants';
import { QueueProducerService } from './queue-producer.service';

import { redisOptions } from '../cache/redis-options';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisOptions(config, true),
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_GTI_CALCULATION },
      { name: QUEUE_MATCHMAKING },
      { name: QUEUE_SCOUT_ALERTS },
    ),
  ],
  providers: [QueueProducerService],
  exports: [BullModule, QueueProducerService],
})
export class BullmqModule {}
