import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { JwtStrategy } from './auth/jwt.strategy';
import { PassportModule } from '@nestjs/passport';
import { QuestionsModule } from './questions/questions.module';
import { ProgressModule } from './progress/progress.module';
import { ChatModule } from './chat/chat.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
@Module({
  imports: [ConfigModule.forRoot({
      isGlobal: true,
    }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    UsersModule,
    AuthModule,
    QuestionsModule,
    ProgressModule,
    ChatModule,
    LeaderboardModule],
  controllers: [],
  providers: [JwtStrategy],
})
export class AppModule {}
