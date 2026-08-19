<?php
declare(strict_types=1);
require __DIR__ . '/autoload.php';

use JcKami\ErrorCode;
use JcKami\LicenseClient;
use JcKami\LicenseError;

$env = [];
foreach (file('/tmp/sdk.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
    [$k, $v] = explode('=', $line, 2);
    $env[$k] = $v;
}

$policies = [];
$client = new LicenseClient([
    'app_id' => 'sdk_demo',
    'server_url' => 'http://127.0.0.1:3100',
    'plugin_id' => $env['SDK_PLUGIN'],
    'plugin_token' => $env['SDK_TOKEN'],
    'plugin_secret' => $env['SDK_SECRET'],
    'client_version' => '1.0.0',
    'on_policy' => function (array $p) use (&$policies) { $policies[] = $p; },
]);

function ok(string $m): void { echo "  \033[32m✓\033[0m $m\n"; }
function bad(string $m): void { echo "  \033[31m✗ $m\033[0m\n"; exit(1); }
function expectCode(callable $fn, string $code, string $label): void {
    try { $fn(); bad("$label 应当抛错但没有"); }
    catch (LicenseError $e) {
        $e->errorCode() === $code
            ? ok("$label: {$e->errorCode()} — {$e->getMessage()}")
            : bad("$label 期望 $code，实际 {$e->errorCode()}");
    }
}

echo "\n【1】设备指纹由稳定标识派生\n";
$run = bin2hex(random_bytes(4));
$device = LicenseClient::deviceIdFor('user:1001:' . $run);
ok('deviceIdFor("user:1001:...") = ' . substr($device, 0, 16) . '...');
if ($device !== LicenseClient::deviceIdFor('user:1001:' . $run)) bad('同一标识必须得到同一指纹');
ok('同一标识重复调用结果一致');
if ($device === LicenseClient::deviceIdFor('user:1002:' . $run)) bad('不同标识不应撞车');
ok('不同标识得到不同指纹');
try { LicenseClient::deviceIdFor('  '); bad('空标识应当抛错'); }
catch (\InvalidArgumentException $e) { ok('空标识被拒: ' . $e->getMessage()); }

echo "\n【2】拉取策略\n";
$p = $client->fetchPolicy($device);
ok("app_status={$p['app_status']}  kill_switch=" . var_export($p['kill_switch'], true));

echo "\n【3】激活\n";
$r = $client->activate($env['SDK_FRESH4'], $device, '网站用户 1001');
ok("license_id={$r['license_id']}  设备 {$r['device_count']}/{$r['device_limit']}  离线宽限 {$r['offline_grace_hours']}h");
$token = $r['license_token'];

echo "\n【4】验证（令牌滚动续期）\n";
$r2 = $client->verify($token, $device);
$r2['license_token'] !== $token ? ok('验证通过，换发了新令牌') : bad('令牌未变化');
$token = $r2['license_token'];

echo "\n【5】状态查询不返回令牌\n";
$s = $client->status(['license_key' => $env['SDK_FRESH4'], 'device_id' => $device]);
ok("status={$s['status']}  本机已绑定=" . var_export($s['device_bound'], true));
if (isset($s['license_token'])) bad('状态查询不应返回令牌');

echo "\n【6】错误卡密\n";
expectCode(fn() => $client->activate('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', $device),
    ErrorCode::LICENSE_NOT_FOUND, '不存在的卡密');

echo "\n【7】令牌与设备不匹配\n";
expectCode(fn() => $client->verify($token, LicenseClient::deviceIdFor('user:9999:' . $run)),
    ErrorCode::TOKEN_INVALID, '换个设备用同一令牌');

echo "\n【8】幂等键：重复提交只生效一次\n";
$d2 = LicenseClient::deviceIdFor('user:2002:' . $run);
$idem = 'php-idem-' . bin2hex(random_bytes(6));
$a = $client->activate($env['SDK_FRESH5'], $d2, null, $idem);
$b = $client->activate($env['SDK_FRESH5'], $d2, null, $idem);
$a['license_token'] === $b['license_token'] ? ok('第二次直接回放首次结果') : bad('幂等未生效');

echo "\n【9】解绑\n";
$d = $client->deactivate($b['license_token'], $d2, 'PHP SDK 测试解绑');
ok('已解绑，剩余换绑 ' . var_export($d['rebind_remaining'], true));
expectCode(fn() => $client->verify($b['license_token'], $d2),
    ErrorCode::TOKEN_INVALID, '解绑后旧令牌');

echo "\n【10】签名错误可被识别\n";
$badClient = new LicenseClient([
    'app_id' => 'sdk_demo', 'server_url' => 'http://127.0.0.1:3100',
    'plugin_id' => $env['SDK_PLUGIN'], 'plugin_token' => $env['SDK_TOKEN'],
    'plugin_secret' => 'sk_totally_wrong_secret', 'max_retries' => 0,
]);
expectCode(fn() => $badClient->fetchPolicy($device), ErrorCode::SIGNATURE_INVALID, '错误密钥');

echo "\n【11】网络不可达\n";
$offline = new LicenseClient([
    'app_id' => 'sdk_demo', 'server_url' => 'http://127.0.0.1:59999',
    'plugin_id' => $env['SDK_PLUGIN'], 'plugin_token' => $env['SDK_TOKEN'],
    'plugin_secret' => $env['SDK_SECRET'], 'max_retries' => 0, 'timeout_ms' => 1500,
]);
expectCode(fn() => $offline->fetchPolicy($device), ErrorCode::NETWORK_UNAVAILABLE, '连不上服务器');

echo "\n【12】缺少必填选项时明确报错\n";
try {
    new LicenseClient(['app_id' => 'x']);
    bad('应当抛 InvalidArgumentException');
} catch (\InvalidArgumentException $e) { ok('构造校验: ' . $e->getMessage()); }

echo "\n\033[32m全部通过\033[0m  （共触发 " . count($policies) . " 次策略回调）\n\n";
