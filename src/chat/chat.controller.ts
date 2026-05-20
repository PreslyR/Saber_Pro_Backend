import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @ApiOperation({ summary: 'Enviar mensaje al asistente de estudio Saber Pro' })
  sendMessage(
    @Req() req: { user: { userId: string } },
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(req.user.userId, dto);
  }
}
