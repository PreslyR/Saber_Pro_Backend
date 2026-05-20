import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SendMessageDto, SubjectId } from './dto/send-message.dto';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

const MAX_HISTORY_MESSAGES = 10;

const SUBJECT_NAMES: Record<SubjectId, string> = {
  'razonamiento-cuantitativo': 'Razonamiento Cuantitativo',
  'lectura-critica': 'Lectura Crítica',
  ingles: 'Inglés',
  'competencias-ciudadanas': 'Competencias Ciudadanas',
  'comunicacion-escrita': 'Comunicación Escrita',
};

const BASE_SYSTEM_PROMPT = [
  'Eres Saber, un tutor virtual especializado en preparar estudiantes universitarios colombianos para el examen de estado Saber Pro del ICFES.',
  'Respondes siempre en español, de forma clara, concisa y motivadora.',
  'Tus respuestas deben tener como máximo 150 palabras a menos que el estudiante pida una explicación más extensa.',
  'Usa ejemplos concretos y cotidianos cuando expliques conceptos.',
  'SOLO respondes preguntas académicas relacionadas con los módulos del examen Saber Pro: Razonamiento Cuantitativo, Lectura Crítica, Inglés, Competencias Ciudadanas y Comunicación Escrita.',
  'Si el estudiante hace una pregunta no académica o fuera del contexto del examen, redirigelo amablemente: agradece su curiosidad y pídele que te haga preguntas relacionadas con su preparación para Saber Pro.',
  'No inventes información. Si no sabes algo con certeza, dilo claramente.',
].join(' ');

const buildSystemPrompt = (subjectId?: SubjectId): string => {
  if (!subjectId) {
    return BASE_SYSTEM_PROMPT;
  }

  return `${BASE_SYSTEM_PROMPT} En esta interacción el estudiante está preparando el módulo de ${SUBJECT_NAMES[subjectId]}, enfoca tu respuesta en esa área.`;
};

@Injectable()
export class ChatService {
  private readonly client: OpenAI;
  private readonly modelId: string;
  private readonly conversationHistory = new Map<string, ChatMessage[]>();

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
    this.modelId = this.configService.get<string>('OPENAI_MODEL_ID') ?? 'gpt-4o-mini';
  }

  async sendMessage(
    userId: string,
    dto: SendMessageDto,
  ): Promise<{ reply: string }> {
    const history = this.getHistory(userId);

    history.push({ role: 'user', content: dto.message });

    const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

    try {
      const response = await this.client.chat.completions.create({
        model: this.modelId,
        messages: [
          { role: 'system', content: buildSystemPrompt(dto.subjectId) },
          ...trimmedHistory,
        ],
        max_tokens: 400,
        temperature: 0.6,
      });

      const reply = response.choices[0].message.content?.trim() ?? '';

      trimmedHistory.push({ role: 'assistant', content: reply });
      this.conversationHistory.set(userId, trimmedHistory);

      return { reply };
    } catch (error) {
      console.error('Chat completion failed:', error);
      throw new InternalServerErrorException(
        'Error al procesar el mensaje con el modelo de IA.',
      );
    }
  }

  private getHistory(userId: string): ChatMessage[] {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }

    return [...(this.conversationHistory.get(userId) ?? [])];
  }
}
