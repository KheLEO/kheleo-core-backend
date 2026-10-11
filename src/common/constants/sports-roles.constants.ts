export const CRICKET_ROLES = [
  'OPENING_BATSMAN',
  'TOP_ORDER_BATSMAN',
  'MIDDLE_ORDER_BATSMAN',
  'WICKETKEEPER',
  'FAST_BOWLER',
  'SPIN_BOWLER',
  'ALL_ROUNDER',
] as const;

export const FOOTBALL_ROLES = [
  'GOALKEEPER',
  'CENTER_BACK',
  'FULL_BACK',
  'DEFENSIVE_MIDFIELDER',
  'CENTRAL_MIDFIELDER',
  'ATTACKING_MIDFIELDER',
  'WINGER',
  'STRIKER',
] as const;

export const BADMINTON_ROLES = ['SINGLES', 'DOUBLES_FRONT', 'DOUBLES_REAR'] as const;

export const ATHLETICS_ROLES = [
  'SPRINTER',
  'MIDDLE_DISTANCE',
  'LONG_DISTANCE',
  'JUMPER',
  'THROWER',
] as const;

export const BASKETBALL_ROLES = [
  'POINT_GUARD',
  'SHOOTING_GUARD',
  'SMALL_FORWARD',
  'POWER_FORWARD',
  'CENTER',
] as const;

export const KABADDI_ROLES = [
  'RAIDER',
  'LEFT_CORNER',
  'RIGHT_CORNER',
  'LEFT_COVER',
  'RIGHT_COVER',
  'LEFT_IN',
  'RIGHT_IN',
] as const;

export type CricketRole = (typeof CRICKET_ROLES)[number];
export type FootballRole = (typeof FOOTBALL_ROLES)[number];
export type BadmintonRole = (typeof BADMINTON_ROLES)[number];
export type AthleticsRole = (typeof ATHLETICS_ROLES)[number];
export type BasketballRole = (typeof BASKETBALL_ROLES)[number];
export type KabaddiRole = (typeof KABADDI_ROLES)[number];

export const SPORT_ROLES_MAP: Record<string, readonly string[]> = {
  CRICKET: CRICKET_ROLES,
  FOOTBALL: FOOTBALL_ROLES,
  BADMINTON: BADMINTON_ROLES,
  ATHLETICS: ATHLETICS_ROLES,
  BASKETBALL: BASKETBALL_ROLES,
  KABADDI: KABADDI_ROLES,
};
