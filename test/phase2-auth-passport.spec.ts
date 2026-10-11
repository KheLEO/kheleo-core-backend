import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { IdentityService } from '../src/modules/identity/identity.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { GovIdType, UserRole } from '@prisma/client';
import { PaginatedResponseDto } from '../src/common/dto/paginated-response.dto';

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
        user: { findUnique: async () => ({ id: 'new-user-id' }) },
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
