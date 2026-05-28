import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum Competencia {
  RAZONAMIENTO_CUANTITATIVO = 'Razonamiento cuantitativo',
  COMPETENCIAS_CIUDADANAS = 'Competencias ciudadanas',
  INGLES = 'Inglés',
}

export enum Dificultad {
  BASIC = 'basic',
  INTERMEDIATE = 'intermediate',
  ADVANCED = 'advanced',
}

export class GenerateQuestionDto {
  @ApiProperty({ enum: Competencia })
  @IsEnum(Competencia)
  competencia!: Competencia;

  @ApiPropertyOptional({ enum: Dificultad, default: Dificultad.BASIC })
  @IsOptional()
  @IsEnum(Dificultad)
  dificultad?: Dificultad;
}

