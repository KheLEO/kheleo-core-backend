import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { databaseConfig } from './database.config';
import { redisConfig } from './redis.config';
import { queueConfig } from './queue.config';

import { validateEnvironment } from './validate-environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      load: [appConfig, authConfig, databaseConfig, redisConfig, queueConfig],
      envFilePath: ['.env'],
    }),
  ],
})
export class ConfigurationModule {}
