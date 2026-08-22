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

  const logger = new Logger('Bootstrap');
  logger.log(`授权中心已启动: http://127.0.0.1:${port}`);

  // 没配这项时，下发给客户端的安装包地址会退化成相对路径，客户端根本下载不了。
  // 这种坏法很安静——后台看着一切正常，只有真机更新时才炸，所以启动就喊出来。
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) {
    logger.warn(
      '未配置 PUBLIC_BASE_URL：版本更新下发的 download_url 会缺少域名，客户端无法下载安装包。' +
        '请在 .env 里填写对外访问地址，例如 https://auth.example.com',
    );
  } else if (!/^https?:\/\//i.test(publicBaseUrl)) {
    logger.warn(`PUBLIC_BASE_URL 需要带上协议头（http:// 或 https://），当前值：${publicBaseUrl}`);
  }
}

void bootstrap();
