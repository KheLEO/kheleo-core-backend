import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { BracketType } from '@prisma/client';

export class CreateBracketDto {
  @ApiProperty({ example: 'Under-19 Gold Tier' })
  @IsString()
  @IsNotEmpty()
  readonly name!: string;

  @ApiProperty({ example: 'GOLD' })
  @IsString()
  @IsNotEmpty()
  readonly tierName!: string;

  @ApiProperty({
    example: 45.0,
    description: 'Minimum GTI threshold for entry',
  })
  @IsNumber()
  readonly minGti!: number;

  @ApiProperty({
    example: 70.0,
    description: 'Maximum GTI ceiling (Anti-Sandbagging limit)',
  })
  @IsNumber()
  readonly maxGti!: number;

  @ApiPropertyOptional({
    example: 500.0,
    description: 'Registration entry fee',
  })
  @IsOptional()
  @IsNumber()
  readonly entryFee?: number;

  @ApiPropertyOptional({ example: 16, default: 16 })
  @IsOptional()
  @IsInt()
  @Min(2)
  readonly maxTeams?: number;

  @ApiPropertyOptional({
    enum: BracketType,
    default: BracketType.SINGLE_ELIMINATION,
  })
  @IsOptional()
  @IsEnum(BracketType)
  readonly bracketType?: BracketType;
}
