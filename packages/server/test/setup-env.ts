/**
 * 测试环境变量。用独立的 jc_kami_test 库，
 * 避免端到端测试的清库操作误伤开发数据。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://root@127.0.0.1:3306/jc_kami_test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379/9';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.JWT_ACCESS_TTL = '2h';
process.env.JWT_REFRESH_TTL = '7d';
process.env.LICENSE_TOKEN_SECRET = 'test-license-token-secret-0123456789';
process.env.LICENSE_TOKEN_TTL_HOURS = '24';
process.env.LICENSE_KEY_PEPPER = 'test-license-pepper-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY =
  '4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a';
process.env.SIGNATURE_WINDOW_SECONDS = '300';
process.env.LOGIN_MAX_FAILED = '5';
process.env.LOGIN_LOCK_MINUTES = '15';
process.env.RELEASE_STORAGE_DIR = './storage/test-releases';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3100';
