import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { GenerateQuestionDto } from './dto/generate-question.dto';
import { GenerateSituacionDto } from './dto/generate-situacion.dto';
import { CorregirTextoDto } from './dto/corregir-texto.dto';

const OPTION_IDS = ['A', 'B', 'C', 'D'] as const;
const MAX_GENERATION_ATTEMPTS = 5;

type OptionId = (typeof OPTION_IDS)[number];

interface RawQuestionResponse {
  enunciado: string;
  opciones: Record<OptionId, string>;
}

interface VerifiedAnswerResponse {
  respuesta_correcta_texto: string;
  resultado_final: string;
}

interface ExplanationResponse {
  explicacion: string;
}

interface QuantitativeTemplateQuestion {
  enunciado: string;
  correctOptionText: string;
  distractorOptionTexts: [string, string, string];
  explicacion: string;
}

export interface QuestionResponse {
  enunciado: string;
  opciones: Record<OptionId, string>;
  respuesta_correcta: OptionId;
  explicacion: string;
}

const GENERATION_SYSTEM_PROMPT = [
  'Eres un experto evaluador de la prueba Saber Pro del ICFES Colombia.',
  'La prueba evalua tres modulos: Razonamiento Cuantitativo, Competencias Ciudadanas e Ingles.',
  'Cuando generas una pregunta, responde unicamente con un objeto JSON valido y sin texto adicional.',
  'El JSON debe tener exactamente las claves "enunciado" y "opciones".',
  '"opciones" debe ser un objeto con las claves "A", "B", "C" y "D".',
  'Debe haber una sola opcion correcta y tres distractores plausibles.',
  'La pregunta debe estar bien planteada y una de las cuatro opciones debe coincidir exactamente con la respuesta correcta.',
].join(' ');

const ANSWER_VERIFICATION_SYSTEM_PROMPT = [
  'Eres un evaluador experto y verificas una pregunta de opcion multiple.',
  'Debes resolverla desde cero usando el enunciado y las opciones dadas.',
  'Calcula con cuidado antes de responder.',
  'Responde unicamente con un objeto JSON valido y sin texto adicional.',
  'El JSON debe tener exactamente las claves "respuesta_correcta_texto" y "resultado_final".',
  '"resultado_final" debe contener la respuesta final calculada en texto plano, nunca una letra como A, B, C o D.',
  '"respuesta_correcta_texto" debe ser exactamente igual al texto de una sola de las opciones provistas.',
  'Si ninguna opcion coincide exactamente con la respuesta correcta, si hay mas de una correcta o si la pregunta es ambigua, devuelve "NINGUNA" en "respuesta_correcta_texto".',
].join(' ');

const EXPLANATION_SYSTEM_PROMPT = [
  'Eres un evaluador experto y explicas por que una respuesta ya verificada es correcta.',
  'No debes cambiar, sustituir ni contradecir la respuesta correcta provista.',
  'Responde unicamente con un objeto JSON valido y sin texto adicional.',
  'El JSON debe tener exactamente la clave "explicacion".',
  'La explicacion debe justificar por que la respuesta correcta dada es valida.',
  'La explicacion debe mencionar explicitamente el resultado final provisto.',
].join(' ');

const normalizeComparableText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\$/g, '')
    .replace(/(?<=\d)\.(?=\d{3}(\D|$))/g, '')
    .replace(/(?<=\d),(?=\d)/g, '.')
    .replace(/\s+/g, '');

const shuffleArray = <T>(values: T[]): T[] => {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }

  return shuffled;
};

const assertValidRawQuestionResponse: (
  value: unknown,
) => asserts value is RawQuestionResponse = (value) => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('La respuesta del modelo no es un objeto.');
  }

  const question = value as Partial<RawQuestionResponse>;

  if (typeof question.enunciado !== 'string' || !question.enunciado.trim()) {
    throw new Error('El enunciado no es valido.');
  }

  if (typeof question.opciones !== 'object' || question.opciones === null) {
    throw new Error('Las opciones no son validas.');
  }

  for (const optionId of OPTION_IDS) {
    const optionText = question.opciones[optionId];

    if (typeof optionText !== 'string' || !optionText.trim()) {
      throw new Error(`La opcion ${optionId} no es valida.`);
    }
  }
};

const assertValidVerifiedAnswerResponse: (
  value: unknown,
) => asserts value is VerifiedAnswerResponse = (value) => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('La verificacion del modelo no es un objeto.');
  }

  const verification = value as Partial<VerifiedAnswerResponse>;

  if (
    typeof verification.respuesta_correcta_texto !== 'string' ||
    !verification.respuesta_correcta_texto.trim()
  ) {
    throw new Error('La respuesta correcta en texto no es valida.');
  }

  if (
    typeof verification.resultado_final !== 'string' ||
    !verification.resultado_final.trim()
  ) {
    throw new Error('El resultado final verificado no es valido.');
  }
};

const assertValidExplanationResponse: (
  value: unknown,
) => asserts value is ExplanationResponse = (value) => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('La explicacion del modelo no es un objeto.');
  }

  const explanation = value as Partial<ExplanationResponse>;

  if (
    typeof explanation.explicacion !== 'string' ||
    !explanation.explicacion.trim()
  ) {
    throw new Error('La explicacion verificada no es valida.');
  }
};

const resolveMatchingOptionIds = (
  options: Record<OptionId, string>,
  candidateValue: string,
  allowOptionId: boolean,
): OptionId[] => {
  if (allowOptionId && OPTION_IDS.includes(candidateValue as OptionId)) {
    return [candidateValue as OptionId];
  }

  const normalizedCandidateValue = normalizeComparableText(candidateValue);

  if (!normalizedCandidateValue) {
    return [];
  }

  return OPTION_IDS.filter(
    (optionId) =>
      normalizeComparableText(options[optionId]) === normalizedCandidateValue,
  );
};

const resolveCorrectOptionId = (
  options: Record<OptionId, string>,
  verification: VerifiedAnswerResponse,
): OptionId => {
  if (verification.respuesta_correcta_texto === 'NINGUNA') {
    throw new Error('La pregunta generada no tiene una opcion correcta unica.');
  }

  const matchingResultOptionIds = resolveMatchingOptionIds(
    options,
    verification.resultado_final,
    false,
  );

  if (matchingResultOptionIds.length > 1) {
    throw new Error('El resultado_final coincide con mas de una opcion.');
  }

  // resultado_final no coincidio exactamente: usar respuesta_correcta_texto como fuente primaria
  if (matchingResultOptionIds.length === 0) {
    const matchingAnswerOptionIds = resolveMatchingOptionIds(
      options,
      verification.respuesta_correcta_texto,
      true,
    );

    if (matchingAnswerOptionIds.length !== 1) {
      throw new Error(
        'Ni resultado_final ni respuesta_correcta_texto coinciden univocamente con una opcion.',
      );
    }

    return matchingAnswerOptionIds[0];
  }

  // resultado_final coincidio: validar que respuesta_correcta_texto no contradiga
  const matchingAnswerOptionIds = resolveMatchingOptionIds(
    options,
    verification.respuesta_correcta_texto,
    true,
  );

  if (
    matchingAnswerOptionIds.length === 1 &&
    matchingAnswerOptionIds[0] !== matchingResultOptionIds[0]
  ) {
    throw new Error(
      'La respuesta seleccionada no coincide con el resultado final calculado.',
    );
  }

  return matchingResultOptionIds[0];
};

const explanationMentionsAnswer = (
  explanation: string,
  result: string,
  correctOptionText: string,
): boolean => {
  const normalizedExplanation = normalizeComparableText(explanation);

  return [result, correctOptionText].some((value) => {
    const normalizedValue = normalizeComparableText(value);
    return normalizedValue.length > 0 && normalizedExplanation.includes(normalizedValue);
  });
};

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const pickRandom = <T>(values: readonly T[]): T =>
  values[randomInt(0, values.length - 1)];

const formatThousands = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const formatCurrency = (value: number): string => `$${formatThousands(value)}`;

const formatDecimal = (value: number): string => {
  if (Number.isInteger(value)) {
    return value.toString();
  }

  return value.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
};

const formatWithUnit = (
  value: number,
  singularUnit: string,
  pluralUnit: string,
): string => `${formatDecimal(value)} ${Math.abs(value) === 1 ? singularUnit : pluralUnit}`;

const formatHours = (value: number): string => formatWithUnit(value, 'hora', 'horas');
const formatDays = (value: number): string => formatWithUnit(value, 'día', 'días');

const buildDistinctDistractors = (
  correctOptionText: string,
  candidateTexts: string[],
): [string, string, string] => {
  const distractors = Array.from(
    new Set(candidateTexts.filter((text) => text !== correctOptionText)),
  ).slice(0, 3);

  if (distractors.length !== 3) {
    throw new Error('No fue posible construir tres distractores unicos.');
  }

  return [
    distractors[0],
    distractors[1],
    distractors[2],
  ];
};

const buildQuestionResponseFromTemplate = (
  template: QuantitativeTemplateQuestion,
): QuestionResponse => {
  const shuffledOptionTexts = shuffleArray([
    template.correctOptionText,
    ...template.distractorOptionTexts,
  ]);
  const options = {} as Record<OptionId, string>;
  let correctOptionId: OptionId = 'A';

  OPTION_IDS.forEach((optionId, index) => {
    options[optionId] = shuffledOptionTexts[index];

    if (shuffledOptionTexts[index] === template.correctOptionText) {
      correctOptionId = optionId;
    }
  });

  return {
    enunciado: template.enunciado,
    opciones: options,
    respuesta_correcta: correctOptionId,
    explicacion: template.explicacion,
  };
};

const buildLinearEquationQuestion = (): QuantitativeTemplateQuestion => {
  const x = randomInt(2, 12);
  const coefficient = randomInt(2, 6);
  const constant = randomInt(1, 12);
  const total = coefficient * x + constant;
  const correctOptionText = x.toString();
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    (x + 1).toString(),
    Math.max(1, x - 1).toString(),
    (x + 2).toString(),
    Math.max(1, x - 2).toString(),
    (x + coefficient).toString(),
  ]);

  return {
    enunciado: `Si ${coefficient}x + ${constant} = ${total}, ¿cuál es el valor de x?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Restamos ${constant} a ambos lados: ${coefficient}x = ${total - constant}. Luego dividimos entre ${coefficient}: x = ${x}.`,
  };
};

const buildDiscountedPriceQuestion = (): QuantitativeTemplateQuestion => {
  const originalPrice = pickRandom([80000, 120000, 150000, 180000, 240000, 300000]);
  const discountPercent = pickRandom([10, 15, 20, 25, 30]);
  const discountAmount = (originalPrice * discountPercent) / 100;
  const finalPrice = originalPrice - discountAmount;
  const correctOptionText = formatCurrency(finalPrice);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatCurrency(originalPrice),
    formatCurrency(discountAmount),
    formatCurrency(originalPrice + discountAmount),
    formatCurrency(finalPrice + originalPrice * 0.1),
    formatCurrency(Math.max(10000, finalPrice - originalPrice * 0.1)),
  ]);

  return {
    enunciado: `Una tienda ofrece un descuento del ${discountPercent}% sobre el precio original de un artículo. Si el precio original es ${formatCurrency(originalPrice)}, ¿cuál es el precio con descuento?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Calculamos el descuento: ${discountPercent}% de ${formatCurrency(originalPrice)} es ${formatCurrency(discountAmount)}. Entonces el precio final es ${formatCurrency(originalPrice)} - ${formatCurrency(discountAmount)} = ${formatCurrency(finalPrice)}.`,
  };
};

const buildOriginalPriceQuestion = (): QuantitativeTemplateQuestion => {
  const originalPrice = pickRandom([100000, 140000, 180000, 220000, 260000, 320000]);
  const discountPercent = pickRandom([10, 15, 20, 25]);
  const discountedPrice = originalPrice * (1 - discountPercent / 100);
  const correctOptionText = formatCurrency(originalPrice);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatCurrency(discountedPrice),
    formatCurrency(originalPrice - discountedPrice),
    formatCurrency(originalPrice + 20000),
    formatCurrency(Math.max(20000, originalPrice - 20000)),
    formatCurrency(originalPrice + 40000),
  ]);

  return {
    enunciado: `Una tienda aplica un descuento del ${discountPercent}% y el artículo queda en ${formatCurrency(discountedPrice)}. ¿Cuál era el precio original del artículo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Si el descuento es del ${discountPercent}%, el precio con descuento representa el ${100 - discountPercent}% del precio original. Entonces precio original = ${formatCurrency(discountedPrice)} / ${formatDecimal((100 - discountPercent) / 100)} = ${formatCurrency(originalPrice)}.`,
  };
};

const buildWorkerDaysQuestion = (): QuantitativeTemplateQuestion => {
  const baseWorkers = pickRandom([2, 3, 4, 5]);
  const targetWorkers = baseWorkers * pickRandom([2, 3]);
  const targetDays = pickRandom([2, 3, 4, 5, 6]);
  const baseDays = (targetWorkers * targetDays) / baseWorkers;
  const correctOptionText = formatDays(targetDays);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatDays(baseDays),
    formatDays(targetDays + 1),
    formatDays(targetDays + 2),
    formatDays(Math.max(1, targetDays - 1)),
    formatDays(Math.max(1, targetDays - 2)),
  ]);

  return {
    enunciado: `Si ${baseWorkers} trabajadores pueden completar una tarea en ${formatDays(baseDays)}, ¿en cuántos días la completarán ${targetWorkers} trabajadores, trabajando al mismo ritmo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `El trabajo total equivale a ${baseWorkers} × ${formatDecimal(baseDays)} = ${baseWorkers * baseDays} trabajador-días. Si trabajan ${targetWorkers} personas, el tiempo es ${baseWorkers * baseDays} / ${targetWorkers} = ${formatDecimal(targetDays)} días.`,
  };
};

const buildMeetingTrainsQuestion = (): QuantitativeTemplateQuestion => {
  const speedA = pickRandom([60, 70, 80, 90]);
  const speedB = pickRandom([90, 100, 110, 120]);
  const meetingTime = pickRandom([2, 2.5, 3, 3.5, 4, 4.5, 5]);
  const distance = (speedA + speedB) * meetingTime;
  const correctOptionText = formatHours(meetingTime);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatHours(meetingTime + 0.5),
    formatHours(Math.max(1, meetingTime - 0.5)),
    formatHours(meetingTime + 1),
    formatHours(Math.max(1, meetingTime - 1)),
    formatHours(meetingTime + 1.5),
  ]);

  return {
    enunciado: `Un tren sale de la ciudad A hacia la ciudad B a ${speedA} km/h. Al mismo tiempo, otro tren sale de B hacia A a ${speedB} km/h. Si la distancia entre ambas ciudades es ${formatThousands(distance)} km, ¿en cuántas horas se encontrarán?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `La velocidad de acercamiento es ${speedA} + ${speedB} = ${speedA + speedB} km/h. Entonces el tiempo de encuentro es ${formatThousands(distance)} / ${speedA + speedB} = ${formatDecimal(meetingTime)} horas.`,
  };
};

const buildMachineProductionQuestion = (): QuantitativeTemplateQuestion => {
  const ratePerMachineHour = pickRandom([10, 12, 15, 20, 25]);
  const baseMachines = pickRandom([4, 5, 6]);
  const baseHours = pickRandom([6, 8, 10]);
  const targetMachines = pickRandom([7, 8, 9]);
  const targetHours = pickRandom([4, 5, 6]);
  const baseProduction = baseMachines * ratePerMachineHour * baseHours;
  const targetProduction = targetMachines * ratePerMachineHour * targetHours;
  const correctOptionText = formatThousands(targetProduction);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatThousands(baseProduction),
    formatThousands(targetProduction + ratePerMachineHour * targetHours),
    formatThousands(Math.max(100, targetProduction - ratePerMachineHour * targetHours)),
    formatThousands(targetMachines * ratePerMachineHour * baseHours),
    formatThousands(baseMachines * ratePerMachineHour * targetHours),
  ]);

  return {
    enunciado: `Si ${baseMachines} máquinas producen ${formatThousands(baseProduction)} piezas en ${baseHours} horas, ¿cuántas piezas producirán ${targetMachines} máquinas en ${targetHours} horas, trabajando al mismo ritmo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Cada máquina produce ${formatDecimal(ratePerMachineHour)} piezas por hora porque ${formatThousands(baseProduction)} / (${baseMachines} × ${baseHours}) = ${formatDecimal(ratePerMachineHour)}. Entonces ${targetMachines} máquinas en ${targetHours} horas producen ${targetMachines} × ${targetHours} × ${formatDecimal(ratePerMachineHour)} = ${formatThousands(targetProduction)} piezas.`,
  };
};

const buildAverageQuestion = (): QuantitativeTemplateQuestion => {
  const average = pickRandom([12, 15, 18, 20, 24, 28]);
  const values = [average - 3, average - 1, average + 1, average + 3];
  const total = values.reduce((sum, value) => sum + value, 0);
  const correctOptionText = average.toString();
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    (average + 1).toString(),
    (average - 1).toString(),
    (average + 2).toString(),
    (average - 2).toString(),
    (total / 3).toString(),
  ]);

  return {
    enunciado: `Cuatro estudiantes obtuvieron estas calificaciones: ${values.join(', ')}. ?Cual es el promedio de las cuatro calificaciones?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Sumamos las cuatro calificaciones: ${values.join(' + ')} = ${total}. Luego dividimos entre 4: ${total} / 4 = ${average}.`,
  };
};

const buildPercentageIncreaseQuestion = (): QuantitativeTemplateQuestion => {
  const originalValue = pickRandom([50000, 80000, 120000, 150000, 200000]);
  const increasePercent = pickRandom([10, 15, 20, 25, 30]);
  const increaseAmount = (originalValue * increasePercent) / 100;
  const finalValue = originalValue + increaseAmount;
  const correctOptionText = formatCurrency(finalValue);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatCurrency(originalValue),
    formatCurrency(increaseAmount),
    formatCurrency(originalValue - increaseAmount),
    formatCurrency(finalValue + increaseAmount),
    formatCurrency(Math.max(10000, finalValue - increaseAmount / 2)),
  ]);

  return {
    enunciado: `El precio de un curso era ${formatCurrency(originalValue)} y tuvo un aumento del ${increasePercent}%. ?Cual es el nuevo precio del curso?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Calculamos el aumento: ${increasePercent}% de ${formatCurrency(originalValue)} es ${formatCurrency(increaseAmount)}. Entonces el nuevo precio es ${formatCurrency(originalValue)} + ${formatCurrency(increaseAmount)} = ${formatCurrency(finalValue)}.`,
  };
};

const buildUnitConversionQuestion = (): QuantitativeTemplateQuestion => {
  const kilometers = pickRandom([2, 3, 4, 5, 6, 7]);
  const extraMeters = pickRandom([100, 200, 250, 400, 500, 750]);
  const totalMeters = kilometers * 1000 + extraMeters;
  const correctOptionText = `${formatThousands(totalMeters)} m`;
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    `${formatThousands(totalMeters * 10)} m`,
    `${formatThousands(Math.floor(totalMeters / 10))} m`,
    `${formatThousands(kilometers * 1000)} m`,
    `${formatThousands(totalMeters + 500)} m`,
    `${formatThousands(Math.max(100, totalMeters - 500))} m`,
  ]);

  return {
    enunciado: `Una carrera tiene una longitud de ${kilometers} km y ${extraMeters} m. ?Cuantos metros mide en total?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Convertimos ${kilometers} km a metros: ${kilometers} x 1000 = ${formatThousands(kilometers * 1000)} m. Luego sumamos los ${extraMeters} m restantes: ${formatThousands(kilometers * 1000)} + ${extraMeters} = ${formatThousands(totalMeters)} m.`,
  };
};

const buildRectangleAreaQuestion = (): QuantitativeTemplateQuestion => {
  const base = pickRandom([6, 8, 9, 10, 12, 15]);
  const height = pickRandom([4, 5, 6, 7, 8]);
  const area = base * height;
  const perimeter = 2 * (base + height);
  const correctOptionText = `${formatThousands(area)} cm2`;
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    `${formatThousands(perimeter)} cm2`,
    `${formatThousands(base + height)} cm2`,
    `${formatThousands(area + base)} cm2`,
    `${formatThousands(area + height)} cm2`,
    `${formatThousands(Math.max(1, area - base))} cm2`,
  ]);

  return {
    enunciado: `Un rectangulo tiene base de ${base} cm y altura de ${height} cm. ?Cual es el area del rectangulo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `El area de un rectangulo se calcula multiplicando base por altura: ${base} x ${height} = ${area}. Por eso el area es ${area} cm2.`,
  };
};

const buildQuantitativeQuestion = (): QuestionResponse => {
  const templateBuilders = [
    buildLinearEquationQuestion,
    buildDiscountedPriceQuestion,
    buildOriginalPriceQuestion,
    buildWorkerDaysQuestion,
    buildMeetingTrainsQuestion,
    buildMachineProductionQuestion,
    buildAverageQuestion,
    buildPercentageIncreaseQuestion,
    buildUnitConversionQuestion,
    buildRectangleAreaQuestion,
  ] as const;

  return buildQuestionResponseFromTemplate(pickRandom(templateBuilders)());
};

// ─── Situaciones ────────────────────────────────────────────────────────────

const TEMAS_SABER_PRO = [
  // Política y sociedad
  'pena de muerte para feminicidas en Colombia',
  'voto obligatorio en Colombia',
  'reducción de la edad penal a 14 años en Colombia',
  'extradición de colombianos al exterior',
  'financiación estatal de partidos políticos en Colombia',
  'reelección presidencial en Colombia',
  'objeción de conciencia para funcionarios públicos en Colombia',
  // Educación
  'gratuidad total de la educación universitaria pública en Colombia',
  'prohibición de celulares en colegios colombianos',
  'evaluación docente con base en resultados de estudiantes',
  'convalidación automática de títulos extranjeros en Colombia',
  'educación sexual obligatoria desde primaria en Colombia',
  'jornada única escolar en colegios públicos colombianos',
  // Salud y bioética
  'eutanasia activa en Colombia',
  'vacunación obligatoria para menores en Colombia',
  'regulación del consumo de alcohol en espacios públicos',
  'despenalización del aborto en todos los casos en Colombia',
  'prohibición de la venta de cigarrillos en Colombia',
  'legalización del consumo recreativo de marihuana en Colombia',
  // Medio ambiente
  'fracking como fuente de energía en Colombia',
  'prohibición de corridas de toros en Colombia',
  'minería a gran escala en zonas de páramo',
  'impuesto al carbono para empresas colombianas',
  'prohibición de bolsas plásticas de un solo uso en Colombia',
  'veganismo obligatorio en comedores universitarios',
  // Tecnología y trabajo
  'inteligencia artificial en decisiones judiciales en Colombia',
  'regulación estatal de redes sociales en Colombia',
  'semana laboral de cuatro días en Colombia',
  'teletrabajo obligatorio en entidades públicas colombianas',
  'uso de cámaras de vigilancia en espacios públicos colombianos',
  'identificación obligatoria de usuarios en redes sociales',
  // Economía
  'salario mínimo diferencial por regiones en Colombia',
  'impuesto a las grandes fortunas en Colombia',
  'eliminación de impuestos a vehículos eléctricos en Colombia',
  'regulación de precios de arrendamiento en ciudades colombianas',
  'trabajo informal como modalidad legal en Colombia',
  // Cultura y derechos
  'adopción de menores por parejas del mismo sexo en Colombia',
  'matrimonio igualitario en Colombia',
  'consumo de drogas en espacios privados en Colombia',
  'regulación de contenidos en plataformas de streaming en Colombia',
  'enseñanza obligatoria de lenguas indígenas en colegios colombianos',
] as const;

const MAX_SITUACION_ATTEMPTS = 3;

export interface SituacionResponse {
  situacion: string;
  instrucciones: string;
  criterios: string[];
}

export interface CorreccionResponse {
  retroalimentacion: string;
  puntaje: number;
  aspectos_positivos: string;
  aspectos_mejorar: string;
}

const SITUACION_GENERATION_SYSTEM_PROMPT = [
  'Eres un experto evaluador de la prueba Saber Pro del ICFES Colombia, módulo de Escritura.',
  'Genera una situación de escritura auténtica donde el estudiante debe redactar un texto argumentativo u opinativo.',
  'Responde únicamente con un objeto JSON válido y sin texto adicional.',
  'El JSON debe tener exactamente las claves "situacion", "instrucciones" y "criterios".',
  '"situacion" describe el contexto o situación problema que motiva la escritura.',
  '"instrucciones" indica qué debe redactar el estudiante (mínimo de palabras, tipo de texto, posición a defender).',
  '"criterios" lista los criterios con los que se evaluará el texto (coherencia, cohesión, argumentación, vocabulario).',
].join(' ');

const TEXTO_CORRECTION_SYSTEM_PROMPT = [
  'Eres un experto evaluador de la prueba Saber Pro del ICFES Colombia, módulo de Escritura.',
  'Recibirás un JSON con las claves "situacion" y "texto_estudiante".',
  'Evalúa el texto del estudiante según los criterios del módulo de Escritura: coherencia, cohesión, argumentación y uso del lenguaje.',
  'Responde únicamente con un objeto JSON válido y sin texto adicional.',
  'El JSON debe tener exactamente las claves "retroalimentacion", "puntaje", "aspectos_positivos" y "aspectos_mejorar".',
  '"puntaje" es un número entero del 1 al 10 según la calidad del texto.',
  '"retroalimentacion" es un párrafo de evaluación general.',
  '"aspectos_positivos" describe los puntos fuertes del texto.',
  '"aspectos_mejorar" describe los aspectos que el estudiante debe mejorar.',
].join(' ');

const assertValidSituacionResponse: (
  value: unknown,
) => asserts value is SituacionResponse = (value) => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('La respuesta del modelo no es un objeto.');
  }

  const s = value as Partial<SituacionResponse>;

  if (typeof s.situacion !== 'string' || !s.situacion.trim()) {
    throw new Error('El campo "situacion" no es válido.');
  }
  if (typeof s.instrucciones !== 'string' || !s.instrucciones.trim()) {
    throw new Error('El campo "instrucciones" no es válido.');
  }
  if (!Array.isArray(s.criterios) || s.criterios.length === 0) {
    throw new Error('El campo "criterios" no es válido.');
  }
};

const assertValidCorreccionResponse: (
  value: unknown,
) => asserts value is CorreccionResponse = (value) => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('La respuesta de corrección no es un objeto.');
  }

  const c = value as Partial<CorreccionResponse>;

  if (typeof c.retroalimentacion !== 'string' || !c.retroalimentacion.trim()) {
    throw new Error('El campo "retroalimentacion" no es válido.');
  }
  if (typeof c.puntaje !== 'number' || c.puntaje < 1 || c.puntaje > 10) {
    throw new Error('El campo "puntaje" debe ser un número entre 1 y 10.');
  }
  if (typeof c.aspectos_positivos !== 'string' || !c.aspectos_positivos.trim()) {
    throw new Error('El campo "aspectos_positivos" no es válido.');
  }
  if (typeof c.aspectos_mejorar !== 'string' || !c.aspectos_mejorar.trim()) {
    throw new Error('El campo "aspectos_mejorar" no es válido.');
  }
};

// ─── Questions ───────────────────────────────────────────────────────────────

const shuffleQuestionOptions = (
  question: RawQuestionResponse,
  correctOptionId: OptionId,
  explicacion: string,
): QuestionResponse => {
  const shuffledEntries = shuffleArray(
    OPTION_IDS.map((optionId) => ({
      originalOptionId: optionId,
      text: question.opciones[optionId],
    })),
  );

  const shuffledOptions = {} as Record<OptionId, string>;
  let shuffledCorrectOptionId: OptionId = 'A';

  OPTION_IDS.forEach((newOptionId, index) => {
    const entry = shuffledEntries[index];
    shuffledOptions[newOptionId] = entry.text;

    if (entry.originalOptionId === correctOptionId) {
      shuffledCorrectOptionId = newOptionId;
    }
  });

  return {
    enunciado: question.enunciado,
    opciones: shuffledOptions,
    respuesta_correcta: shuffledCorrectOptionId,
    explicacion,
  };
};

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
    if (
      normalizeComparableText(dto.competencia) ===
      normalizeComparableText('Razonamiento cuantitativo')
    ) {
      return buildQuantitativeQuestion();
    }

    const prompt = `Genera una pregunta de Saber Pro del modulo '${dto.competencia}'.`;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      try {
        const generatedQuestion = await this.generateRawQuestion(prompt);
        const verifiedAnswer = await this.verifyCorrectOption(generatedQuestion);
        const correctOptionId = resolveCorrectOptionId(generatedQuestion.opciones, verifiedAnswer);
        const explanation = await this.buildExplanation(
          generatedQuestion,
          correctOptionId,
          verifiedAnswer.resultado_final,
        );

        return shuffleQuestionOptions(
          generatedQuestion,
          correctOptionId,
          explanation,
        );
      } catch (error) {
        if (attempt === MAX_GENERATION_ATTEMPTS) {
          console.error('Question generation failed:', error);
          throw new InternalServerErrorException(
            'Error al generar la pregunta con el modelo de IA.',
          );
        }
      }
    }

    throw new InternalServerErrorException(
      'Error al generar la pregunta con el modelo de IA.',
    );
  }

  private async generateRawQuestion(prompt: string): Promise<RawQuestionResponse> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: 'system', content: GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content ?? '{}';
    const parsedContent = JSON.parse(content) as unknown;

    assertValidRawQuestionResponse(parsedContent);

    return parsedContent;
  }

  private async verifyCorrectOption(
    question: RawQuestionResponse,
  ): Promise<VerifiedAnswerResponse> {
    const verificationPrompt = JSON.stringify(question);

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: 'system', content: ANSWER_VERIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: verificationPrompt },
      ],
      max_tokens: 120,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content ?? '{}';
    const parsedContent = JSON.parse(content) as unknown;

    assertValidVerifiedAnswerResponse(parsedContent);

    if (parsedContent.respuesta_correcta_texto === 'NINGUNA') {
      throw new Error('La pregunta generada no tiene una opcion correcta unica.');
    }

    return parsedContent;
  }

  private async buildExplanation(
    question: RawQuestionResponse,
    correctOptionId: OptionId,
    result: string,
  ): Promise<string> {
    const explanationPrompt = JSON.stringify({
      enunciado: question.enunciado,
      opciones: question.opciones,
      respuesta_correcta: {
        letra: correctOptionId,
        texto: question.opciones[correctOptionId],
      },
      resultado_final: result,
    });

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: 'system', content: EXPLANATION_SYSTEM_PROMPT },
        { role: 'user', content: explanationPrompt },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content ?? '{}';
    const parsedContent = JSON.parse(content) as unknown;

    assertValidExplanationResponse(parsedContent);

    return parsedContent.explicacion;
  }
}

@Injectable()
export class SituacionesService {
  private readonly client: OpenAI;
  private readonly modelId: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
    const situacionesModelId = this.configService.get<string>('MODELO_ID_COMP_ESCRITA');
    if (!situacionesModelId) {
      throw new Error('La variable de entorno MODELO_ID_COMP_ESCRITA no está definida.');
    }
    this.modelId = situacionesModelId;
  }

  async generateSituacion(dto: GenerateSituacionDto): Promise<SituacionResponse> {
    const tema = dto.tema ?? pickRandom(TEMAS_SABER_PRO);
    const prompt = `Genera una situación de escritura para el tema: "${tema}".`;

    for (let attempt = 1; attempt <= MAX_SITUACION_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.modelId,
          messages: [
            { role: 'system', content: SITUACION_GENERATION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 600,
          temperature: 0.7,
          response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content ?? '{}';
        const parsed = JSON.parse(content) as unknown;
        assertValidSituacionResponse(parsed);
        return parsed;
      } catch (error) {
        if (attempt === MAX_SITUACION_ATTEMPTS) {
          console.error('Situacion generation failed:', error);
          throw new InternalServerErrorException(
            'Error al generar la situación con el modelo de IA.',
          );
        }
      }
    }

    throw new InternalServerErrorException(
      'Error al generar la situación con el modelo de IA.',
    );
  }

  async corregirTexto(dto: CorregirTextoDto): Promise<CorreccionResponse> {
    const correctionPrompt = JSON.stringify({
      situacion: dto.situacion,
      texto_estudiante: dto.texto,
    });

    for (let attempt = 1; attempt <= MAX_SITUACION_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.modelId,
          messages: [
            { role: 'system', content: TEXTO_CORRECTION_SYSTEM_PROMPT },
            { role: 'user', content: correctionPrompt },
          ],
          max_tokens: 800,
          temperature: 0,
          response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content ?? '{}';
        const parsed = JSON.parse(content) as unknown;
        assertValidCorreccionResponse(parsed);
        return parsed;
      } catch (error) {
        if (attempt === MAX_SITUACION_ATTEMPTS) {
          console.error('Text correction failed:', error);
          throw new InternalServerErrorException(
            'Error al corregir el texto con el modelo de IA.',
          );
        }
      }
    }

    throw new InternalServerErrorException(
      'Error al corregir el texto con el modelo de IA.',
    );
  }
}
