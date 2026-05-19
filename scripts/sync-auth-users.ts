import 'reflect-metadata';
import 'dotenv/config';
import { PrismaService } from '../src/prisma.service';

interface OrphanAuthUserRow {
  id: string;
  email: string;
  created_at: Date;
}

interface ManualProfileOverride {
  nombre: string;
  apellido: string;
  carrera: string;
  semestre: number;
}

const MANUAL_PROFILE_OVERRIDES: Record<string, ManualProfileOverride> = {
  'ba3f557b-dd72-4571-ba91-fba1e3c7a45b': {
    nombre: 'Andres',
    apellido: 'Perez',
    carrera: 'Ingenieria de sistemas',
    semestre: 9,
  },
  '5df3c62e-835b-44d1-9b9a-7cebd158daba': {
    nombre: 'Presly',
    apellido: 'Romero',
    carrera: 'Ingenieria de sistemas',
    semestre: 9,
  },
};

const hasValidOverride = (
  override: ManualProfileOverride | undefined,
): override is ManualProfileOverride =>
  Boolean(
    override &&
      override.nombre.trim() &&
      override.apellido.trim() &&
      override.carrera.trim() &&
      Number.isInteger(override.semestre) &&
      override.semestre > 0,
  );

async function main() {
  const prisma = new PrismaService();

  try {
    const orphanAuthUsers = (await prisma.$queryRawUnsafe(`
      select
        au.id::text as id,
        au.email,
        au.created_at
      from auth.users au
      left join public."User" u on u.id = au.id::text
      where u.id is null
      order by au.created_at asc
    `)) as OrphanAuthUserRow[];

    if (orphanAuthUsers.length === 0) {
      console.log('No hay usuarios de auth pendientes por sincronizar.');
      return;
    }

    const unresolvedUsers = orphanAuthUsers.filter(
      (user) => !hasValidOverride(MANUAL_PROFILE_OVERRIDES[user.id]),
    );

    if (unresolvedUsers.length > 0) {
      console.log(
        'Completa MANUAL_PROFILE_OVERRIDES en scripts/sync-auth-users.ts antes de ejecutar la sincronizacion.',
      );
      console.table(
        unresolvedUsers.map((user) => ({
          id: user.id,
          email: user.email,
          createdAt: user.created_at.toISOString(),
        })),
      );
      process.exitCode = 1;
      return;
    }

    for (const user of orphanAuthUsers) {
      const override = MANUAL_PROFILE_OVERRIDES[user.id];

      await prisma.user.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          nombre: override.nombre.trim(),
          apellido: override.apellido.trim(),
          carrera: override.carrera.trim(),
          semestre: override.semestre,
        },
        create: {
          id: user.id,
          email: user.email,
          nombre: override.nombre.trim(),
          apellido: override.apellido.trim(),
          carrera: override.carrera.trim(),
          semestre: override.semestre,
        },
      });
    }

    console.log(`Sincronizados ${orphanAuthUsers.length} usuarios desde auth.users hacia User.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
