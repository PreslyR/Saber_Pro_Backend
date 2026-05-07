import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum Competencia {
  RAZONAMIENTO_CUANTITATIVO = 'Razonamiento cuantitativo',
  COMPETENCIAS_CIUDADANAS = 'Competencias ciudadanas',
  INGLES = 'Inglés',
}

export class GenerateQuestionDto {
  @ApiProperty({ enum: Competencia })
  @IsEnum(Competencia)
  competencia!: Competencia;
}
