import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener el top 10 de usuarios por XP' })
  getLeaderboard() {
    return this.leaderboardService.getLeaderboard();
  }
}
