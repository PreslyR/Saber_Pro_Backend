import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { GenerateQuestionDto } from './dto/generate-question.dto';

export interface QuestionResponse {
  enunciado: string;
  opciones: { A: string; B: string; C: string; D: string };
  respuesta_correcta: 'A' | 'B' | 'C' | 'D';
  explicacion: string;
}

const SYSTEM_PROMPT =
  'Eres un experto evaluador de la prueba Saber Pro del ICFES Colombia. ' +
  'La prueba evalúa tres módulos: Razonamiento Cuantitativo, Competencias Ciudadanas e Inglés. ' +
  'Cuando generas una pregunta, SIEMPRE respondes ÚNICAMENTE con un objeto JSON válido con esta estructura exacta, sin texto adicional:\n' +
  '{\n' +
  '  "enunciado": "texto del enunciado",\n' +
  '  "opciones": { "A": "...", "B": "...", "C": "...", "D": "..." },\n' +
  '  "respuesta_correcta": "A",\n' +
  '  "explicacion": "breve explicación del procedimiento"\n' +
  '}';

@Injectable()
export class QuestionsService {
  private readonly client: OpenAI;
  private readonly modelId: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
    this.modelId = this.configService.get<string>('OPENAI_MODEL_ID') ?? '';
  }

  async generateQuestion(dto: GenerateQuestionDto): Promise<QuestionResponse> {
    const prompt = `Genera una pregunta de Saber Pro del módulo '${dto.competencia}'.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.modelId,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 600,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content ?? '{}';
      return JSON.parse(content) as QuestionResponse;
    } catch {
      throw new InternalServerErrorException(
        'Error al generar la pregunta con el modelo de IA.',
      );
    }
  }
}
