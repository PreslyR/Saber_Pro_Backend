import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuthService {
    private supabase: SupabaseClient;

    constructor(private prisma: PrismaService) {

        this.supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_ANON_KEY!,
        );
    }

    async signUp(dto: SignUpDto) {
        const { data: authData, error: authError } = await this.supabase.auth.signUp({
            email: dto.email,
            password: dto.password,
        });

        if (authError) throw new BadRequestException(authError.message);

        // Si se creo en Auth, lo creamos en nuestra tabla de usuarios
        if (authData.user) {
            try {
                await this.prisma.user.create({
                    data: {
                        id: authData.user.id, // El uuid generado por Supabase
                        email: dto.email,
                        nombre: dto.nombre,
                        apellido: dto.apellido,
                        carrera: dto.carrera,
                        semestre: dto.semestre,
                    },
                });
            } catch (dbError) {
                console.error('DB Error:', dbError);
                throw new InternalServerErrorException((dbError as Error).message ?? 'Error al crear el perfil de usuario');
            }
        }
        return { userId: authData.user?.id };
    }
    async login(dto: LoginDto) {
        const { data, error } = await this.supabase.auth.signInWithPassword({
            email: dto.email,
            password: dto.password,
        });

        if (error) {
            throw new BadRequestException('Credenciales invalidas: ' + error.message);
        }

        // devolvemos el token y la info básica del usuario
        return {
            access_token: data.session?.access_token,
            refresh_token: data.session?.refresh_token,
            user: {
                id: data.user?.id,
                email: data.user?.email,
            },
        };
    }
}