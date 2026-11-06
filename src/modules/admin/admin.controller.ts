import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Tournament, UserRole } from '@prisma/client';
import { AuthenticatedJwtUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import {
  AdminService,
  AdminDashboardResponse,
  AdminUserResponse,
  AdminAuditRow,
} from './admin.service';
import {
  AdminAuditQuery,
  AdminTournamentStatusDto,
  AdminTournamentsQuery,
  AdminUsersQuery,
  AdminUserStatusDto,
} from './admin.dto';

import { CursorPage } from '../../common/dto/cursor-page';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.FEDERATION_ADMIN)
export class AdminController {
  constructor(private readonly service: AdminService) {}
  @Get('dashboard') async dashboard(): Promise<AdminDashboardResponse> {
    return this.service.dashboard();
  }
  @Get('users') async users(
    @Query() query: AdminUsersQuery,
  ): Promise<CursorPage<AdminUserResponse>> {
    return this.service.users(query);
  }
  @Patch(['users/:id/status', 'users/:id/governance'])
  @Roles(UserRole.SUPER_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async status(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUserStatusDto,
  ): Promise<AdminUserResponse> {
    return this.service.updateUser(actor, id, dto);
  }
  @Get('tournaments') async tournaments(
    @Query() query: AdminTournamentsQuery,
  ): Promise<CursorPage<Tournament>> {
    return this.service.tournaments(query);
  }
  @Patch(['tournaments/:id/status', 'tournaments/:id/moderation'])
  @UseInterceptors(IdempotencyInterceptor)
  async moderate(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminTournamentStatusDto,
  ): Promise<Tournament> {
    return this.service.moderateTournament(actor, id, dto);
  }
  @Get('audit-logs') async audit(
    @Query() query: AdminAuditQuery,
  ): Promise<CursorPage<AdminAuditRow>> {
    return this.service.auditLogs(query);
  }
}
