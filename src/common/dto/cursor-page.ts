export interface CursorPage<T> {
  readonly data: T[];
  readonly nextCursor: string | null;
}
