import { Global, Module } from '@nestjs/common';
import { WsEventGateway } from './ws-event.gateway';
import { WsAuthGuard } from './ws-auth.guard';

import { AuthModule } from '../../modules/auth/auth.module';
import { RoomAccessService } from './room-access.service';

@Global()
@Module({
  imports: [AuthModule],
  providers: [WsEventGateway, WsAuthGuard, RoomAccessService],
  exports: [WsEventGateway, WsAuthGuard, RoomAccessService],
})
export class RealtimeModule {}
