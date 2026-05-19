export const SUBJECT_PROGRESS_TARGETS = {
  'razonamiento-cuantitativo': 60,
  'lectura-critica': 55,
  ingles: 45,
  'competencias-ciudadanas': 40,
  'comunicacion-escrita': 35,
} as const;

export const SUBJECT_PROGRESS_IDS = Object.keys(
  SUBJECT_PROGRESS_TARGETS,
) as Array<keyof typeof SUBJECT_PROGRESS_TARGETS>;

export const DAILY_GOAL_TARGET = 10;
export const XP_PER_CORRECT_ANSWER = 10;
export const XP_PER_LEVEL = 100;
export const DEFAULT_OBJECTIVE = {
  name: 'Saber Pro ICFES',
  description:
    'Prepararte para el examen de estado con practica constante en todas las areas evaluadas.',
} as const;
