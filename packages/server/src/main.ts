import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    // 签名要对原始请求体做哈希，JSON 解析后再序列化无法还原字节序
    rawBody: true,
    // 限制 JSON / urlencoded 请求体大小。所有业务接口的 body 都远小于此；
    // 安装包上传走 multipart，由 multer 的 fileSize 单独管，不受这里影响。
    // 不设限的话一个超大 body 就能顶高内存占用，是廉价的 DoS 面。
    bodyParser: true,
    rawBodyLimit: '256kb',
    jsonBodyLimit: '256kb',
    urlencodedBodyLimit: '256kb',
  } as any);

  configureApp(app);

  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`授权中心已启动: http://127.0.0.1:${port}`);
}

void bootstrap();
