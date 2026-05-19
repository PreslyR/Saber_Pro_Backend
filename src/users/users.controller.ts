import { Controller, Post, Body, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserEntity } from './entities/user.entity';

@ApiTags('usuarios')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) { }

    @Post('sync')
    @ApiOperation({ summary: 'Crear o actualizar usuario' })
    create(@Body() createUserDto: CreateUserDto) {
        return this.usersService.createOrUpdate(createUserDto);
    }

    @Get('me')
    @ApiOperation({ summary: 'Obtener perfil del usuario autenticado' })
    findMe(@Req() req: { user: { userId: string } }): Promise<UserEntity> {
        return this.usersService.encontrarUsuarioAutenticado(req.user.userId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Obtener perfil por ID' })
    findOne(@Param('id') id: string): Promise<UserEntity> {
        return this.usersService.encontrarPorId(id);
    }

    @Get('career/:carrera')
    @ApiOperation({ summary: 'Obtener usuarios por carrera' })
    findByCareer(@Param('carrera') carrera: string): Promise<UserEntity[]> {
        return this.usersService.getAllbyCareer(carrera);
    }
}
