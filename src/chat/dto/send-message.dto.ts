import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const SUBJECT_IDS = [
  'razonamiento-cuantitativo',
  'lectura-critica',
  'ingles',
  'competencias-ciudadanas',
  'comunicacion-escrita',
] as const;

export type SubjectId = (typeof SUBJECT_IDS)[number];

export class SendMessageDto {
  @ApiProperty({ example: '¿Cómo se resuelven ecuaciones lineales?' })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiPropertyOptional({ enum: SUBJECT_IDS, example: 'razonamiento-cuantitativo' })
  @IsOptional()
  @IsIn(SUBJECT_IDS)
  subjectId?: SubjectId;
}
