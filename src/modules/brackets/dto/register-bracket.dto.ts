import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class RegisterBracketDto {
  @ApiPropertyOptional({
    description: 'Optional Team UUID if registering as a team captain',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID()
  readonly teamId?: string;
}
