<?php

declare(strict_types=1);

/**
 * 远程更新端到端：真服务器、真包、真安装，外加攻击场景。
 *
 * 跑之前先起后端：cd packages/server && node dist/main.js
 *   php tests/update_test.php
 */

require __DIR__ . '/autoload.php';

use JcKami\LicenseClient;
use JcKami\LicenseError;
use JcKami\UpdatePlan;
use JcKami\Updater;

const BASE = 'http://127.0.0.1:3100';

$failures = 0;

function ok(bool $cond, string $msg): void
{
    global $failures;
    echo '  ' . ($cond ? "\033[32m✓\033[0m" : "\033[31m✗\033[0m") . " $msg\n";
    if (!$cond) {
        $failures++;
    }
}

function section(string $title): void
{
    echo "\n\033[1m$title\033[0m\n";
}

function expectReject(callable $fn, string $desc): void
{
    try {
        $fn();
        ok(false, "$desc → 竟然通过了！");
    } catch (LicenseError $e) {
        ok(true, "$desc → 拒绝（" . mb_substr($e->getMessage(), 0, 22) . '…）');
    } catch (\Throwable $e) {
        ok(false, "$desc → 抛了非预期异常 " . get_class($e) . ': ' . $e->getMessage());
    }
}

function api(string $method, string $path, $body = null, ?string $token = null, ?string $ctype = null): array
{
    $headers = [];
    $payload = null;
    if (is_string($body)) {
        $payload = $body;
    } elseif ($body !== null) {
        $payload = json_encode($body, JSON_UNESCAPED_UNICODE);
        $headers[] = 'Content-Type: application/json';
    }
    if ($ctype !== null) {
        $headers[] = 'Content-Type: ' . $ctype;
    }
    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }
    $ch = curl_init(BASE . $path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 60,
    ]);
    if ($payload !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        fwrite(STDERR, "\033[31m后端未启动？" . curl_error($ch) . "\033[0m\n");
        exit(1);
    }
    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : [];
}

function rrmdir(string $path): void
{
    Updater::rmTree($path);
}

echo "\n\033[1m══════ PHP SDK 远程更新端到端 ══════\033[0m\n";

// ------------------------------------------------------------------ 准备

section('【0】准备：建应用、取内置公钥');
$admin = api('POST', '/api/v1/admin/auth/login', ['username' => 'admin', 'password' => 'Admin@123456']);
if (empty($admin['access_token'])) {
    fwrite(STDERR, "\033[31m管理员登录失败\033[0m\n");
    exit(1);
}
$adm = $admin['access_token'];
$appId = 'phpup_' . bin2hex(random_bytes(3));
$app = api('POST', '/api/v1/admin/applications', [
    'app_id' => $appId, 'name' => 'PHP 更新演示', 'type' => 'web',
], $adm);
ok(!empty($app['id']), "应用已创建 app_id={$appId}");
$detail = api('GET', "/api/v1/admin/applications/{$app['id']}", null, $adm);
$pubKey = $detail['update_sign_public_key'] ?? '';
ok($pubKey !== '' && strlen(base64_decode($pubKey, true) ?: '') === 32, '拿到 32 字节 Ed25519 公钥（内置进客户端，不从策略下发）');
$cred = $app['default_plugin']['credentials'];

ok(\JcKami\Ed25519::available(), 'sodium 验签可用：' . (\JcKami\Ed25519::available() ? 'ext-sodium' : '缺失'));

// ------------------------------------------------------------------ 造包

section('【1】造一个网站更新包（外层多套一层目录，测 strip_root_dir）');
$work = sys_get_temp_dir() . '/phpup-' . bin2hex(random_bytes(4));
mkdir($work, 0775, true);
$pkg = $work . '/MySite-1.2.0.zip';
$zip = new ZipArchive();
$zip->open($pkg, ZipArchive::CREATE | ZipArchive::OVERWRITE);
$zip->addFromString('MySite/index.php', "<?php echo 'v1.2.0';\n");
$zip->addFromString('MySite/vendor/lib/util.php', str_repeat("// pad\n", 500));
$zip->addFromString('MySite/config/app.json', json_encode(['ver' => '1.2.0']));
$zip->addFromString('MySite/README.txt', 'v1.2.0 说明');
$zip->close();
$size = filesize($pkg);
$sha = hash_file('sha256', $pkg);
ok($size > 0, "包已生成 {$size} 字节，含嵌套目录");

section('【2】上传并发布（服务端签名）');
$boundary = '----jck' . bin2hex(random_bytes(8));
$fields = [
    'application_id' => $app['id'], 'version' => '1.2.0', 'channel' => 'stable',
    'package_type' => 'zip', 'install_strategy' => 'versioned', 'strip_root_dir' => 'true',
    'entry' => 'index.php', 'release_notes' => 'PHP 站点新版本',
];
$body = '';
foreach ($fields as $k => $v) {
    $body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$k}\"\r\n\r\n{$v}\r\n";
}
$body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"MySite-1.2.0.zip\"\r\n"
    . "Content-Type: application/zip\r\n\r\n" . file_get_contents($pkg) . "\r\n--{$boundary}--\r\n";
$rel = api('POST', '/api/v1/admin/releases', $body, $adm, "multipart/form-data; boundary={$boundary}");
ok(($rel['sha256'] ?? '') === $sha, '服务端算出的哈希与本地一致');
$published = api('POST', "/api/v1/admin/releases/{$rel['id']}/publish", [], $adm);
ok(($published['signed'] ?? false) === true, '已发布并完成签名');

// ------------------------------------------------------------------ 检查更新

section('【3】客户端检查更新');
$client = new LicenseClient([
    'app_id' => $appId,
    'server_url' => BASE,
    'plugin_id' => $app['default_plugin']['plugin_id'],
    'plugin_token' => $cred['plugin_token'],
    'plugin_secret' => $cred['plugin_secret'],
]);
$plan = $client->checkUpdate('1.1.0');
ok($plan->available && $plan->version === '1.2.0', "发现新版本 {$plan->version}");
ok($plan->packageType === 'zip' && $plan->installStrategy === 'versioned', '拿到安装策略');
ok($plan->stripRootDir === true && $plan->entry === 'index.php', '拿到剥层/入口配置');
ok($plan->isSigned(), '带签名');
ok($plan->sha256 === $sha && $plan->fileSize === $size, '哈希/大小与本地包一致');

$none = $client->checkUpdate('9.9.9');
ok(!$none->available, '已是最新版时 available=false');

// ------------------------------------------------------------------ stage

section('【4】stage()：落盘但不切指针（PHP 站点推荐姿势）');
$rootA = $work . '/siteA';
mkdir($rootA . '/versions/1.1.0', 0775, true);
file_put_contents($rootA . '/versions/1.1.0/index.php', "<?php echo 'v1.1.0';\n");
$updA = new Updater($rootA, $pubKey);
$updA->switchTo('1.1.0');

$seen = [];
$staged = $updA->stage($plan, ['progress' => function (int $got, int $total) use (&$seen) {
    $seen[] = $got;
}]);
ok($staged->staged && !$staged->applied, 'stage 返回 staged=true / applied=false');
ok(count($seen) > 0, '下载进度回调触发 ' . count($seen) . ' 次，最后一次 ' . end($seen) . ' 字节');
ok(is_dir($rootA . '/versions/1.2.0'), '新版本目录已就位');
ok($updA->currentVersion() === '1.1.0', '指针仍然指向 1.1.0（线上仍跑旧版本）');
ok(is_file($rootA . '/versions/1.2.0/index.php'), 'index.php 就位（外层 MySite/ 已剥掉）');
ok(is_file($rootA . '/versions/1.2.0/vendor/lib/util.php'), '嵌套目录 vendor/ 完整解压');
ok(!file_exists($rootA . '/versions/1.2.0/MySite'), 'strip_root_dir 生效，没有多余层级');
ok(json_decode(file_get_contents($rootA . '/versions/1.2.0/config/app.json'), true)['ver'] === '1.2.0', '深层文件内容正确');

$staged2 = $updA->stage($plan);
ok($staged2->staged && !$staged2->applied && $staged2->skippedReason !== null, '重复 stage 直接跳过：' . $staged2->skippedReason);

section('【5】switchTo()：运维挑时机一步切换');
$updA->switchTo('1.2.0');
ok($updA->currentVersion() === '1.2.0', '指针已切到 1.2.0');
ok(trim(file_get_contents($rootA . '/' . Updater::CURRENT_POINTER)) === '1.2.0', 'current.txt 内容正确');
ok($updA->installedVersions() === ['1.1.0', '1.2.0'], '两个版本都在，随时可回滚');
expectReject(fn() => $updA->switchTo('7.7.7'), '切到未安装的版本');

// ------------------------------------------------------------------ apply

section('【6】apply()：下载+验签+解压+切指针 一步到位');
$rootB = $work . '/siteB';
mkdir($rootB, 0775, true);
$updB = new Updater($rootB, $pubKey);
$res = $updB->apply($plan);
ok($res->applied && $res->staged, '安装成功 → ' . str_replace($rootB . '/', '', (string) $res->path));
ok($updB->currentVersion() === '1.2.0', 'current.txt 指针已切到 1.2.0');
ok(is_file($rootB . '/versions/1.2.0/index.php'), '文件就位');
ok(!is_dir($rootB . '/.updates/' . basename((string) $res->path)), '暂存目录已清理');

section('【7】幂等：重复安装同版本不重做');
$res2 = $updB->apply($plan);
ok(!$res2->applied && strpos((string) $res2->skippedReason, '已是该版本') !== false, '识别为已安装，跳过');

// ------------------------------------------------------------------ 攻击

section('【8】攻击场景：必须拒绝');
$rootC = $work . '/siteC';
mkdir($rootC, 0775, true);

// 攻击者用自己的密钥签名 —— 客户端内置公钥对不上
$fakePair = sodium_crypto_sign_keypair();
$fakePub = base64_encode(sodium_crypto_sign_publickey($fakePair));
expectReject(fn() => (new Updater($rootC, $fakePub))->apply($plan), '公钥不匹配（伪造签名）');

// 全零公钥：小阶点，没有黑名单的话能对任意消息验过
expectReject(fn() => (new Updater($rootC, base64_encode(str_repeat("\0", 32))))->apply($plan), '全零小阶点公钥');

$mk = function (array $over) use ($plan, $appId): UpdatePlan {
    return new UpdatePlan($appId, array_merge([
        'available' => true, 'latest_version' => $plan->version, 'download_url' => $plan->downloadUrl,
        'sha256' => $plan->sha256, 'file_size' => $plan->fileSize, 'signature' => $plan->signature,
        'package' => ['type' => 'zip', 'install_strategy' => 'versioned', 'strip_root_dir' => true],
    ], $over));
};
expectReject(fn() => (new Updater($rootC, $pubKey))->apply($mk(['latest_version' => '9.9.9'])), '冒充更高版本号');
expectReject(fn() => (new Updater($rootC, $pubKey))->apply($mk(['sha256' => str_repeat('0', 64)])), '哈希对不上（包被换）');
expectReject(fn() => (new Updater($rootC, $pubKey))->apply($mk(['signature' => null])), '未签名的包');
expectReject(fn() => (new Updater($rootC, $pubKey))->apply($mk(['file_size' => 100])), '声明大小造假（下载超量中止）');
expectReject(fn() => new Updater($rootC, ''), '构造 Updater 时不给公钥');
ok(!is_dir($rootC . '/versions'), '所有攻击都没能在磁盘上留下任何版本目录');

section('【9】Zip Slip 路径穿越');
$evil = $work . '/evil.zip';
$z = new ZipArchive();
$z->open($evil, ZipArchive::CREATE | ZipArchive::OVERWRITE);
$z->addFromString('../../../../../../tmp/jck-php-pwned.txt', 'PWNED');
$z->addFromString('index.php', 'x');
$z->close();
@unlink('/tmp/jck-php-pwned.txt');
expectReject(fn() => Updater::extractArchive($evil, $work . '/extract-test', false), '含 ../ 的恶意包');
ok(!file_exists('/tmp/jck-php-pwned.txt'), '确认 /tmp 未被写入');

section('【10】智能剥层：平铺包不许剥');
$flat = $work . '/flat.zip';
$z = new ZipArchive();
$z->open($flat, ZipArchive::CREATE | ZipArchive::OVERWRITE);
$z->addFromString('index.php', 'flat');
$z->addFromString('vendor/a.php', 'a');
$z->close();
$flatDest = $work . '/flat-out';
Updater::extractArchive($flat, $flatDest, true);
ok(is_file($flatDest . '/index.php') && is_file($flatDest . '/vendor/a.php'), '平铺结构原样保留，顶层文件没被剥掉');

section('【11】版本号注入');
foreach (['../../etc', '..', '/abs', 'a b', '', '.hidden', 'v1;rm -rf /'] as $badVer) {
    expectReject(fn() => Updater::safeVersion($badVer), '非法版本号 ' . var_export($badVer, true));
}
ok(Updater::safeVersion('1.2.0-beta.1+build_7') === '1.2.0-beta.1+build_7', '正常版本号照常放行');

section('【12】回滚');
ok($updA->rollback('1.1.0') !== '', '回滚调用成功');
ok($updA->currentVersion() === '1.1.0', '指针已回滚到 1.1.0');
ok(is_file($rootA . '/versions/1.2.0/index.php'), '1.2.0 仍保留在磁盘上，可再切回去');
expectReject(fn() => $updA->rollback('8.8.8'), '回滚到未安装的版本');

section('【13】post_install 默认不执行');
$marker = $work . '/post-install-ran.txt';
$rootD = $work . '/siteD';
mkdir($rootD, 0775, true);
$evilPlan = new UpdatePlan($appId, array_merge($plan->raw, [
    'package' => array_merge($plan->raw['package'], ['post_install' => "touch {$marker}"]),
]));
(new Updater($rootD, $pubKey))->apply($evilPlan);
ok(!file_exists($marker), 'post_install 未被执行（不在签名保护范围内，默认关闭）');

$rootD2 = $work . '/siteD2';
mkdir($rootD2, 0775, true);
(new Updater($rootD2, $pubKey))->apply($evilPlan, ['allowPostInstall' => true]);
ok(file_exists($marker), '显式开启 allowPostInstall 后才执行');

section('【14】notify 策略不自动装');
$rootE = $work . '/siteE';
mkdir($rootE, 0775, true);
$notify = $mk(['package' => ['type' => 'zip', 'install_strategy' => 'notify']]);
$r = (new Updater($rootE, $pubKey))->apply($notify);
ok(!$r->applied && strpos((string) $r->skippedReason, 'notify') !== false, '策略为 notify → 交给宿主自己处理');
ok(!is_dir($rootE . '/versions'), '什么都没下载');

section('【15】Unix 权限位：可执行文件解压后还得是可执行的');
if (DIRECTORY_SEPARATOR === '\\') {
    ok(true, 'Windows 无权限位概念，跳过');
} else {
    $permZip = $work . '/perm.zip';
    $z = new ZipArchive();
    $z->open($permZip, ZipArchive::CREATE | ZipArchive::OVERWRITE);
    // 高 16 位是 Unix mode，0100000 是 S_IFREG（普通文件）标志位
    $z->addFromString('bin/run.sh', "#!/bin/sh\necho hi\n");
    $z->setExternalAttributesName('bin/run.sh', ZipArchive::OPSYS_UNIX, 0100755 << 16);
    $z->addFromString('data.txt', 'plain');
    $z->setExternalAttributesName('data.txt', ZipArchive::OPSYS_UNIX, 0100644 << 16);
    $z->addFromString('bin/suid', 'evil');
    $z->setExternalAttributesName('bin/suid', ZipArchive::OPSYS_UNIX, 0104755 << 16);
    $z->close();

    $permDest = $work . '/perm-out';
    Updater::extractArchive($permZip, $permDest, false);

    clearstatcache();
    $runMode = fileperms($permDest . '/bin/run.sh') & 07777;
    $txtMode = fileperms($permDest . '/data.txt') & 07777;
    $suidMode = fileperms($permDest . '/bin/suid') & 07777;

    ok($runMode === 0755, sprintf('755 的可执行文件恢复了执行位（实际 %04o）', $runMode));
    ok($txtMode === 0644, sprintf('644 的普通文件权限不变（实际 %04o）', $txtMode));
    ok(($suidMode & 04000) === 0, sprintf('setuid 位被丢弃，防止提权（实际 %04o）', $suidMode));
    ok(($suidMode & 0111) !== 0, sprintf('但执行位仍保留（实际 %04o）', $suidMode));
}

rrmdir($work);

if ($failures === 0) {
    echo "\n\033[32m全部通过\033[0m\n\n";
    exit(0);
}
echo "\n\033[31m{$failures} 项失败\033[0m\n\n";
exit(1);
