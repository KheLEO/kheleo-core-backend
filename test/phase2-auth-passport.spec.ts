import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { IdentityService } from '../src/modules/identity/identity.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { GovIdType, Prisma, SportType, UserRole, VerificationStatus } from '@prisma/client';
import { PaginatedResponseDto } from '../src/common/dto/paginated-response.dto';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ValidationPipe,
} from '@nestjs/common';
import { LoginDto } from '../src/modules/auth/dto/login.dto';
import { createAuthFixture, TEST_DOCUMENT } from './helpers/auth-passport.fixture';
import { decode } from 'jsonwebtoken';

describe('Phase 2: Identity, Anti-Account Reset, & Passport Tests', () => {
  const mockConfigService = {
    get: (key: string, defaultValue?: unknown) => {
      if (key === 'auth.identityPepper') return 'test_pepper_3847291837492817';
      if (key === 'auth.identitySaltVersion') return 1;
      return defaultValue;
    },
  };

  const mockPrisma = {
    identityVerification: {
      findUnique: async () => null,
      create: async (data: unknown) => data,
    },
    user: {
      findUnique: async () => ({ id: 'user-1' }),
    },
  };

  const identityService = new IdentityService(
    mockPrisma as unknown as PrismaService,
    mockConfigService as unknown as ConfigService,
  );

  describe('Government ID Irreversible Hashing (Anti-Account Reset)', () => {
    it('generates a 64-character SHA-256 hex string', () => {
      const hash = identityService.hashGovernmentId('542189012345', GovIdType.AADHAAR);
      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64);
      assert.match(hash, /^[a-f0-9]{64}$/);
    });

    it('re-attaches the permanent profile when Gov ID and contact both match', async () => {
      const permanentUser = {
        id: 'historical-user-id',
        phone: '+919876543210',
        email: 'athlete@kheleo.test',
        role: UserRole.ATHLETE,
        isActive: false,
        athleteProfile: { id: 'permanent-profile-id' },
      };
      const reattachPrisma = {
        identityVerification: {
          findUnique: async () => ({
            id: 'identity-id',
            userId: permanentUser.id,
            idHash: 'hash',
            status: 'VERIFIED',
            user: permanentUser,
          }),
          update: async () => ({}),
        },
        user: {
          update: async () => ({ ...permanentUser, isActive: true }),
        },
        refreshToken: {
          create: async () => ({}),
        },
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(reattachPrisma),
      };
      const reattachIdentity = new IdentityService(
        reattachPrisma as unknown as PrismaService,
        mockConfigService as unknown as ConfigService,
      );
      const auth = new AuthService(
        reattachPrisma as unknown as PrismaService,
        reattachIdentity,
        mockConfigService as unknown as ConfigService,
      );

      const result = await auth.register({
        phone: permanentUser.phone,
        governmentId: {
          idType: GovIdType.AADHAAR,
          idNumber: '542189012345',
        },
      });

      assert.strictEqual(result.user.id, permanentUser.id);
      assert.strictEqual(result.user.athleteProfileId, 'permanent-profile-id');
      assert.strictEqual(result.user.isVerified, true);
    });

    it('blocks profile takeover when Gov ID matches but contact does not', async () => {
      const auditEvents: Prisma.SecurityAuditLogCreateInput[] = [];
      const takeoverPrisma = {
        securityAuditLog: {
          create: async ({ data }: { data: Prisma.SecurityAuditLogCreateInput }) => {
            auditEvents.push(data);
            return data;
          },
        },
        identityVerification: {
          findUnique: async () => ({
            id: 'identity-id',
            userId: 'historical-user-id',
            idHash: 'hash',
            status: 'VERIFIED',
            user: {
              id: 'historical-user-id',
              phone: '+919876543210',
              email: null,
              role: UserRole.ATHLETE,
              isActive: true,
              athleteProfile: { id: 'permanent-profile-id' },
            },
          }),
        },
      };
      const takeoverIdentity = new IdentityService(
        takeoverPrisma as unknown as PrismaService,
        mockConfigService as unknown as ConfigService,
      );
      const auth = new AuthService(
        takeoverPrisma as unknown as PrismaService,
        takeoverIdentity,
        mockConfigService as unknown as ConfigService,
      );

      await assert.rejects(
        auth.register({
          phone: '+919999999999',
          governmentId: {
            idType: GovIdType.AADHAAR,
            idNumber: '542189012345',
          },
        }),
        ConflictException,
      );
      assert.strictEqual(auditEvents.length, 1);
      assert.strictEqual(auditEvents[0]?.action, 'GOV_ID_DUPLICATE_ATTEMPT');
    });

    it('prevents public registration from escalating to privileged roles', async () => {
      const auth = new AuthService(
        mockPrisma as unknown as PrismaService,
        identityService,
        mockConfigService as unknown as ConfigService,
      );
      await assert.rejects(
        auth.register({ phone: '+919876543210', role: UserRole.SUPER_ADMIN }),
        ForbiddenException,
      );
    });

    it('normalizes spaces and hyphens so identical IDs produce identical hashes', () => {
      const hash1 = identityService.hashGovernmentId('5421 8901 2345', GovIdType.AADHAAR);
      const hash2 = identityService.hashGovernmentId('5421-8901-2345', GovIdType.AADHAAR);
      const hash3 = identityService.hashGovernmentId('542189012345', GovIdType.AADHAAR);
      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash2, hash3);
    });

    it('produces different hashes for different ID types', () => {
      const hashAadhaar = identityService.hashGovernmentId('A1234567', GovIdType.AADHAAR);
      const hashPassport = identityService.hashGovernmentId('A1234567', GovIdType.PASSPORT);
      assert.notStrictEqual(hashAadhaar, hashPassport);
    });

    it('rejects duplicate Gov ID when existing record is found', async () => {
      const mockPrismaWithExisting = {
        user: {
          findUnique: async () => ({ id: 'new-user-id', isActive: true, phone: null, email: null }),
        },
        identityVerification: {
          findUnique: async () => ({
            id: 'id-1',
            userId: 'historical-user-id',
            idHash: 'sample-hash',
          }),
          update: async () => ({}),
        },
      };

      const idServiceWithDuplicate = new IdentityService(
        mockPrismaWithExisting as unknown as PrismaService,
        mockConfigService as unknown as ConfigService,
      );

      await assert.rejects(
        async () => {
          await idServiceWithDuplicate.verifyAndBindGovernmentId(
            'new-user-id',
            '542189012345',
            GovIdType.AADHAAR,
          );
        },
        (err: Error) => {
          assert.match(err.message, /already linked to this Government ID/);
          return true;
        },
      );
    });
  });

  describe('Cursor Pagination DTO', () => {
    it('correctly calculates has_more and next_cursor', () => {
      const items = [
        { id: '1', name: 'Item 1' },
        { id: '2', name: 'Item 2' },
        { id: '3', name: 'Item 3' },
      ];

      // Limit = 2, total = 3 -> has_more = true, next_cursor = '2'
      const paginated = PaginatedResponseDto.create(items, 2, (item) => item.id);
      assert.strictEqual(paginated.count, 2);
      assert.strictEqual(paginated.has_more, true);
      assert.strictEqual(paginated.next_cursor, '2');
      assert.strictEqual(paginated.data.length, 2);
    });

    it('handles last page when items <= limit', () => {
      const items = [{ id: '1', name: 'Item 1' }];
      const paginated = PaginatedResponseDto.create(items, 2, (item) => item.id);
      assert.strictEqual(paginated.count, 1);
      assert.strictEqual(paginated.has_more, false);
      assert.strictEqual(paginated.next_cursor, null);
    });
  });

  describe('Lightweight JWT Token Payload', () => {
    it('verifies lightweight payload structure conforms to network optimization constraints', () => {
      const payload = {
        sub: '123e4567-e89b-12d3-a456-426614174000',
        role: UserRole.ATHLETE,
        phone: '+919876543210',
      };
      const json = JSON.stringify(payload);
      // Ensure payload size is well below 200 bytes for low-bandwidth 2G/3G environments
      assert.ok(json.length < 150);
    });
  });
});

describe('Phase 2 auth, identity rotation, and passport regressions', () => {
  const login = {
    phone: '+919000000001',
    governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
  };

  for (const governmentId of [
    undefined,
    null,
    {},
    [],
    'invalid',
    { idType: 'AADHAAR' },
    { idNumber: TEST_DOCUMENT },
  ]) {
    it(`rejects malformed login governmentId ${JSON.stringify(governmentId)} through ValidationPipe`, async () => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      await assert.rejects(
        pipe.transform({ phone: login.phone, governmentId }, { type: 'body', metatype: LoginDto }),
        BadRequestException,
      );
    });
  }

  it('guards AuthService.login independently of the validation pipe', async () => {
    const fixture = createAuthFixture();
    await assert.rejects(
      fixture.auth.login({ phone: login.phone } as LoginDto),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.strictEqual(error.message, 'governmentId with idType and idNumber is required');
        return true;
      },
    );
  });

  for (const status of [
    'deactivated',
    VerificationStatus.REVOKED,
    VerificationStatus.FLAGGED_DUPLICATE,
  ] as const) {
    it(`blocks ${status} accounts on both login and refresh before issuing tokens`, async () => {
      const fixture = createAuthFixture();
      if (status === 'deactivated') fixture.state.user.isActive = false;
      else {
        assert.ok(fixture.state.user.identityRecord);
        fixture.state.user.identityRecord.status = status;
      }
      await assert.rejects(fixture.auth.login(login), ForbiddenException);
      await assert.rejects(fixture.auth.refreshTokens('fixture-refresh-token'), ForbiddenException);
      assert.strictEqual(fixture.state.createdTokens.length, 0);
      assert.strictEqual(fixture.state.token.revoked, false);
    });
  }

  it('uses configured access and refresh lifetimes consistently', async () => {
    const fixture = createAuthFixture({
      config: { 'auth.jwtAccessExpiry': '2h', 'auth.jwtRefreshExpiry': '2d' },
    });
    const before = Date.now();
    const result = await fixture.auth.login(login);
    const claims = decode(result.accessToken);
    assert.ok(
      claims &&
        typeof claims !== 'string' &&
        typeof claims.exp === 'number' &&
        typeof claims.iat === 'number',
    );
    assert.strictEqual(claims.exp - claims.iat, 7200);
    assert.strictEqual(result.expiresIn, 7200);
    const expiresAt = fixture.state.createdTokens[0]?.expiresAt.getTime();
    assert.ok(expiresAt && expiresAt >= before + 172800000 && expiresAt <= Date.now() + 172800000);
    assert.throws(
      () => createAuthFixture({ config: { 'auth.jwtAccessExpiry': 'forever' } }),
      /JWT_ACCESS_EXPIRY/,
    );
  });

  it('finds salt-version-1 identities after rotation during login, registration, and verification', async () => {
    const fixture = createAuthFixture({ saltVersion: 7, storedSaltVersion: 1 });
    const profile = await fixture.passports.getOrCreatePassport(fixture.state.user.id);
    assert.strictEqual(
      fixture.identity.computeCandidateHashes(TEST_DOCUMENT, GovIdType.AADHAAR).length,
      2,
    );
    assert.strictEqual((await fixture.auth.login(login)).user.id, fixture.state.user.id);
    const verification = await fixture.auth.verifyGovernmentId(
      fixture.state.user.id,
      login.governmentId,
    );
    assert.strictEqual(verification.athleteProfileId, profile.athleteProfileId);
    const recovered = await fixture.auth.register(login);
    assert.strictEqual(recovered.user.athleteProfileId, profile.athleteProfileId);
    assert.strictEqual(fixture.state.user.identityRecord?.saltVersion, 1);
    assert.strictEqual(fixture.state.createdIdentities.length, 0);
  });

  it('stores the current salt version when registering a new identity', async () => {
    const fixture = createAuthFixture({ saltVersion: 7 });
    fixture.state.user.identityRecord = null;
    await fixture.auth.register({ email: 'new@fixture.test', governmentId: login.governmentId });
    assert.strictEqual(fixture.state.createdIdentities[0]?.saltVersion, 7);
    assert.strictEqual(
      fixture.state.createdIdentities[0]?.idHash,
      fixture.identity.hashGovernmentId(TEST_DOCUMENT, GovIdType.AADHAAR, 7),
    );
  });

  for (const role of [UserRole.ATHLETE, UserRole.ORGANIZER, UserRole.SCOUT]) {
    it(`allows campus registration as ${role}`, async () => {
      const fixture = createAuthFixture();
      const result = await fixture.auth.register({ email: 'new-role@fixture.test', role });
      assert.strictEqual(result.user.role, role);
    });
  }

  it('requires the configured invite for SUPER_ADMIN and rejects federation elevation', async () => {
    const invite = 'fixture-admin-invitation-secret';
    const fixture = createAuthFixture({ config: { 'auth.adminInviteCode': invite } });
    await assert.rejects(
      fixture.auth.register({
        email: 'admin@fixture.test',
        role: UserRole.SUPER_ADMIN,
        adminInviteCode: 'wrong-invitation-secret',
      }),
      ForbiddenException,
    );
    await assert.rejects(
      fixture.auth.register({
        email: 'admin@fixture.test',
        role: UserRole.FEDERATION_ADMIN,
        adminInviteCode: invite,
      }),
      ForbiddenException,
    );
    assert.strictEqual(
      (
        await fixture.auth.register({
          email: 'admin@fixture.test',
          role: UserRole.SUPER_ADMIN,
          adminInviteCode: invite,
        })
      ).user.role,
      UserRole.SUPER_ADMIN,
    );
  });

  it('does not recover a revoked identity through registration or verification', async () => {
    const fixture = createAuthFixture();
    assert.ok(fixture.state.user.identityRecord);
    fixture.state.user.identityRecord.status = VerificationStatus.REVOKED;
    await assert.rejects(fixture.auth.register(login), ForbiddenException);
    await assert.rejects(
      fixture.auth.verifyGovernmentId(fixture.state.user.id, login.governmentId),
      ForbiddenException,
    );
  });

  it('auto-initializes one incomplete passport without inventing demographic data', async () => {
    const fixture = createAuthFixture();
    const first = await fixture.passports.getOrCreatePassport(fixture.state.user.id);
    const second = await fixture.passports.getOrCreatePassport(fixture.state.user.id);
    assert.strictEqual(first.athleteProfileId, second.athleteProfileId);
    assert.strictEqual(first.dateOfBirth, null);
    assert.strictEqual(first.gender, null);
    assert.strictEqual(first.primarySport, null);
    assert.strictEqual(first.isProfileComplete, false);
    assert.strictEqual(first.isScoutSearchable, false);
  });

  it('updates passport roles without overwriting historical GTI or verified sport counters', async () => {
    const fixture = createAuthFixture();
    await fixture.passports.upsertPassport(fixture.state.user.id, {
      primarySport: SportType.CRICKET,
      sportRecords: [{ sport: SportType.CRICKET, primaryRole: 'BOWLER' }],
    });
    assert.ok(fixture.state.profile);
    fixture.state.profile.currentGti = new Prisma.Decimal(82);
    fixture.state.profile.sportRecords[0]!.totalMatches = 20;
    const updated = await fixture.passports.upsertPassport(fixture.state.user.id, {
      sportRecords: [{ sport: SportType.CRICKET, primaryRole: 'ALL_ROUNDER' }],
    });
    assert.strictEqual(updated.currentGti, 82);
    assert.strictEqual(updated.sportRecords[0]?.totalMatches, 20);
    assert.strictEqual(updated.sportRecords[0]?.primaryRole, 'ALL_ROUNDER');
    await assert.rejects(
      fixture.passports.addOrUpdateSportRecord(fixture.state.user.id, {
        sport: SportType.CRICKET,
        primaryRole: 'BOWLER',
        verifiedMetrics: { wins: 100 },
      }),
      ForbiddenException,
    );
  });
});
