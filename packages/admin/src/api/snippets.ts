/**
 * 各语言 SDK 快速上手代码片段。
 * 把选中应用的 app_id / plugin_id / 服务器地址填进模板，对接人直接复制即用。
 * plugin_token / plugin_secret 一律用占位符——真实值要去「接入凭据」取，不在文档页明文展示。
 */
export interface SnippetCtx {
  serverUrl: string;
  appId: string;
  pluginId: string;
}

export interface Snippet {
  lang: string;
  label: string;
  install: string;
  code: string;
}

export function buildSnippets(ctx: SnippetCtx): Snippet[] {
  const { serverUrl, appId, pluginId } = ctx;
  return [
    {
      lang: 'nodejs',
      label: 'Node.js',
      install: 'pnpm add @jc-kami/sdk',
      code: `import { LicenseClient, LicenseError, ErrorCode } from '@jc-kami/sdk';

const client = new LicenseClient({
  appId: '${appId}',
  serverUrl: '${serverUrl}',
  pluginId: '${pluginId}',
  pluginToken: process.env.JC_PLUGIN_TOKEN,   // 从「接入凭据」获取
  pluginSecret: process.env.JC_PLUGIN_SECRET, // 切勿硬编码或下发到浏览器
  clientVersion: '1.0.0',
});

// 首次激活
await client.activate(userInputKey);

// 每次启动校验
try {
  const r = await client.verify();
  if (r.policy?.upgrade?.required) { promptUpgrade(r.policy.upgrade); process.exit(1); }
  startApp();
} catch (e) {
  if (e instanceof LicenseError && e.code === ErrorCode.NOT_ACTIVATED_LOCALLY) {
    showActivationDialog();
  } else { showError(e); }
}`,
    },
    {
      lang: 'python',
      label: 'Python',
      install: 'pip install ./packages/sdk-python',
      code: `from jc_kami import LicenseClient, LicenseError, ErrorCode
import os

client = LicenseClient(
    app_id="${appId}",
    server_url="${serverUrl}",
    plugin_id="${pluginId}",
    plugin_token=os.environ["JC_PLUGIN_TOKEN"],    # 从「接入凭据」获取
    plugin_secret=os.environ["JC_PLUGIN_SECRET"],  # 切勿硬编码
    client_version="1.0.0",
)

# 首次激活
client.activate(user_input_key)

# 每次启动校验
try:
    result = client.verify()
    if result["policy"] and result["policy"]["upgrade"]["required"]:
        prompt_upgrade(result["policy"]["upgrade"])
        raise SystemExit(1)
    start_app()
except LicenseError as e:
    if e.code == ErrorCode.NOT_ACTIVATED_LOCALLY:
        show_activation_dialog()
    else:
        show_error(f"[{e.code}] {e.message}")`,
    },
    {
      lang: 'php',
      label: 'PHP（网站后端）',
      install: 'composer require jc-kami/sdk',
      code: `use JcKami\\LicenseClient;
use JcKami\\LicenseError;
use JcKami\\ErrorCode;

$client = new LicenseClient([
    'app_id'        => '${appId}',
    'server_url'    => '${serverUrl}',
    'plugin_id'     => '${pluginId}',
    'plugin_token'  => getenv('JC_PLUGIN_TOKEN'),   // 从「接入凭据」获取
    'plugin_secret' => getenv('JC_PLUGIN_SECRET'),  // 只放在服务器，绝不出现在前端
]);

// 设备标识必须稳定：用户 ID、安装 ID 都行，不要用 IP / User-Agent
$device = LicenseClient::deviceIdFor('user:' . $userId);

try {
    $result = $client->activate($licenseKey, $device);
    saveToken($userId, $result['license_token']);   // 存进你自己的库
} catch (LicenseError $e) {
    match ($e->errorCode()) {
        ErrorCode::LICENSE_NOT_FOUND     => flash('卡密不存在'),
        ErrorCode::DEVICE_LIMIT_EXCEEDED => flash('设备数已满，请先解绑'),
        default                          => flash($e->getMessage()),
    };
}`,
    },
    {
      lang: 'csharp',
      label: 'C# / .NET',
      install: 'dotnet add reference packages/sdk-csharp/src/JcKami.Sdk/JcKami.Sdk.csproj',
      code: `using JcKami;

var client = new LicenseClient(new LicenseOptions
{
    AppId         = "${appId}",
    ServerUrl     = "${serverUrl}",
    PluginId      = "${pluginId}",
    PluginToken   = Environment.GetEnvironmentVariable("JC_PLUGIN_TOKEN"),
    PluginSecret  = Environment.GetEnvironmentVariable("JC_PLUGIN_SECRET"),
    ClientVersion = "1.0.0",
});

// 首次激活
await client.ActivateAsync(userInputKey);

// 每次启动校验
try
{
    var result = await client.VerifyAsync();
    if (result.Policy?.Upgrade?.Required == true)
    {
        ShowForcedUpgrade(result.Policy.Upgrade);
        Environment.Exit(1);
    }
    StartApp();
}
catch (LicenseException ex)
{
    if (ex.Code == ErrorCode.NotActivatedLocally) ShowActivationDialog();
    else ShowError($"[{ex.Code}] {ex.Message}");
}`,
    },
    {
      lang: 'curl',
      label: 'cURL（自实现参考）',
      install: '# 任何语言都可照此实现签名',
      code: `# 签名规则见「协议规范」标签页。以拉取策略为例：
TS=$(date +%s)
NONCE=$(uuidgen)
BODY=""                                  # GET 请求 body 为空
BODY_HASH=$(printf "$BODY" | shasum -a 256 | cut -d' ' -f1)
PATH_="/api/v1/license/policy?app_id=${appId}&device_id=DEVICE"
# 签名原文用换行符连接：METHOD\\nPATH\\nTS\\nNONCE\\nBODY_HASH
PAYLOAD=$(printf "GET\\n%s\\n%s\\n%s\\n%s" "$PATH_" "$TS" "$NONCE" "$BODY_HASH")
SIG=$(printf "$PAYLOAD" | openssl dgst -sha256 -hmac "$JC_PLUGIN_SECRET" | cut -d' ' -f2)

curl "${serverUrl}$PATH_" \\
  -H "Authorization: Bearer $JC_PLUGIN_TOKEN" \\
  -H "X-Plugin-Id: ${pluginId}" \\
  -H "X-Timestamp: $TS" \\
  -H "X-Nonce: $NONCE" \\
  -H "X-Signature: $SIG"`,
    },
  ];
}

/** 错误码表，与服务端 8.8 保持一致。 */
export const ERROR_CODES: { code: string; http: number; meaning: string; action: string }[] = [
  { code: 'INVALID_REQUEST', http: 400, meaning: '参数缺失或格式错误', action: '检查请求参数，不重试' },
  { code: 'SIGNATURE_INVALID', http: 401, meaning: '签名或 Token 错误', action: '检查密钥与签名实现，不重试' },
  { code: 'TIMESTAMP_EXPIRED', http: 401, meaning: '时间戳超出 ±300 秒', action: '校准系统时间后重试一次' },
  { code: 'NONCE_REPLAYED', http: 409, meaning: '随机数重复', action: '换 nonce 重试' },
  { code: 'TOKEN_INVALID', http: 401, meaning: '令牌非法/已撤销/与设备不匹配', action: '清除本地令牌，重新激活' },
  { code: 'TOKEN_EXPIRED', http: 401, meaning: '令牌过期', action: '重新调用 verify' },
  { code: 'PLUGIN_DISABLED', http: 403, meaning: '接入端停用或密钥吊销', action: '不重试，联系服务方' },
  { code: 'APP_MISMATCH', http: 403, meaning: '卡密不属于该应用', action: '不重试' },
  { code: 'APP_KILLED', http: 403, meaning: '应用被远程关停', action: '展示服务端提示语，不重试' },
  { code: 'APP_MAINTENANCE', http: 503, meaning: '维护中，暂停新激活', action: '稍后重试' },
  { code: 'CLIENT_VERSION_TOO_LOW', http: 426, meaning: '版本过低', action: '引导升级，不重试' },
  { code: 'LICENSE_NOT_FOUND', http: 404, meaning: '卡密不存在', action: '提示检查输入' },
  { code: 'LICENSE_EXPIRED', http: 403, meaning: '卡密已过期', action: '引导续费' },
  { code: 'LICENSE_BANNED', http: 403, meaning: '卡密已封禁', action: '提示联系客服' },
  { code: 'LICENSE_REVOKED', http: 403, meaning: '卡密已作废', action: '提示联系客服' },
  { code: 'LICENSE_NOT_ACTIVATED', http: 403, meaning: '卡密尚未激活', action: '引导先激活' },
  { code: 'DEVICE_LIMIT_EXCEEDED', http: 403, meaning: '设备数已满', action: '引导解绑其他设备' },
  { code: 'DEVICE_NOT_BOUND', http: 404, meaning: '该设备未绑定此卡密', action: '引导重新激活' },
  { code: 'REBIND_NOT_ALLOWED', http: 403, meaning: '套餐不允许自助换绑', action: '提示联系客服' },
  { code: 'REBIND_LIMIT_EXCEEDED', http: 403, meaning: '换绑次数用尽', action: '提示联系客服' },
  { code: 'IDEMPOTENCY_CONFLICT', http: 409, meaning: '幂等键复用但请求体不同', action: '不重试，属实现缺陷' },
  { code: 'RATE_LIMITED', http: 429, meaning: '触发限流', action: '按 Retry-After 退避' },
  { code: 'INTERNAL_ERROR', http: 500, meaning: '服务端异常', action: '指数退避，最多三次' },
];

/** 只有这四类值得重试。 */
export const RETRYABLE = ['TIMESTAMP_EXPIRED', 'NONCE_REPLAYED', 'RATE_LIMITED', 'INTERNAL_ERROR'];
