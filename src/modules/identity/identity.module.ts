import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
