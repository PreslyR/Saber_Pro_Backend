# EduSaber — Backend

API para la plataforma de preparación del examen SABER PRO, impulsada por modelos de lenguaje fine-tuned.

## Stack

- **Framework**: NestJS 11
- **ORM**: Prisma 7 + PostgreSQL (Supabase)
- **Auth**: Supabase Auth + JWT (passport-jwt)
- **IA**: OpenAI (2 modelos fine-tuned: preguntas + comunicación escrita)
- **Validación**: class-validator + class-transformer
- **Docs**: Swagger en `/docs`

## Requisitos

- Node.js 18+
- PostgreSQL (o Supabase)
- Cuenta de OpenAI con API key
- Proyecto de Supabase configurado

## Instalación

```bash
npm install
```

## Configuración

Copiar `.env.example` a `.env` y completar las variables:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Connection string de PostgreSQL |
| `PORT` | Puerto del servidor (default: 3000) |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_ANON_KEY` | Clave anónima de Supabase |
| `SUPABASE_JWT_SECRET` | Secreto JWT para validar tokens |
| `OPENAI_API_KEY` | API key de OpenAI |
| `OPENAI_MODEL_ID` | Modelo fine-tuned para generación de preguntas |
| `MODELO_ID_COMP_ESCRITA` | Modelo fine-tuned para situaciones de escritura |

## Ejecución

```bash
# Desarrollo con hot-reload
npm run start:dev

# Producción
npm run start:prod
```

## Base de datos

```bash
# Sincronizar schema (desarrollo)
npx prisma db push

# Generar cliente Prisma
npx prisma generate
```

## Modelo de datos

```
User
 ├── id           String   @id (UUID de Supabase Auth)
 ├── email        String   @unique
 ├── nombre       String
 ├── apellido    String
 ├── carrera      String
 ├── semestre     Int
 ├── QuizAttempt[]
 └── RehearsalSession[]

QuizAttempt
 ├── id             Int          @id @default(autoincrement())
 ├── userId         String
 ├── subjectId      String
 ├── totalQuestions Int
 ├── correctAnswers Int
 ├── finishedAt    DateTime
 ├── user           User         @relation
 └── answers        QuizAnswer[]

QuizAnswer
 ├── id               Int          @id @default(autoincrement())
 ├── attemptId        Int
 ├── questionOrder    Int
 ├── statement        String
 ├── options          Json
 ├── selectedOptionId String
 ├── correctOptionId  String
 ├── isCorrect        Boolean
 ├── explanation      String
 ├── attempt          QuizAttempt  @relation
 └── @@unique(attemptId, questionOrder)

RehearsalSession
 ├── id             Int               @id @default(autoincrement())
 ├── userId         String
 ├── subjectId      String
 ├── totalQuestions Int
 ├── correctAnswers Int
 ├── finishedAt     DateTime
 ├── user           User              @relation
 └── answers        RehearsalAnswer[]

RehearsalAnswer
 ├── id               Int              @id @default(autoincrement())
 ├── sessionId        Int
 ├── sourceAnswerId   Int              (ref lógica a QuizAnswer, sin FK)
 ├── statement        String
 ├── options          Json
 ├── selectedOptionId String
 ├── correctOptionId  String
 ├── isCorrect        Boolean
 ├── explanation      String
 ├── session          RehearsalSession  @relation
 └── @@unique(sessionId, sourceAnswerId)
```

## Endpoints

Todos los endpoints autenticados requieren header `Authorization: Bearer <token>`.

### Auth (`/auth`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/auth/signup` | No | Registro de usuario |
| POST | `/auth/login` | No | Login, retorna JWT |
| GET | `/auth/profile` | JWT | Verificar token activo |

### Usuarios (`/users`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/users/me` | JWT | Perfil del usuario autenticado |
| GET | `/users/:id` | JWT | Perfil por ID |
| GET | `/users/career/:carrera` | JWT | Usuarios por carrera |
| POST | `/users/sync` | JWT | Crear o actualizar usuario |

### Preguntas (`/questions`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/questions/generate` | JWT | Generar pregunta con IA. Body: `{ competencia, dificultad? }` |

**Dificultad** (campo opcional):
- `basic` (default) — Preguntas de un paso lógico
- `intermediate` — Razonamiento de dos pasos
- `advanced` — Análisis compuesto

Las 5 competencias: `razonamiento-cuantitativo`, `competencias-ciudadanas`, `ingles`. Para `razonamiento-cuantitativo` se usan templates deterministas; las demás generan con IA.

### Situaciones (`/situaciones`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/situaciones/generate` | JWT | Generar situación de escritura |
| POST | `/situaciones/corregir` | JWT | Corregir texto redactado |

### Progreso (`/progress`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/progress/me` | JWT | Dashboard de progreso del usuario |
| POST | `/progress/attempts` | JWT | Guardar intento de quiz |

**Dashboard** retorna:
- `userProgress`: progreso por materia (preguntas completadas, correctas)
- `stats`: nivel, XP, racha, meta diaria, `overallCompletionPct`

### Repaso (`/rehearsal`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/rehearsal/wrong-answers/:subjectId` | JWT | Preguntas incorrectas no repasadas |
| POST | `/rehearsal/sessions` | JWT | Guardar sesión de repaso |

Las sesiones de repaso **no** afectan XP, racha ni progreso.

### Chat (`/chat`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/chat` | JWT | Enviar mensaje al tutor IA |

### Leaderboard (`/leaderboard`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/leaderboard` | JWT | Top 10 usuarios por XP |

## Sistema de niveles

La plataforma calcula XP y niveles automáticamente:

- **XP**: 10 por respuesta correcta
- **Nivel**: `floor(XP / 100) + 1`
- **Racha**: días consecutivos con al menos un intento
- **Meta diaria**: 10 sesiones quiz

## Dificultad de preguntas

El sistema de dificultad se alinea con los niveles del mapa de aprendizaje:

| Completitud | Tier | Niveles | Tipo de preguntas |
|---|---|---|---|
| 0–39% | `basic` | Explorador, Aprendiz | Un paso lógico (templates actuales) |
| 40–79% | `intermediate` | Practicante, Avanzado | Dos pasos (descuento+IVA, proporción+conversión, promedio invertido) |
| 80–100% | `advanced` | Experto, Maestro | Razonamiento compuesto (punto de equilibrio, razón combinada, regla de tres) |

**Templates**: Razonamiento cuantitativo usa routing acumulativo (basic=10, intermediate=13, advanced=16 templates). Las demás materias inyectan instrucciones de dificultad en el prompt del modelo.

## Estructura del proyecto

```
src/
├── auth/           # Registro, login, JWT
├── chat/           # Tutor IA
├── leaderboard/     # Ranking por XP
├── progress/       # Progreso, XP, niveles, dashboard
├── questions/      # Generación de preguntas (IA + templates)
├── rehearsal/       # Repaso de preguntas incorrectas
├── users/          # Perfil de usuario
├── prisma.service.ts  # Singleton de PrismaClient
└── main.ts         # Bootstrap + Swagger
```

## Swagger

La documentación interactiva está disponible en `http://localhost:3000/docs` cuando el servidor está corriendo.