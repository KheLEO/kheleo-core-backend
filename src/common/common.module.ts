import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../infrastructure/cache/redis.module';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { RolesGuard } from './guards/roles.guard';

@Global()
@Module({
  imports: [RedisModule],
  providers: [IdempotencyInterceptor, RolesGuard],
  exports: [IdempotencyInterceptor, RolesGuard],
})
export class CommonModule {}
