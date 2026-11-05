import { ForbiddenException } from '@nestjs/common';
import { VerificationStatus } from '@prisma/client';

interface AccountAccessState {
  readonly isActive: boolean;
  readonly identityRecord?: { readonly status: VerificationStatus } | null;
}

export function assertIdentityAccess(status: VerificationStatus | undefined): void {
  if (status === VerificationStatus.REVOKED || status === VerificationStatus.FLAGGED_DUPLICATE) {
    throw new ForbiddenException('Identity verification status does not permit access');
  }
}

export function assertAccountAccess(user: AccountAccessState): void {
  if (!user.isActive) throw new ForbiddenException('Account is deactivated');
  assertIdentityAccess(user.identityRecord?.status);
}

export function assertVerifiedAthlete(user: AccountAccessState): void {
  assertAccountAccess(user);
  if (user.identityRecord?.status !== VerificationStatus.VERIFIED) {
    throw new ForbiddenException('Verified identity is required for tournament participation');
  }
}
