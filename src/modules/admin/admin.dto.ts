import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  AuditCategory,
  AuditSeverity,
  TournamentStatus,
  UserRole,
  VerificationStatus,
} from '@prisma/client';
export class AdminPageQuery {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @IsUUID() cursor_id?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class AdminUsersQuery extends AdminPageQuery {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ obj, key }: { obj: unknown; key: string }) => {
    const raw =
      typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
    return raw === 'true' ? true : raw === 'false' ? false : raw;
  })
  @IsBoolean()
  isActive?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(UserRole)
  role?: UserRole;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(VerificationStatus)
  verificationStatus?: VerificationStatus;
}
export class AdminUserStatusDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ obj, key }: { obj: unknown; key: string }): unknown =>
    typeof obj === 'object' && obj !== null
      ? (obj as Readonly<Record<string, unknown>>)[key]
      : undefined,
  )
  @IsBoolean()
  isActive?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(UserRole)
  role?: UserRole;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(VerificationStatus)
  verificationStatus?: VerificationStatus;
}
export class AdminTournamentsQuery extends AdminPageQuery {
  @IsOptional() @IsEnum(TournamentStatus) status?: TournamentStatus;
}
export enum ModerationAction {
  APPROVE = 'APPROVE',
  FEATURE = 'FEATURE',
  SUSPEND = 'SUSPEND',
  CLOSE = 'CLOSE',
}
export class AdminTournamentStatusDto {
  @IsOptional() @IsEnum(ModerationAction) action?: ModerationAction;
  @IsOptional() @IsEnum(TournamentStatus) status?: TournamentStatus;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ obj, key }: { obj: unknown; key: string }) =>
    typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined,
  )
  @IsBoolean()
  featured?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ obj, key }: { obj: unknown; key: string }) =>
    typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined,
  )
  @IsBoolean()
  suspended?: boolean;
}
export class AdminAuditQuery extends AdminPageQuery {
  @IsOptional() @IsEnum(AuditCategory) category?: AuditCategory;
  @IsOptional() @IsEnum(AuditSeverity) severity?: AuditSeverity;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(100) resource?: string;
  @IsOptional() @IsUUID() userId?: string;
}
