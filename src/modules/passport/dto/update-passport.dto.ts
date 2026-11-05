import { PartialType } from '@nestjs/swagger';
import { CreatePassportDto } from './create-passport.dto';

export class UpdatePassportDto extends PartialType(CreatePassportDto) {}
