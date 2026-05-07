import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QuestionsService } from './questions.service';
import { GenerateQuestionDto } from './dto/generate-question.dto';

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
