import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { validationExceptionFactory } from './common/errors/validation.factory';

/**
 * 应用级配置。生产入口和端到端测试共用这一份，
 * 避免测试环境和线上环境的管道、CORS、代理设置出现偏差。
 */
export function configureApp(app: NestExpressApplication) {
  // 反向代理后要拿到真实客户端 IP，限流和审计都依赖它
  app.set('trust proxy', 1);

  // 关掉 Express 的 X-Powered-By：暴露技术栈只会给攻击者省事，没有任何好处
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // 请求体大小限制在 main.ts 创建应用时通过 bodyParser 选项统一配置，
  // 不在这里 app.use(express.json())，避免和 Nest 自带的解析器叠成两层、
  // 破坏签名依赖的 rawBody。

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      // 每个字段只保留一条最贴切的提示，规则见 validationExceptionFactory
      exceptionFactory: validationExceptionFactory,
      // 不开 enableImplicitConversion：它会按 TS 反射类型强行转换，
      // 把 "false" 当成 Boolean("false") = true，并覆盖自定义的 @Transform。
      // 所有需要转换的字段都显式标注了 @Type 或 @ToBoolean。
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  return app;
}
