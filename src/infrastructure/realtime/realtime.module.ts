import { Global, Module } from '@nestjs/common';
import { WsEventGateway } from './ws-event.gateway';
import { WsAuthGuard } from './ws-auth.guard';
import { RedisWsBridge } from './redis-ws-bridge.service';

import { AuthModule } from '../../modules/auth/auth.module';
import { RoomAccessService } from './room-access.service';

@Global()
@Module({
  imports: [AuthModule],
  providers: [WsEventGateway, WsAuthGuard, RoomAccessService, RedisWsBridge],
  exports: [WsEventGateway, WsAuthGuard, RoomAccessService, RedisWsBridge],
})
export class RealtimeModule {}
