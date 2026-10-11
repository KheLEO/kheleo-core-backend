import { Global, Module } from '@nestjs/common';
import { WsEventGateway } from './ws-event.gateway';
import { WsAuthGuard } from './ws-auth.guard';

@Global()
@Module({
  providers: [WsEventGateway, WsAuthGuard],
  exports: [WsEventGateway],
})
export class RealtimeModule {}
