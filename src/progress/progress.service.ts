import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateQuizAttemptDto } from './dto/create-quiz-attempt.dto';
import {
  DAILY_GOAL_TARGET,
  DEFAULT_OBJECTIVE,
  SUBJECT_PROGRESS_IDS,
  SUBJECT_PROGRESS_TARGETS,
  XP_PER_CORRECT_ANSWER,
  XP_PER_LEVEL,
} from './progress.constants';

type SubjectId = (typeof SUBJECT_PROGRESS_IDS)[number];

interface SubjectProgressSummary {
  subjectId: SubjectId;
  completedQuestions: number;
  totalQuestions: number;
  correctAnswers: number;
  lastAttempt?: string;
}

interface UserProgressSummary {
  userId: string;
  username: string;
  subjects: Record<SubjectId, SubjectProgressSummary>;
}

interface UserStatsSummary {
  level: number;
  xp: number;
  xpToNextLevel: number;
  streak: number;
  questionsToday: number;
  dailyGoalCompleted: number;
  dailyGoalTarget: number;
  overallCompletionPct: number;
  objective: {
    name: string;
    description: string;
  };
}

export interface ProgressDashboardResponse {
  userProgress: UserProgressSummary;
  stats: UserStatsSummary;
}

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async saveAttempt(userId: string, dto: CreateQuizAttemptDto) {
    const correctAnswers = dto.answers.reduce(
      (total, answer) =>
        total + Number(answer.selectedOptionId === answer.correctOptionId),
      0,
    );

    return this.prisma.quizAttempt.create({
      data: {
        userId,
        subjectId: dto.subjectId,
        totalQuestions: dto.answers.length,
        correctAnswers,
        answers: {
          create: dto.answers.map((answer, index) => ({
            questionOrder: index,
            statement: answer.statement,
            options: answer.options as unknown as Prisma.InputJsonValue,
            selectedOptionId: answer.selectedOptionId,
            correctOptionId: answer.correctOptionId,
            isCorrect: answer.selectedOptionId === answer.correctOptionId,
            explanation: answer.explanation,
          })),
        },
      },
      select: {
        id: true,
        subjectId: true,
        totalQuestions: true,
        correctAnswers: true,
        finishedAt: true,
      },
    });
  }

  async getDashboard(userId: string): Promise<ProgressDashboardResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nombre: true,
        apellido: true,
      },
    });

    if (!user) {
      throw new NotFoundException(
        `Usuario autenticado con ID ${userId} no encontrado`,
      );
    }

    const attempts = await this.prisma.quizAttempt.findMany({
      where: { userId },
      select: {
        subjectId: true,
        totalQuestions: true,
        correctAnswers: true,
        finishedAt: true,
      },
      orderBy: {
        finishedAt: 'asc',
      },
    });

    const subjects = this.buildEmptySubjects();

    let totalCorrectAnswers = 0;
    let questionsToday = 0;
    let dailyGoalCompleted = 0;

    const todayKey = this.toDateKey(new Date());
    const uniqueAttemptDays = new Set<string>();

    for (const attempt of attempts) {
      if (this.isKnownSubject(attempt.subjectId)) {
        const subject = subjects[attempt.subjectId];
        subject.completedQuestions += attempt.totalQuestions;
        subject.correctAnswers += attempt.correctAnswers;
        subject.lastAttempt = attempt.finishedAt.toISOString();
      }

      totalCorrectAnswers += attempt.correctAnswers;

      const attemptDay = this.toDateKey(attempt.finishedAt);
      uniqueAttemptDays.add(attemptDay);

      if (attemptDay === todayKey) {
        questionsToday += attempt.totalQuestions;
        dailyGoalCompleted += 1;
      }
    }

    const xp = totalCorrectAnswers * XP_PER_CORRECT_ANSWER;
    const level = Math.floor(xp / XP_PER_LEVEL) + 1;
    const xpToNextLevel = level * XP_PER_LEVEL;

    const totalCompleted = Object.values(subjects).reduce(
      (sum, subject) =>
        sum + Math.min(subject.completedQuestions, subject.totalQuestions),
      0,
    );
    const totalTarget = Object.values(subjects).reduce(
      (sum, subject) => sum + subject.totalQuestions,
      0,
    );
    const overallCompletionPct =
      totalTarget > 0 ? Math.round((totalCompleted / totalTarget) * 100) : 0;

    return {
      userProgress: {
        userId: user.id,
        username: [user.nombre, user.apellido].filter(Boolean).join(' ').trim(),
        subjects,
      },
      stats: {
        level,
        xp,
        xpToNextLevel,
        streak: this.calculateStreak(uniqueAttemptDays, todayKey),
        questionsToday,
        dailyGoalCompleted,
        dailyGoalTarget: DAILY_GOAL_TARGET,
        overallCompletionPct,
        objective: {
          name: DEFAULT_OBJECTIVE.name,
          description: DEFAULT_OBJECTIVE.description,
        },
      },
    };
  }

  private buildEmptySubjects(): Record<SubjectId, SubjectProgressSummary> {
    return SUBJECT_PROGRESS_IDS.reduce(
      (acc, subjectId) => {
        acc[subjectId] = {
          subjectId,
          completedQuestions: 0,
          totalQuestions: SUBJECT_PROGRESS_TARGETS[subjectId],
          correctAnswers: 0,
        };

        return acc;
      },
      {} as Record<SubjectId, SubjectProgressSummary>,
    );
  }

  private isKnownSubject(subjectId: string): subjectId is SubjectId {
    return SUBJECT_PROGRESS_IDS.includes(subjectId as SubjectId);
  }

  private calculateStreak(daysWithAttempts: Set<string>, todayKey: string): number {
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
