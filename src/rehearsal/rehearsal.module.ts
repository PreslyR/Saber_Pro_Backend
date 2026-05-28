import { Module } from '@nestjs/common';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalService } from './rehearsal.service';

@Module({
  controllers: [RehearsalController],
  providers: [RehearsalService],
})
export class RehearsalModule {}
