import { Injectable, NotFoundException, ConflictException, Optional } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole, VerificationStatus } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';

import { LeaderboardsService } from '../leaderboards/leaderboards.service';
import { WsAuthGuard } from '../../infrastructure/realtime/ws-auth.guard';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { invalidateAuthAndPassport } from '../../infrastructure/cache/cache-helper';

export interface UserResponse {
  readonly id: string;
  readonly name?: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly isVerified: boolean;
  readonly isLegit: boolean;
  readonly identityStatus: VerificationStatus | 'VERIFIED' | 'UNVERIFIED' | 'FLAGGED_DUPLICATE' | 'REVOKED';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const userResponseSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  identityRecord: { select: { status: true } },
} as const;

function formatUserResponse(user: {
  id: string;
  name?: string | null;
  phone: string | null;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  identityRecord?: { status: VerificationStatus } | null;
}): UserResponse {
  const identityStatus = user.identityRecord?.status ?? VerificationStatus.UNVERIFIED;
  const isVerified = identityStatus === VerificationStatus.VERIFIED;
  return {
    id: user.id,
    name: user.name ?? null,
    phone: user.phone,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    isVerified,
    isLegit: isVerified,
    identityStatus,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly leaderboards?: LeaderboardsService,
    @Optional() private readonly sockets?: WsAuthGuard,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async findById(id: string): Promise<UserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: userResponseSelect,
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found.`);
    }

    return formatUserResponse(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserResponse> {
    await this.findById(id);

    if (dto.phone) {
      const existing = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('Phone number is already associated with another account.');
      }
    }

    if (dto.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('Email is already associated with another account.');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        phone: dto.phone,
        email: dto.email,
      },
      select: userResponseSelect,
    });
    await invalidateAuthAndPassport(this.redis, id);
    return formatUserResponse(updated);
  }

  async deactivate(id: string): Promise<UserResponse> {
    await this.findById(id);
    const updated = await runSerializableTransaction(this.prisma, async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id } });
      if (
        target?.role === UserRole.SUPER_ADMIN &&
        target.isActive &&
        (await transaction.user.count({
          where: {
            role: UserRole.SUPER_ADMIN,
            isActive: true,
            OR: [
              { identityRecord: null },
              { identityRecord: { status: { notIn: ['REVOKED', 'FLAGGED_DUPLICATE'] } } },
            ],
          },
        })) <= 1
      )
        throw new ConflictException('Cannot deactivate the last active super administrator');
      const user = await transaction.user.update({
        where: { id },
        data: { isActive: false },
        select: userResponseSelect,
      });
      await transaction.refreshToken.updateMany({
        where: { userId: id, revoked: false },
        data: { revoked: true },
      });
      return formatUserResponse(user);
    });
    await invalidateAuthAndPassport(this.redis, id);
    this.sockets?.disconnectUser(id);
    await this.leaderboards?.syncAthlete(id);
    return updated;
  }
}
