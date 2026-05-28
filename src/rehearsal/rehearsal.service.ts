import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SUBJECT_PROGRESS_IDS } from '../progress/progress.constants';
import { CreateRehearsalSessionDto } from './dto/create-rehearsal-session.dto';
import { WrongAnswerDto } from './dto/wrong-answer.dto';

@Injectable()
export class RehearsalService {
  constructor(private readonly prisma: PrismaService) {}

  async getWrongAnswers(
    userId: string,
    subjectId: string,
  ): Promise<{ data: WrongAnswerDto[] }> {
    if (!SUBJECT_PROGRESS_IDS.includes(subjectId as typeof SUBJECT_PROGRESS_IDS[number])) {
      throw new BadRequestException('Materia no valida');
    }

    // Find sourceAnswerIds already rehearsed correctly by this user
    const rehearsedCorrect = await this.prisma.rehearsalAnswer.findMany({
      where: {
        isCorrect: true,
        session: {
          userId,
          subjectId,
        },
      },
      select: {
        sourceAnswerId: true,
      },
    });

    const rehearsedIds = rehearsedCorrect.map((r) => r.sourceAnswerId);

    const quizAnswers = await this.prisma.quizAnswer.findMany({
      where: {
        attempt: {
          userId,
          subjectId,
        },
        isCorrect: false,
        ...(rehearsedIds.length > 0
          ? { id: { notIn: rehearsedIds } }
          : {}),
      },
      select: {
        id: true,
        statement: true,
        options: true,
        correctOptionId: true,
        explanation: true,
      },
      orderBy: {
        id: 'asc',
      },
    });

    return {
      data: quizAnswers.map((qa) => ({
        id: qa.id,
        statement: qa.statement,
        options: qa.options as Record<string, unknown>,
        correctOptionId: qa.correctOptionId,
        explanation: qa.explanation,
        sourceAnswerId: qa.id,
      })),
    };
  }

  async createSession(userId: string, dto: CreateRehearsalSessionDto) {
    if (!SUBJECT_PROGRESS_IDS.includes(dto.subjectId as typeof SUBJECT_PROGRESS_IDS[number])) {
      throw new BadRequestException('Materia no valida');
    }

    const sourceAnswerIds = dto.answers.map((a) => a.sourceAnswerId);

    // Look up source QuizAnswers to snapshot question data
    const sourceAnswers = await this.prisma.quizAnswer.findMany({
      where: { id: { in: sourceAnswerIds } },
      select: {
        id: true,
        statement: true,
        options: true,
        correctOptionId: true,
        explanation: true,
      },
    });

    // If any sourceAnswerId refers to a deleted QuizAnswer, reject the session
    if (sourceAnswers.length !== new Set(sourceAnswerIds).size) {
      throw new BadRequestException(
        'Alguna respuesta fuente no fue encontrada. Vuelve a cargar las preguntas e intentalo de nuevo.',
      );
    }

    const sourceMap = new Map(sourceAnswers.map((sa) => [sa.id, sa]));

    // NOTE (trust point): isCorrect is accepted from the client.
    // The client computes it by comparing selectedOptionId against correctOptionId
    // (already available from the GET response). If this becomes a concern,
    // add correctOptionId to the POST DTO and validate server-side.
    const correctAnswers = dto.answers.filter((a) => a.isCorrect).length;

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.rehearsalSession.create({
        data: {
          userId,
          subjectId: dto.subjectId,
          totalQuestions: dto.answers.length,
          correctAnswers,
        },
      });

      await tx.rehearsalAnswer.createMany({
        data: dto.answers.map((a) => {
          const source = sourceMap.get(a.sourceAnswerId)!;
          return {
            sessionId: session.id,
            sourceAnswerId: a.sourceAnswerId,
            statement: source.statement,
            options: source.options as Prisma.InputJsonValue,
            selectedOptionId: a.selectedOptionId,
            correctOptionId: source.correctOptionId,
            isCorrect: a.isCorrect,
            explanation: source.explanation,
          };
        }),
      });

      return {
        id: session.id,
        userId: session.userId,
        subjectId: session.subjectId,
        totalQuestions: session.totalQuestions,
        correctAnswers: session.correctAnswers,
        finishedAt: session.finishedAt,
      };
    });
  }
}
