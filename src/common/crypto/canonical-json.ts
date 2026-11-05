import { BadRequestException } from '@nestjs/common';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new BadRequestException('Request body must contain valid JSON values.');
    return serialized;
  }
  if (Array.isArray(value))
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key: string) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
