
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateSituacionDto {
  @ApiPropertyOptional({
    description: 'Tema para generar la situación. Si se omite, se elige uno aleatorio del listado oficial.',
    example: 'legalización del consumo recreativo de marihuana en Colombia',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tema?: string;
}
