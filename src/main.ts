import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = new DocumentBuilder()
    .addBearerAuth()
    .setTitle('Saber Pro API')
    .setDescription('Documentacion de la API para la preparación de pruebas SABER PRO')
    .setVersion('1.0')
    .build();
    
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',').map(o => o.trim()) ?? true,
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,    
    forbidNonWhitelisted: true,
    transform: true,  
  }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
