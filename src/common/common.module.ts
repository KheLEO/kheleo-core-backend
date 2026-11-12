import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../infrastructure/cache/redis.module';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { RolesGuard } from './guards/roles.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';

@Global()
@Module({
  imports: [RedisModule],
  providers: [IdempotencyInterceptor, RolesGuard, RateLimitGuard],
  exports: [IdempotencyInterceptor, RolesGuard, RateLimitGuard],
})
export class CommonModule {}
