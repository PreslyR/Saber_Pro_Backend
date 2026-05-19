import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';
import { SUBJECT_PROGRESS_IDS } from '../progress.constants';

const OPTION_IDS = ['A', 'B', 'C', 'D'] as const;

class QuizOptionDto {
  @ApiProperty({ example: 'A' })
  @IsIn(OPTION_IDS)
  id!: 'A' | 'B' | 'C' | 'D';

  @ApiProperty({ example: 'Texto de la opcion' })
  @IsString()
  text!: string;
}

class QuizAnswerDto {
  @ApiProperty({ example: 'Enunciado de la pregunta' })
  @IsString()
  statement!: string;

  @ApiProperty({ type: [QuizOptionDto] })
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  options!: QuizOptionDto[];

  @ApiProperty({ example: 'B' })
  @IsIn(OPTION_IDS)
  selectedOptionId!: 'A' | 'B' | 'C' | 'D';

  @ApiProperty({ example: 'C' })
  @IsIn(OPTION_IDS)
  correctOptionId!: 'A' | 'B' | 'C' | 'D';

  @ApiProperty({ example: 'Explicacion corta de la respuesta correcta' })
  @IsString()
  explanation!: string;
}

export class CreateQuizAttemptDto {
  @ApiProperty({ enum: SUBJECT_PROGRESS_IDS })
  @IsIn(SUBJECT_PROGRESS_IDS)
  subjectId!: string;

  @ApiProperty({ type: [QuizAnswerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];
}
