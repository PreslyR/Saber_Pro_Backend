import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  ValidateNested,
} from 'class-validator';
import { SUBJECT_PROGRESS_IDS } from '../../progress/progress.constants';

const OPTION_IDS = ['A', 'B', 'C', 'D'] as const;

export class RehearsalAnswerDto {
  @ApiProperty({ example: 42, description: 'ID logico de la QuizAnswer fuente' })
  @IsInt()
  sourceAnswerId!: number;

  @ApiProperty({ example: 'B', enum: OPTION_IDS })
  @IsIn(OPTION_IDS)
  selectedOptionId!: 'A' | 'B' | 'C' | 'D';

  @ApiProperty({ example: true })
  @IsBoolean()
  isCorrect!: boolean;
}

export class CreateRehearsalSessionDto {
  @ApiProperty({ enum: SUBJECT_PROGRESS_IDS })
  @IsIn(SUBJECT_PROGRESS_IDS)
  subjectId!: string;

  @ApiProperty({ type: [RehearsalAnswerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RehearsalAnswerDto)
  answers!: RehearsalAnswerDto[];
}
