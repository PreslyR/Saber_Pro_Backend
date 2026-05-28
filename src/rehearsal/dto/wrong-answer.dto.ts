import { ApiProperty } from '@nestjs/swagger';

export class WrongAnswerDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Enunciado de la pregunta' })
  statement!: string;

  @ApiProperty({
    example: [
      { id: 'A', text: 'Opcion A' },
      { id: 'B', text: 'Opcion B' },
      { id: 'C', text: 'Opcion C' },
      { id: 'D', text: 'Opcion D' },
    ],
  })
  options!: Record<string, unknown>;

  @ApiProperty({ example: 'C' })
  correctOptionId!: string;

  @ApiProperty({ example: 'Explicacion de la respuesta correcta' })
  explanation!: string;

  @ApiProperty({ example: 42, description: 'ID de la QuizAnswer fuente' })
  sourceAnswerId!: number;
}
