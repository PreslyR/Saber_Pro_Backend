import { Module } from '@nestjs/common';
import { QuestionsController, SituacionesController } from './questions.controller';
import { QuestionsService, SituacionesService } from './questions.service';

@Module({
  controllers: [QuestionsController, SituacionesController],
  providers: [QuestionsService, SituacionesService],
})
export class QuestionsModule {}
