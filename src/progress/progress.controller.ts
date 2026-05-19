import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateQuizAttemptDto } from './dto/create-quiz-attempt.dto';
import { ProgressService } from './progress.service';

@ApiTags('progress')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('progress')
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  @Get('me')
  @ApiOperation({ summary: 'Obtener progreso del usuario autenticado' })
  getMyProgress(@Req() req: { user: { userId: string } }) {
    return this.progressService.getDashboard(req.user.userId);
  }

  @Post('attempts')
  @ApiOperation({ summary: 'Guardar un intento finalizado de quiz' })
  createAttempt(
    @Req() req: { user: { userId: string } },
    @Body() dto: CreateQuizAttemptDto,
  ) {
    return this.progressService.saveAttempt(req.user.userId, dto);
  }
}
