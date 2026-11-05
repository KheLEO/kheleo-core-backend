export interface RoleSlotRequirement {
  readonly slotName: string;
  readonly rolePattern: RegExp;
}

export interface RoleCandidate {
  readonly primaryRole: string;
  readonly secondaryRole: string | null;
}

export interface RoleAssignment<T extends RoleCandidate> {
  readonly slotName: string;
  readonly candidate: T;
}

export interface MatchingGtiBounds<T> {
  readonly minGti: number;
  readonly maxGti: number;
  readonly score: (candidate: T) => number;
  readonly identity?: (candidate: T) => string;
}

export function matchRoleSlots<T extends RoleCandidate>(
  candidates: readonly T[],
  slots: readonly RoleSlotRequirement[],
  bounds?: MatchingGtiBounds<T>,
): readonly RoleAssignment<T>[] | null {
  if (candidates.length < slots.length) return null;
  const matchesRole = (pattern: RegExp, role: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(role);
  };
  const choices = slots.map((slot) =>
    candidates.flatMap((candidate, index) =>
      matchesRole(slot.rolePattern, candidate.primaryRole) ||
      (candidate.secondaryRole !== null && matchesRole(slot.rolePattern, candidate.secondaryRole))
        ? [index]
        : [],
    ),
  );
  if (choices.some((indices) => indices.length === 0)) return null;
  const scores = candidates.map((candidate) => (bounds ? bounds.score(candidate) : 0));
  if (scores.some((score) => !Number.isFinite(score)))
    throw new Error('Candidate GTI must be finite');
  const minTotal = (bounds?.minGti ?? -Infinity) * slots.length;
  const maxTotal = (bounds?.maxGti ?? Infinity) * slots.length;
  const ascending = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => a.score - b.score);
  const patterns = slots.map((slot) => `${slot.rolePattern.source}/${slot.rolePattern.flags}`);
  const choiceSets = choices.map((indices) => new Set(indices));
  const signatures = candidates.map(
    (_candidate, index) =>
      `${choiceSets.flatMap((indices, slot) => (indices.has(index) ? [slot] : [])).join(',')}:${scores[index]}`,
  );
  const assigned = slots.map(() => -1);
  const identities = candidates.map((candidate, index) =>
    bounds?.identity ? bounds.identity(candidate) : index,
  );
  const used = new Set<string | number>();
  // Identical role slots use increasing indices to avoid permuting the same roster.
  const available = (slot: number, candidate: number): boolean =>
    !used.has(identities[candidate]!) &&
    assigned.every(
      (previous, index) =>
        index >= slot || patterns[index] !== patterns[slot] || previous < candidate,
    );

  const canCompleteRoles = (remaining: readonly number[]): boolean => {
    const owners = new Map<string | number, number>();
    const augment = (slot: number, visited: Set<string | number>): boolean => {
      for (const candidate of choices[slot] ?? []) {
        if (!available(slot, candidate) || visited.has(identities[candidate]!)) continue;
        visited.add(identities[candidate]!);
        const previous = owners.get(identities[candidate]!);
        if (previous === undefined || augment(previous, visited)) {
          owners.set(identities[candidate]!, slot);
          return true;
        }
      }
      return false;
    };
    return remaining.every((slot) => augment(slot, new Set<string | number>()));
  };

  const search = (remaining: readonly number[], total: number): boolean => {
    if (remaining.length === 0)
      return !bounds || (total >= minTotal - 1e-8 && total <= maxTotal + 1e-8);
    if (bounds) {
      // Ignoring role constraints gives optimistic bounds, so feasible rosters are never pruned.
      const unused = ascending.filter((entry) => !used.has(identities[entry.index]!));
      const minimum = unused
        .slice(0, remaining.length)
        .reduce((sum, entry) => sum + entry.score, total);
      const maximum = unused
        .slice(-remaining.length)
        .reduce((sum, entry) => sum + entry.score, total);
      if (minimum > maxTotal + 1e-8 || maximum < minTotal - 1e-8) return false;
    }
    if (!canCompleteRoles(remaining)) return false;
    const constrained = remaining
      .map((slot) => ({
        slot,
        choices: (choices[slot] ?? []).filter((index) => available(slot, index)),
      }))
      .sort((a, b) => a.choices.length - b.choices.length || a.slot - b.slot)[0];
    if (!constrained) return false;
    const equivalent = new Set<string>();
    for (const candidate of constrained.choices) {
      const signature = signatures[candidate]!;
      if (!bounds?.identity && equivalent.has(signature)) continue;
      equivalent.add(signature);
      assigned[constrained.slot] = candidate;
      used.add(identities[candidate]!);
      if (
        search(
          remaining.filter((slot) => slot !== constrained.slot),
          total + scores[candidate]!,
        )
      )
        return true;
      used.delete(identities[candidate]!);
      assigned[constrained.slot] = -1;
    }
    return false;
  };
  if (
    !search(
      slots.map((_slot, index) => index),
      0,
    )
  )
    return null;
  return slots.map((slot, index) => ({
    slotName: slot.slotName,
    candidate: candidates[assigned[index]!]!,
  }));
}
