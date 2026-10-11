import { Module } from '@nestjs/common';
import { DrillsController } from './drills.controller';
import { DrillsService } from './drills.service';
import { DrillSignatureGuard } from './guards/drill-signature.guard';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DrillsController],
  providers: [DrillsService, DrillSignatureGuard],
  exports: [DrillsService],
})
export class DrillsModule {}
