import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CorregirTextoDto {
  @ApiProperty({
    description: 'La situación de escritura generada previamente',
    example: 'Escribe un texto argumentativo sobre el impacto de las redes sociales...',
  })
  @IsString()
  @IsNotEmpty()
  situacion!: string;

  @ApiProperty({
    description: 'El texto redactado por el estudiante',
    example: 'Considero que las redes sociales tienen un impacto negativo porque...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  texto!: string;
}
