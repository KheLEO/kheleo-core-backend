import { BadRequestException } from '@nestjs/common';
import {
  ClassConstructor,
  Expose,
  plainToInstance,
  Transform,
  TransformFnParams,
} from 'class-transformer';
import { Allow } from 'class-validator';

export function FieldAliases(...aliases: readonly string[]): PropertyDecorator {
  return aliasedProperty(aliases, (value: unknown) => value);
}

export function NestedArrayAliases<T extends object>(
  type: ClassConstructor<T>,
  ...aliases: readonly string[]
): PropertyDecorator {
  return aliasedProperty(aliases, (value: unknown) =>
    Array.isArray(value)
      ? value.map((item: unknown) =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
            ? plainToInstance(type, item)
            : item,
        )
      : value,
  );
}

function aliasedProperty(
  aliases: readonly string[],
  normalize: (value: unknown) => unknown,
): PropertyDecorator {
  return (target: object, property: string | symbol): void => {
    Expose()(target, property);
    for (const alias of aliases) Allow()(target, alias);
    Transform(
      ({ obj }: TransformFnParams): unknown => {
        const source: unknown = obj;
        if (typeof source !== 'object' || source === null) return undefined;
        const record = source as Readonly<Record<string, unknown>>;
        const supplied = [String(property), ...aliases].filter(
          (name) => record[name] !== undefined,
        );
        const selected = record[supplied[0] ?? String(property)];
        if (supplied.some((name) => JSON.stringify(record[name]) !== JSON.stringify(selected))) {
          throw new BadRequestException(`Conflicting aliases for ${String(property)}`);
        }
        return normalize(selected);
      },
      { toClassOnly: true },
    )(target, property);
  };
}
