import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QuestionsService } from './questions.service';
import { SituacionesService } from './questions.service';

import { GenerateQuestionDto } from './dto/generate-question.dto';
import { GenerateSituacionDto } from './dto/generate-situacion.dto';
import { CorregirTextoDto } from './dto/corregir-texto.dto';

@ApiTags('questions')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('questions')


export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generar una pregunta de Saber Pro con el modelo IA' })
  async generate(@Body() dto: GenerateQuestionDto) {
    return this.questionsService.generateQuestion(dto);
  }
}

@ApiTags('situaciones')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('situaciones')
export class SituacionesController {
  constructor(private readonly situacionesService: SituacionesService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generar una situación de escritura de Saber Pro con el modelo IA' })
  async generate(@Body() dto: GenerateSituacionDto) {
    return this.situacionesService.generateSituacion(dto);
  }

  @Post('corregir')
  @ApiOperation({ summary: 'Corregir el texto redactado por el estudiante' })
  async corregir(@Body() dto: CorregirTextoDto) {
    return this.situacionesService.corregirTexto(dto);
  }
}
