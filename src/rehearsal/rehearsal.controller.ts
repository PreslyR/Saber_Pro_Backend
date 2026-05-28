import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateRehearsalSessionDto } from './dto/create-rehearsal-session.dto';
import { WrongAnswerDto } from './dto/wrong-answer.dto';
import { RehearsalService } from './rehearsal.service';

@ApiTags('rehearsal')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('rehearsal')
export class RehearsalController {
  constructor(private readonly rehearsalService: RehearsalService) {}

  @Get('wrong-answers/:subjectId')
  @ApiOperation({ summary: 'Obtener respuestas incorrectas para repasar' })
  getWrongAnswers(
    @Req() req: { user: { userId: string } },
    @Param('subjectId') subjectId: string,
  ): Promise<{ data: WrongAnswerDto[] }> {
    return this.rehearsalService.getWrongAnswers(req.user.userId, subjectId);
  }

  @Post('sessions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Guardar una sesion de repaso' })
  createSession(
    @Req() req: { user: { userId: string } },
    @Body() dto: CreateRehearsalSessionDto,
  ) {
    return this.rehearsalService.createSession(req.user.userId, dto);
  }
}
