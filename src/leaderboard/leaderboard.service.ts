import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  XP_PER_CORRECT_ANSWER,
  XP_PER_LEVEL,
} from '../progress/progress.constants';
import { LeaderboardResponseDto } from './dto/leaderboard-response.dto';

const LEADERBOARD_TOP = 10;

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(): Promise<LeaderboardResponseDto> {
    const aggregations = await this.prisma.quizAttempt.groupBy({
      by: ['userId'],
      _sum: { correctAnswers: true },
      orderBy: { _sum: { correctAnswers: 'desc' } },
      take: LEADERBOARD_TOP,
    });

    if (aggregations.length === 0) {
      return { entries: [] };
    }

    const userIds = aggregations.map((a) => a.userId);

    const [users, attempts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, nombre: true, apellido: true },
      }),
      this.prisma.quizAttempt.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, finishedAt: true },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));

    const attemptDaysByUser = new Map<string, Set<string>>();
    for (const attempt of attempts) {
      const dayKey = this.toDateKey(attempt.finishedAt);
      const days = attemptDaysByUser.get(attempt.userId) ?? new Set<string>();
      days.add(dayKey);
      attemptDaysByUser.set(attempt.userId, days);
    }

    const todayKey = this.toDateKey(new Date());

    const entries = aggregations.map((agg, index) => {
      const totalCorrect = agg._sum.correctAnswers ?? 0;
      const xp = totalCorrect * XP_PER_CORRECT_ANSWER;
      const level = Math.floor(xp / XP_PER_LEVEL) + 1;

      const user = userMap.get(agg.userId);
      const username = user
        ? [user.nombre, user.apellido].filter(Boolean).join(' ').trim()
        : agg.userId;

      const uniqueDays =
        attemptDaysByUser.get(agg.userId) ?? new Set<string>();
      const streak = this.calculateStreak(uniqueDays, todayKey);

      return {
        rank: index + 1,
        userId: agg.userId,
        username,
        xp,
        streak,
        level,
      };
    });

    return { entries };
  }

  private calculateStreak(
    daysWithAttempts: Set<string>,
    todayKey: string,
  ): number {
    let streak = 0;
    let cursor = todayKey;

    while (daysWithAttempts.has(cursor)) {
      streak += 1;
      cursor = this.getPreviousDateKey(cursor);
    }

    return streak;
  }

  private getPreviousDateKey(dateKey: string): string {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  private toDateKey(date: Date): string {
    const parts = DAY_FORMATTER.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';

    return `${year}-${month}-${day}`;
  }
}
