import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UserEntity } from './entities/user.entity';
import { PrismaService } from '../prisma.service';

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) { }

    async crearUsuario(dto: CreateUserDto) {
        return this.prisma.user.create({
            data: {
                id: dto.id,
                email: dto.email,
                nombre: dto.nombre,
                apellido: dto.apellido,
                carrera: dto.carrera,
                semestre: dto.semestre,
            },
        });
    }

    async createOrUpdate(dto: CreateUserDto) {
        return this.prisma.user.upsert({
            where: { id: dto.id },
            update: {
                email: dto.email,
                nombre: dto.nombre,
                apellido: dto.apellido,
                carrera: dto.carrera,
                semestre: dto.semestre,
            },
            create: {
                id: dto.id,
                email: dto.email,
                nombre: dto.nombre,
                apellido: dto.apellido,
                carrera: dto.carrera,
                semestre: dto.semestre,
            },
        });
    }

    async encontrarPorId(id: string): Promise<UserEntity> {
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user) {
            throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
        }
        return user as UserEntity;
    }

    async encontrarUsuarioAutenticado(userId: string): Promise<UserEntity> {
        return this.encontrarPorId(userId);
    }

    async getAllbyCareer(carrera: string) {
        return this.prisma.user.findMany({ where: { carrera } });
    }
}
