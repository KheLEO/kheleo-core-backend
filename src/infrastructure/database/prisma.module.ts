import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PostgisSpatialRepository } from './postgis-spatial.repository';

@Global()
@Module({
  providers: [PrismaService, PostgisSpatialRepository],
  exports: [PrismaService, PostgisSpatialRepository],
})
export class PrismaModule {}
