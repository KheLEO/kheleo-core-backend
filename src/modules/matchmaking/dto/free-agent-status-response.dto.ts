import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FreeAgentStatus } from '@prisma/client';

export class RosterMemberSummaryDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly user_id!: string;

  @ApiProperty({ example: 'Rahul Sharma' })
  readonly name!: string;

  @ApiProperty({ example: 'BOWLER' })
  readonly assigned_role!: string;

  @ApiProperty({ example: 74.2 })
  readonly gti!: number;
}

export class FreeAgentStatusResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly registrationId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174001' })
  readonly userId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174002' })
  readonly tournamentId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174003' })
  readonly bracketId!: string;

  @ApiProperty({ example: 'CRICKET' })
  readonly sport!: string;

  @ApiProperty({ example: 'BATSMAN' })
  readonly primaryRole!: string;

  @ApiPropertyOptional({ example: 'ALL_ROUNDER' })
  readonly secondaryRole?: string | null;

  @ApiProperty({ enum: FreeAgentStatus, example: FreeAgentStatus.QUEUED })
  readonly status!: FreeAgentStatus;

  @ApiProperty({ example: 3, description: 'Position in FIFO wait queue for bracket (1 = next)' })
  readonly waitPosition!: number;

  @ApiPropertyOptional({ example: '123e4567-e89b-12d3-a456-426614174004' })
  readonly matchedTeamId?: string | null;

  @ApiPropertyOptional({ example: 'FA-Roster-A1B2' })
  readonly teamName?: string | null;

  @ApiPropertyOptional({ example: 'BATSMAN' })
  readonly assignedRole?: string | null;

  @ApiPropertyOptional({ type: [RosterMemberSummaryDto] })
  readonly roster?: RosterMemberSummaryDto[] | null;

  @ApiProperty({ example: '2026-10-11T13:50:00.000Z' })
  readonly joinedAt!: string;
}
