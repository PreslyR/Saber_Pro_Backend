import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Dificultad, GenerateQuestionDto } from './dto/generate-question.dto';
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

// ─── Intermediate templates ──────────────────────────────────────────────────

const buildDiscountAndTaxQuestion = (): QuantitativeTemplateQuestion => {
  const originalPrice = pickRandom([60000, 100000, 140000, 180000, 220000]);
  const discountPercent = pickRandom([10, 15, 20, 25]);
  const taxPercent = pickRandom([8, 16, 19]);
  const discountedPrice = originalPrice * (1 - discountPercent / 100);
  const finalPrice = Math.round(discountedPrice * (1 + taxPercent / 100));
  const correctOptionText = formatCurrency(finalPrice);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatCurrency(originalPrice),
    formatCurrency(Math.round(discountedPrice)),
    formatCurrency(Math.round(originalPrice * (1 + taxPercent / 100))),
    formatCurrency(Math.round(finalPrice + originalPrice * 0.05)),
    formatCurrency(Math.max(10000, finalPrice - Math.round(originalPrice * 0.05))),
  ]);

  return {
    enunciado: `Un articulo tiene un precio original de ${formatCurrency(originalPrice)}. La tienda aplica un descuento del ${discountPercent}% y luego cobra un impuesto del ${taxPercent}% sobre el precio descontado. ?Cual es el precio final del articulo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Primero calculamos el descuento: ${discountPercent}% de ${formatCurrency(originalPrice)} = ${formatCurrency(Math.round(originalPrice * discountPercent / 100))}. Precio descontado: ${formatCurrency(originalPrice)} - ${formatCurrency(Math.round(originalPrice * discountPercent / 100))} = ${formatCurrency(Math.round(discountedPrice))}. Luego aplicamos el impuesto del ${taxPercent}%: ${formatCurrency(Math.round(discountedPrice))} × (1 + ${taxPercent}/100) = ${formatCurrency(finalPrice)}.`,
  };
};

const buildRecipeScaleQuestion = (): QuantitativeTemplateQuestion => {
  const scenarios = [
    { kg: 3, people: 6, targetPeople: 10 },
    { kg: 2, people: 4, targetPeople: 9 },
    { kg: 4, people: 8, targetPeople: 14 },
    { kg: 5, people: 10, targetPeople: 16 },
    { kg: 2, people: 5, targetPeople: 12 },
  ];
  const scenario = pickRandom(scenarios);
  const kgPerPerson = scenario.kg / scenario.people;
  const kgForTarget = scenario.targetPeople * kgPerPerson;
  const gramsForTarget = Math.round(kgForTarget * 1000);
  const correctOptionText = `${formatThousands(gramsForTarget)} g`;
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    `${formatDecimal(kgForTarget)} kg`,
    `${formatThousands(Math.round(kgForTarget * 100))} g`,
    `${formatThousands(Math.round(kgForTarget * 2000))} g`,
    `${formatThousands(gramsForTarget + 500)} g`,
    `${formatThousands(Math.max(100, gramsForTarget - 500))} g`,
  ]);

  return {
    enunciado: `Una receta requiere ${formatDecimal(scenario.kg)} kg de harina para ${scenario.people} personas. ?Cuantos gramos de harina se necesitan para ${scenario.targetPeople} personas?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Primero calculamos la harina por persona: ${formatDecimal(scenario.kg)} kg / ${scenario.people} = ${formatDecimal(kgPerPerson)} kg por persona. Para ${scenario.targetPeople} personas: ${formatDecimal(kgPerPerson)} × ${scenario.targetPeople} = ${formatDecimal(kgForTarget)} kg. Convertimos a gramos: ${formatDecimal(kgForTarget)} × 1000 = ${formatThousands(gramsForTarget)} g.`,
  };
};

const buildMissingValueAverageQuestion = (): QuantitativeTemplateQuestion => {
  const average = pickRandom([12, 14, 15, 16, 18]);
  const offsets = [
    pickRandom([-2, -1, 1, 2, 3]),
    pickRandom([-3, -2, -1, 1, 2]),
    pickRandom([-2, -1, 1, 2, 3]),
  ];
  const knownValues = offsets.map((offset) => average + offset);
  const missingValue = average * 4 - knownValues.reduce((sum, v) => sum + v, 0);
  const correctOptionText = missingValue.toString();
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    average.toString(),
    (average + 1).toString(),
    Math.max(1, average - 1).toString(),
    (average + 2).toString(),
    Math.max(1, average - 2).toString(),
  ]);

  return {
    enunciado: `El promedio de cuatro calificaciones es ${average}. Tres de ellas son: ${knownValues.join(', ')}. ?Cual es la cuarta calificacion?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `La suma de las cuatro calificaciones debe ser ${average} × 4 = ${average * 4}. Las tres conocidas suman ${knownValues.join(' + ')} = ${knownValues.reduce((s, v) => s + v, 0)}. Entonces la cuarta calificacion es ${average * 4} - ${knownValues.reduce((s, v) => s + v, 0)} = ${missingValue}.`,
  };
};

// ─── Advanced templates ──────────────────────────────────────────────────────

const buildBreakEvenQuestion = (): QuantitativeTemplateQuestion => {
  const scenarios = [
    { fixedCost: 600000, margin: 15000, units: 40, variableCost: 25000, sellingPrice: 40000 },
    { fixedCost: 800000, margin: 20000, units: 40, variableCost: 30000, sellingPrice: 50000 },
    { fixedCost: 1200000, margin: 20000, units: 60, variableCost: 35000, sellingPrice: 55000 },
    { fixedCost: 1500000, margin: 25000, units: 60, variableCost: 25000, sellingPrice: 50000 },
    { fixedCost: 2000000, margin: 25000, units: 80, variableCost: 20000, sellingPrice: 45000 },
  ];
  const s = pickRandom(scenarios);
  const correctOptionText = formatThousands(s.units);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatThousands(Math.round(s.units * 1.2)),
    formatThousands(Math.round(s.units * 0.8)),
    formatThousands(Math.round(s.fixedCost / s.sellingPrice)),
    formatThousands(Math.round(s.fixedCost / s.variableCost)),
    formatThousands(s.units + 10),
  ]);

  return {
    enunciado: `Una empresa tiene costos fijos de ${formatCurrency(s.fixedCost)} y un costo variable de ${formatCurrency(s.variableCost)} por unidad. Si el precio de venta es ${formatCurrency(s.sellingPrice)} por unidad, ?cuantas unidades debe vender para alcanzar el punto de equilibrio (sin perdidas ni ganancias)?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `En el punto de equilibrio: ingresos = costos totales. Si se venden x unidades: ${formatThousands(s.sellingPrice)}x = ${formatThousands(s.fixedCost)} + ${formatThousands(s.variableCost)}x. Despejando: (${formatThousands(s.sellingPrice)} - ${formatThousands(s.variableCost)})x = ${formatThousands(s.fixedCost)}. Entonces x = ${formatThousands(s.fixedCost)} / ${formatThousands(s.margin)} = ${formatThousands(s.units)} unidades.`,
  };
};

const buildCombinedWorkRateQuestion = (): QuantitativeTemplateQuestion => {
  const scenarios = [
    { rateA: 8, rateB: 4, combinedTime: 5, timeA: 3, totalUnits: 60, timeB: 9 },
    { rateA: 12, rateB: 6, combinedTime: 4, timeA: 2, totalUnits: 72, timeB: 8 },
    { rateA: 10, rateB: 5, combinedTime: 4, timeA: 3, totalUnits: 60, timeB: 6 },
    { rateA: 9, rateB: 6, combinedTime: 4, timeA: 2, totalUnits: 60, timeB: 7 },
    { rateA: 15, rateB: 10, combinedTime: 3, timeA: 2, totalUnits: 75, timeB: 4.5 },
  ];
  const s = pickRandom(scenarios);
  const correctOptionText = formatHours(s.timeB);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatHours(s.timeB + 1),
    formatHours(Math.max(1, s.timeB - 1)),
    formatHours(s.combinedTime),
    formatHours(s.timeA + 1),
    formatHours(s.combinedTime + s.timeA),
  ]);

  return {
    enunciado: `La maquina A produce ${s.rateA} piezas por hora y la maquina B produce ${s.rateB} piezas por hora. Juntas producen ${s.totalUnits} piezas en ${s.combinedTime} horas. Si la maquina A trabaja sola durante ${s.timeA} horas produciendo ${s.rateA * s.timeA} piezas, ?cuantas horas necesita la maquina B para terminar las piezas restantes?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Juntas producen ${s.rateA} + ${s.rateB} = ${s.rateA + s.rateB} piezas por hora. En ${s.combinedTime} horas producen ${s.totalUnits} piezas. Si A trabaja ${s.timeA} horas: ${s.rateA} × ${s.timeA} = ${s.rateA * s.timeA} piezas. Restan ${s.totalUnits} - ${s.rateA * s.timeA} = ${s.totalUnits - s.rateA * s.timeA} piezas. B las produce en ${s.totalUnits - s.rateA * s.timeA} / ${s.rateB} = ${formatDecimal(s.timeB)} horas.`,
  };
};

const buildTripleRuleQuestion = (): QuantitativeTemplateQuestion => {
  const scenarios = [
    { machines: 2, hours: 5, rate: 10, totalUnits: 100, targetMachines: 4, targetUnits: 200, targetHours: 5 },
    { machines: 3, hours: 4, rate: 12, totalUnits: 144, targetMachines: 5, targetUnits: 240, targetHours: 4 },
    { machines: 2, hours: 6, rate: 15, totalUnits: 180, targetMachines: 3, targetUnits: 270, targetHours: 6 },
    { machines: 4, hours: 3, rate: 8, totalUnits: 96, targetMachines: 6, targetUnits: 192, targetHours: 4 },
    { machines: 3, hours: 5, rate: 10, totalUnits: 150, targetMachines: 5, targetUnits: 300, targetHours: 6 },
  ];
  const s = pickRandom(scenarios);
  const correctOptionText = formatHours(s.targetHours);
  const distractorOptionTexts = buildDistinctDistractors(correctOptionText, [
    formatHours(s.hours),
    formatHours(s.targetHours + 1),
    formatHours(Math.max(1, s.targetHours - 1)),
    formatHours(Math.round(s.targetUnits / s.targetMachines)),
    formatHours(s.targetHours + 2),
  ]);

  return {
    enunciado: `Si ${s.machines} maquinas producen ${s.totalUnits} piezas en ${s.hours} horas, ?cuantas horas necesitaran ${s.targetMachines} maquinas para producir ${s.targetUnits} piezas, trabajando al mismo ritmo?`,
    correctOptionText,
    distractorOptionTexts,
    explicacion: `Cada maquina produce ${s.rate} piezas por hora (${s.totalUnits} / (${s.machines} × ${s.hours}) = ${s.rate}). Con ${s.targetMachines} maquinas, la produccion por hora es ${s.targetMachines} × ${s.rate} = ${s.targetMachines * s.rate}. Para producir ${s.targetUnits} piezas: ${s.targetUnits} / ${s.targetMachines * s.rate} = ${formatDecimal(s.targetHours)} horas.`,
  };
};

const buildQuantitativeQuestion = (
  dificultad: Dificultad = Dificultad.BASIC,
): QuestionResponse => {
  const pool: (() => QuantitativeTemplateQuestion)[] = [
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
  ];

  if (dificultad === Dificultad.INTERMEDIATE || dificultad === Dificultad.ADVANCED) {
    pool.push(
      buildDiscountAndTaxQuestion,
      buildRecipeScaleQuestion,
      buildMissingValueAverageQuestion,
    );
  }

  if (dificultad === Dificultad.ADVANCED) {
    pool.push(
      buildBreakEvenQuestion,
      buildCombinedWorkRateQuestion,
      buildTripleRuleQuestion,
    );
  }

  return buildQuestionResponseFromTemplate(pickRandom(pool)());
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
  evaluacion: string;
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

const TEXTO_CORRECTION_SYSTEM_PROMPT =
  'Eres un evaluador experto del módulo de Comunicación Escrita de Saber Pro del ICFES Colombia. ' +
  'Tu tarea es evaluar textos escritos por estudiantes universitarios con base en tres criterios oficiales y estables:\n\n' +
  '1. Comunicación: verifica si el texto responde a la tarea, cumple el propósito solicitado y presenta una postura, idea central o intención comunicativa clara.\n' +
  '2. Coherencia y cohesión: evalúa si las ideas se organizan de manera lógica, progresiva y conectada; revisa el uso de párrafos, conectores y unidad temática.\n' +
  '3. Uso del lenguaje: evalúa ortografía, gramática, puntuación, concordancia, elección léxica y registro adecuado al contexto.\n\n' +
  'INSTRUCCIONES OBLIGATORIAS PARA CADA EVALUACIÓN:\n' +
  '- Asigna un nivel a cada criterio: Alto, Medio o Bajo.\n' +
  '- Justifica cada nivel con evidencia textual concreta.\n' +
  '- Cita siempre el fragmento exacto problemático entre comillas simples.\n' +
  '- Incluye la corrección exacta del fragmento y explica brevemente el motivo del error.\n' +
  '- Si el texto no responde completamente a la tarea, indícalo de forma explícita.\n' +
  '- Entrega una versión mejorada completa del texto, conservando exactamente las mismas ideas, argumentos y postura del estudiante.\n' +
  '- No agregues información nueva, no cambies el sentido, no corrijas hechos externos dentro de la versión mejorada; solo mejora redacción, orden, cohesión y corrección lingüística.\n' +
  '- Mantén un tono académico, claro, preciso y consistente.\n\n' +
  'FORMATO DE RESPUESTA REQUERIDO:\n' +
  '- Comunicación: [Nivel] — [justificación]\n' +
  '- Coherencia y cohesión: [Nivel] — [justificación]\n' +
  '- Uso del lenguaje: [Nivel] — [justificación]\n' +
  '- Fortalezas:\n' +
  '  - [fortaleza 1]\n' +
  '  - [fortaleza 2]\n' +
  '- Correcciones:\n' +
  "  - Fragmento: '[texto original]' → Corrección: '[texto corregido]' Motivo: [explicación]\n" +
  '- Versión mejorada:\n' +
  '  [texto completo corregido]\n\n' +
  'REGLAS DE CALIDAD:\n' +
  '- No uses explicaciones genéricas.\n' +
  "- No evalúes con frases vagas como 'está bien redactado' sin evidencia.\n" +
  '- La justificación debe corresponder exactamente al nivel asignado.\n' +
  '- Sé consistente entre diagnóstico, corrección y versión mejorada.';

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

const assertValidCorreccionResponse = (value: CorreccionResponse) => {
  if (typeof value.evaluacion !== 'string' || !value.evaluacion.trim()) {
    throw new Error('La evaluación devuelta por el modelo está vacía.');
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
    const dificultad = dto.dificultad ?? Dificultad.BASIC;

    if (
      normalizeComparableText(dto.competencia) ===
      normalizeComparableText('Razonamiento cuantitativo')
    ) {
      return buildQuantitativeQuestion(dificultad);
    }

    let systemPrompt = GENERATION_SYSTEM_PROMPT;

    if (dificultad === Dificultad.INTERMEDIATE) {
      systemPrompt += ' La pregunta debe requerir razonamiento de dos pasos o conectores logicos.';
    } else if (dificultad === Dificultad.ADVANCED) {
      systemPrompt += ' La pregunta debe requerir razonamiento compuesto, analisis critico o inferencia de segundo orden.';
    }

    const prompt = `Genera una pregunta de Saber Pro del modulo '${dto.competencia}'.`;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      try {
        const generatedQuestion = await this.generateRawQuestion(prompt, systemPrompt);
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

  private async generateRawQuestion(
    prompt: string,
    systemPrompt: string = GENERATION_SYSTEM_PROMPT,
  ): Promise<RawQuestionResponse> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: 'system', content: systemPrompt },
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
    const correctionPrompt =
      `Situación:\n${dto.situacion}\n\nTexto del estudiante:\n${dto.texto}`;

    for (let attempt = 1; attempt <= MAX_SITUACION_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.modelId,
          messages: [
            { role: 'system', content: TEXTO_CORRECTION_SYSTEM_PROMPT },
            { role: 'user', content: correctionPrompt },
          ],
          max_tokens: 1200,
          temperature: 0,
        });

        const evaluacion = response.choices[0].message.content ?? '';
        const result: CorreccionResponse = { evaluacion };
        assertValidCorreccionResponse(result);
        return result;
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
