import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Public database and Redis readiness check' })
  @ApiResponse({ status: HttpStatus.OK, description: 'All dependencies are ready.' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'A dependency is unavailable.',
  })
  async check(@Res() reply: FastifyReply): Promise<void> {
    const health = await this.health.check();
    void reply
      .code(health.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .send(health);
  }
}
