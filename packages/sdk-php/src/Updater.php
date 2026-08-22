<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 远程更新：下载、验签、解压、原子切换。
 *
 * 设计要点：
 * - 永远不往正在被访问的目录里解压。新版本进独立的 versions/<版本>/，
 *   再改一个指针文件切过去，所以中途断网、超时都不会让站点变成半新半旧。
 * - 装之前必须验 Ed25519 签名。哈希只能防传输损坏，防不了篡改 ——
 *   能改安装包的人同样能改哈希，只有私钥签的名他伪造不了。
 * - 解压做路径穿越防护。压缩包里一个 ../../ 就能写到目录之外，
 *   而更新包恰恰来自网络，这是必须堵死的口子。
 *
 * PHP 场景下推荐用 {@see stage()} 而不是 {@see apply()}：
 * 网站更新通常是运维动作，落盘和切换要分开，切换时机由部署脚本挑（避开正在处理的请求）。
 *
 * ```php
 * $updater = new Updater('/var/www/myapp', file_get_contents('/etc/myapp/update.pub'));
 * $plan = $client->checkUpdate('1.1.0');
 * if ($plan->available) {
 *     $r = $updater->stage($plan);      // 只落盘，站点仍跑旧版本
 *     // …人工确认 / 灰度 / 低峰期…
 *     $updater->switchTo($r->version);  // 一步切换
 * }
 * ```
 */
class Updater
{
    public const CURRENT_POINTER = 'current.txt';

    private const SIGN_PREFIX = 'jc-kami-release-v1';
    private const CHUNK = 262144;

    private string $root;
    private string $publicKey;
    private int $keepVersions;
    private int $timeout;

    /**
     * @param string $root         应用根目录，versions/ 和 current.txt 都放这里
     * @param string $publicKey    应用的验签公钥（base64 的裸 32 字节），必须内置在客户端。
     *                             绝不能从服务端下发 —— 那样能篡改响应的人可以连公钥一起换。
     * @param int    $keepVersions 保留几个历史版本，用于回滚
     * @param int    $timeout      下载超时（秒）
     */
    public function __construct(string $root, string $publicKey, int $keepVersions = 2, int $timeout = 60)
    {
        if (trim($publicKey) === '') {
            throw new LicenseError(
                ErrorCode::INTERNAL_ERROR,
                '必须提供验签公钥：没有它就无法判断安装包是否被篡改'
            );
        }
        $this->root = rtrim($root, DIRECTORY_SEPARATOR);
        $this->publicKey = trim($publicKey);
        $this->keepVersions = max(1, $keepVersions);
        $this->timeout = max(1, $timeout);
    }

    // ---------------------------------------------------------------- 路径

    public function root(): string
    {
        return $this->root;
    }

    public function versionsDir(): string
    {
        return $this->root . '/versions';
    }

    public function pointerPath(): string
    {
        return $this->root . '/' . self::CURRENT_POINTER;
    }

    public function versionPath(string $version): string
    {
        return $this->versionsDir() . '/' . self::safeVersion($version);
    }

    /** 当前指针指向的版本，没有则返回 null。 */
    public function currentVersion(): ?string
    {
        if (!is_file($this->pointerPath())) {
            return null;
        }
        $value = trim((string) @file_get_contents($this->pointerPath()));
        return $value === '' ? null : $value;
    }

    /** 已安装的版本目录，升序。 */
    public function installedVersions(): array
    {
        $names = @scandir($this->versionsDir());
        if ($names === false) {
            return [];
        }
        $result = [];
        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || substr($name, -8) === '.pending') {
                continue;
            }
            if (is_dir($this->versionsDir() . '/' . $name)) {
                $result[] = $name;
            }
        }
        sort($result, SORT_STRING);
        return $result;
    }

    // ---------------------------------------------------------------- 主流程

    /**
     * 下载 + 校验 + 解压到 versions/<版本>/，**不切换指针**。
     *
     * PHP 站点的推荐姿势：这一步随时能跑（哪怕线上正忙），因为它碰不到正在被访问的目录。
     * 什么时候切换由你决定 —— 见 {@see switchTo()}。
     *
     * @param array $opts progress: callable(int $received, int $total)；
     *                    allowPostInstall: bool，默认 false
     */
    public function stage(UpdatePlan $plan, array $opts = []): UpdateResult
    {
        return $this->run($plan, $opts, false);
    }

    /**
     * 下载 + 校验 + 解压 + 切换指针，一步到位。
     *
     * 桌面端/CLI 场景合适；线上网站建议改用 {@see stage()}，把切换挪到部署窗口。
     *
     * @param array $opts 同 {@see stage()}
     */
    public function apply(UpdatePlan $plan, array $opts = []): UpdateResult
    {
        return $this->run($plan, $opts, true);
    }

    private function run(UpdatePlan $plan, array $opts, bool $switch): UpdateResult
    {
        $progress = $opts['progress'] ?? null;
        $allowPostInstall = !empty($opts['allowPostInstall']);

        if (!$plan->available) {
            return new UpdateResult(false, false, $plan->version, null, '没有可用更新');
        }
        if ($plan->installStrategy === 'notify') {
            // 平台明确表示安装交给宿主自己处理，SDK 不越俎代庖
            return new UpdateResult(false, false, $plan->version, null, '策略为 notify，不自动安装');
        }
        if (!$plan->downloadUrl) {
            $this->fail('更新计划里没有下载地址');
        }
        $version = self::safeVersion($plan->version);
        $target = $this->versionPath($version);

        // 幂等：apply 看指针，stage 只看目录是否已就位
        if (is_dir($target)) {
            if (!$switch) {
                return new UpdateResult(false, true, $version, $target, '该版本已就位，等待切换');
            }
            if ($this->currentVersion() === $version) {
                return new UpdateResult(false, true, $version, $target, '已是该版本');
            }
        }

        $staging = $this->makeStaging();
        $archive = $staging . '/package.bin';
        try {
            $actual = $this->download($plan, $archive, is_callable($progress) ? $progress : null);
            $this->verify($plan, $actual);
            $this->install($plan, $archive, $staging, $version);
        } finally {
            self::rmTree($staging);
        }

        if ($switch) {
            $this->switchTo($version);
            $this->prune();
        }
        if ($allowPostInstall && $plan->postInstall) {
            $this->runPostInstall($plan, $target);
        }

        return new UpdateResult($switch, true, $version, $target);
    }

    /** 切换指针到某个已安装版本。原子写，掉电也不会留下半个指针。 */
    public function switchTo(string $version): string
    {
        $safe = self::safeVersion($version);
        $path = $this->versionPath($safe);
        if (!is_dir($path)) {
            $this->fail("版本 {$safe} 未安装，无法切换");
        }
        $tmp = $this->pointerPath() . '.tmp';
        $fp = @fopen($tmp, 'wb');
        if ($fp === false) {
            $this->fail('无法写入版本指针：' . $this->pointerPath());
        }
        fwrite($fp, $safe);
        fflush($fp);
        if (function_exists('fsync')) {
            @fsync($fp);
        }
        fclose($fp);
        // rename 是原子的：读到的要么是旧版本号，要么是新的，不会是半截
        if (!@rename($tmp, $this->pointerPath())) {
            @unlink($tmp);
            $this->fail('切换版本指针失败');
        }
        return $path;
    }

    /** 回滚到某个已安装版本，只是把指针改回去。 */
    public function rollback(string $version): string
    {
        $safe = self::safeVersion($version);
        if (!is_dir($this->versionPath($safe))) {
            $this->fail("版本 {$safe} 未安装，无法回滚");
        }
        return $this->switchTo($safe);
    }

    // ---------------------------------------------------------------- 各步

    private function makeStaging(): string
    {
        // 暂存放在 root 下，保证和 versions/ 同一个文件系统 —— 跨盘的话 rename 不再原子
        $base = $this->root . '/.updates';
        if (!is_dir($base) && !@mkdir($base, 0775, true) && !is_dir($base)) {
            $this->fail('无法创建暂存目录：' . $base);
        }
        $path = $base . '/jckami-' . bin2hex(random_bytes(6));
        if (!@mkdir($path, 0775, true)) {
            $this->fail('无法创建暂存目录：' . $path);
        }
        return $path;
    }

    /**
     * 流式下载并同步算哈希，返回实际 sha256。
     *
     * 边下边算，不需要把整个包读进内存 —— 更新包动辄几十上百 MB，
     * file_get_contents 会直接撞 memory_limit。
     */
    private function download(UpdatePlan $plan, string $target, ?callable $progress): string
    {
        $fp = @fopen($target, 'wb');
        if ($fp === false) {
            $this->fail('无法写入下载文件：' . $target);
        }

        $ctx = hash_init('sha256');
        $received = 0;
        $overflow = false;
        $total = $plan->fileSize ?: 0;

        $ch = curl_init($plan->downloadUrl);
        curl_setopt_array($ch, [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => min(30, $this->timeout),
            CURLOPT_FAILONERROR => true,
            // 跟随重定向时前一个响应可能带正文；每见到一次新的状态行就把已收内容作废，
            // 否则 302 的 HTML 说明页会被算进哈希
            CURLOPT_HEADERFUNCTION => function ($ch, string $header) use (&$ctx, &$received, &$fp, &$total, $plan) {
                if (stripos($header, 'HTTP/') === 0) {
                    $ctx = hash_init('sha256');
                    $received = 0;
                    ftruncate($fp, 0);
                    rewind($fp);
                } elseif (!$plan->fileSize && stripos($header, 'content-length:') === 0) {
                    $total = (int) trim(substr($header, 15));
                }
                return strlen($header);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (
                &$ctx, &$received, &$overflow, &$total, $fp, $plan, $progress
            ) {
                $len = strlen($chunk);
                $received += $len;
                // 声明多大就只收多大，避免被超长响应撑爆磁盘
                if ($plan->fileSize && $received > $plan->fileSize) {
                    $overflow = true;
                    return 0; // 返回值与长度不符即中止传输
                }
                fwrite($fp, $chunk);
                hash_update($ctx, $chunk);
                if ($progress) {
                    $progress($received, $total ?: ($plan->fileSize ?: 0));
                }
                return $len;
            },
        ]);
        $okCurl = curl_exec($ch);
        $curlError = curl_error($ch);
        if (is_resource($ch)) {
            curl_close($ch);
        }
        fclose($fp);

        if ($overflow) {
            $this->fail('下载内容超出声明大小，已中止');
        }
        if ($okCurl === false) {
            $this->fail('下载更新包失败：' . $curlError, ErrorCode::NETWORK_UNAVAILABLE);
        }
        if ($plan->fileSize && $received !== $plan->fileSize) {
            $this->fail("下载不完整：期望 {$plan->fileSize} 字节，实际 {$received} 字节");
        }
        return hash_final($ctx);
    }

    /** 校验哈希与签名。任何一项不过就抛错，绝不落盘。 */
    private function verify(UpdatePlan $plan, string $actualSha256): void
    {
        if ($plan->sha256 && !hash_equals($plan->sha256, $actualSha256)) {
            $this->fail('安装包哈希不匹配，可能已损坏或被篡改');
        }
        if (!$plan->isSigned()) {
            $this->fail('该版本没有签名，拒绝安装。请在后台重新发布以生成签名');
        }
        // fileSize 是签名载荷的一部分，缺了就拼不出正确的待验字符串
        if ($plan->fileSize === null) {
            $this->fail('更新信息缺少 file_size，无法验签');
        }

        $payload = implode("\n", [
            self::SIGN_PREFIX,
            $plan->appId,
            (string) $plan->version,
            $actualSha256,
            (string) $plan->fileSize,
        ]);

        $publicKey = base64_decode($this->publicKey, true);
        $signature = base64_decode((string) $plan->signature, true);
        if ($publicKey === false || $signature === false) {
            $this->fail('签名或公钥格式非法');
        }
        if (!Ed25519::verify($publicKey, $payload, $signature)) {
            $this->fail('签名验证失败，拒绝安装：这个包不是平台签发的');
        }
    }

    private function install(UpdatePlan $plan, string $archive, string $staging, string $version): string
    {
        $unpacked = $staging . '/unpacked';
        if ($plan->packageType === 'onefile' && !self::isZip($archive)) {
            // 单文件形态：包本身就是可执行文件/脚本，不需要解压
            if (!@mkdir($unpacked, 0775, true)) {
                $this->fail('无法创建解压目录');
            }
            $name = self::safeEntryName($plan->entry ?: 'app.bin');
            if (!@copy($archive, $unpacked . '/' . $name)) {
                $this->fail('无法写出单文件更新包');
            }
        } else {
            self::extractArchive($archive, $unpacked, $plan->stripRootDir);
        }

        $target = $this->versionPath($version);
        $pending = $target . '.pending';
        self::rmTree($pending);
        if (!is_dir($this->versionsDir()) && !@mkdir($this->versionsDir(), 0775, true) && !is_dir($this->versionsDir())) {
            $this->fail('无法创建 versions 目录');
        }
        if (!@rename($unpacked, $pending)) {
            $this->fail('无法移动解压结果到 ' . $pending);
        }
        self::rmTree($target);
        // rename 是原子的：要么完整出现，要么完全不存在，不会留下半个版本
        if (!@rename($pending, $target)) {
            self::rmTree($pending);
            $this->fail('无法就位到 ' . $target);
        }
        return $target;
    }

    private function prune(): void
    {
        $keep = $this->currentVersion();
        $versions = array_values(array_filter(
            $this->installedVersions(),
            static fn(string $v): bool => $v !== $keep
        ));
        // 留最近的几个，其余删掉；保留的用于随时回滚
        $drop = max(0, count($versions) - ($this->keepVersions - 1));
        foreach (array_slice($versions, 0, $drop) as $name) {
            self::rmTree($this->versionsDir() . '/' . $name);
        }
    }

    /**
     * 执行安装后命令。
     *
     * 默认不开：这条命令来自服务端且**不在签名保护范围内**，
     * 一旦响应被篡改就等于任意代码执行。确实需要时由调用方显式打开。
     */
    private function runPostInstall(UpdatePlan $plan, string $target): void
    {
        $cwd = getcwd();
        @chdir($target);
        $output = [];
        $code = 0;
        @exec($plan->postInstall . ' 2>&1', $output, $code);
        if ($cwd !== false) {
            @chdir($cwd);
        }
        if ($code !== 0) {
            $this->fail('安装后命令执行失败（退出码 ' . $code . '）：' . implode("\n", array_slice($output, -5)));
        }
    }

    // ---------------------------------------------------------------- 解压

    /**
     * 解压 zip 到目标目录，带路径穿越防护与智能剥层。
     *
     * 单独开放出来是为了让调用方能对「不信任的压缩包」复用同一套防护。
     */
    public static function extractArchive(string $archive, string $dest, bool $stripRoot = false): void
    {
        if (!class_exists('ZipArchive')) {
            throw new LicenseError(
                ErrorCode::INTERNAL_ERROR,
                '当前 PHP 缺少 zip 扩展（ZipArchive），无法解压更新包。请启用 ext-zip'
            );
        }
        if (!is_dir($dest) && !@mkdir($dest, 0775, true) && !is_dir($dest)) {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '无法创建解压目录：' . $dest);
        }

        $zip = new \ZipArchive();
        if ($zip->open($archive) !== true) {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '无法识别的更新包格式，仅支持 zip');
        }

        try {
            $names = [];
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat !== false) {
                    $names[$i] = $stat['name'];
                }
            }
            $prefix = self::resolveStripPrefix($names, $stripRoot);
            $destRoot = realpath($dest);
            if ($destRoot === false) {
                throw new LicenseError(ErrorCode::INTERNAL_ERROR, '解压目录不可用：' . $dest);
            }

            foreach ($names as $index => $name) {
                $rel = ltrim(str_replace('\\', '/', $name), '/');
                if ($prefix !== '') {
                    if (strncmp($rel, $prefix, strlen($prefix)) !== 0) {
                        continue;
                    }
                    $rel = substr($rel, strlen($prefix));
                }
                $isDir = $rel === '' || substr($rel, -1) === '/';
                $rel = rtrim($rel, '/');
                if ($rel === '' || $rel === '.' || $rel === '..') {
                    continue;
                }

                $targetPath = self::resolveInside($destRoot, $rel, $name);
                if ($isDir) {
                    if (!is_dir($targetPath) && !@mkdir($targetPath, 0775, true) && !is_dir($targetPath)) {
                        throw new LicenseError(ErrorCode::INTERNAL_ERROR, '无法创建目录：' . $targetPath);
                    }
                    continue;
                }
                $parent = dirname($targetPath);
                if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
                    throw new LicenseError(ErrorCode::INTERNAL_ERROR, '无法创建目录：' . $parent);
                }
                // 目录建好后再确认一次真实路径：挡掉「先解出一个软链、再顺着它写到目录外」
                $realParent = realpath($parent);
                if ($realParent === false || !self::isInside($destRoot, $realParent)) {
                    throw new LicenseError(
                        ErrorCode::INTERNAL_ERROR,
                        '更新包内含越界路径，已中止：' . $name
                    );
                }

                $src = $zip->getStream($name);
                if ($src === false) {
                    throw new LicenseError(ErrorCode::INTERNAL_ERROR, '更新包条目无法读取：' . $name);
                }
                $dst = @fopen($targetPath, 'wb');
                if ($dst === false) {
                    fclose($src);
                    throw new LicenseError(ErrorCode::INTERNAL_ERROR, '无法写入文件：' . $targetPath);
                }
                stream_copy_to_stream($src, $dst);
                fclose($src);
                fclose($dst);

                self::restoreMode($targetPath, self::readUnixMode($zip, $index));
            }
        } finally {
            $zip->close();
        }
    }

    /**
     * 读出 zip 条目里记录的 Unix mode，没有则返回 0。
     *
     * ZipArchive 不直接暴露 external_attr，只能走 getExternalAttributesIndex()。
     * 高 16 位是 mode，但仅当打包系统是 Unix 时才有意义——Windows 工具写进去的
     * 是 FAT 属性位，照着 chmod 会得到一个完全无关的权限。
     */
    private static function readUnixMode(\ZipArchive $zip, int $index): int
    {
        if (!method_exists($zip, 'getExternalAttributesIndex')) {
            return 0;
        }
        $opsys = 0;
        $attr = 0;
        if (@$zip->getExternalAttributesIndex($index, $opsys, $attr) !== true) {
            return 0;
        }
        if ($opsys !== \ZipArchive::OPSYS_UNIX) {
            return 0;
        }
        return ((int) $attr) >> 16;
    }

    /**
     * 恢复压缩包里记录的权限位。
     *
     * 不恢复的话，从 zip 解出来的可执行文件在 macOS/Linux 上是 644，
     * 启动器根本起不来——Windows 没有这个概念，所以这个坑只在类 Unix 上炸。
     *
     * 只取 rwx 九位：setuid/setgid/sticky 一概丢弃。
     * 更新包来自网络，让它决定这些位等于把提权的口子交出去。
     */
    private static function restoreMode(string $path, int $mode): void
    {
        // mode 为 0 是 Windows 工具打的包的常态，此时不要强行设成 000
        if ($mode === 0 || DIRECTORY_SEPARATOR === '\\') {
            return;
        }
        $bits = $mode & 0777;
        if ($bits === 0) {
            return;
        }
        // 文件系统不支持权限位时不影响主流程，所以静默失败
        @chmod($path, $bits);
    }

    /**
     * 算出该剥掉的前缀。
     *
     * 只有「所有条目都在同一个顶层目录下」才剥，比如 YourApp/index.php → index.php。
     * 包本身就是平铺的（index.php 和 vendor/ 并列）时必须原样保留：
     * 无脑剥一层会把顶层文件整个丢掉，装出来的版本直接跑不起来。
     */
    private static function resolveStripPrefix(array $names, bool $stripRoot): string
    {
        if (!$stripRoot) {
            return '';
        }
        $top = null;
        foreach ($names as $name) {
            $rel = trim(str_replace('\\', '/', $name), '/');
            if ($rel === '') {
                continue;
            }
            $parts = explode('/', $rel);
            if (count($parts) === 1) {
                return ''; // 顶层直接有文件，说明没有公共根目录
            }
            if ($top === null) {
                $top = $parts[0];
            } elseif ($top !== $parts[0]) {
                return ''; // 有多个并列的顶层目录，剥了会撞名
            }
        }
        return $top === null ? '' : $top . '/';
    }

    /**
     * 把条目路径解析成目标绝对路径，越界一律拒绝。
     *
     * 压缩包来自网络，里面完全可能藏着 ../../../etc/cron.d/x 这样的条目。
     * 这里按词法逐段展开（realpath 对还不存在的路径返回 false，不能直接用），
     * 任何一步走出目标目录都当场中止。
     */
    private static function resolveInside(string $destRoot, string $rel, string $original): string
    {
        $parts = [];
        foreach (explode('/', $rel) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                if (!$parts) {
                    throw new LicenseError(
                        ErrorCode::INTERNAL_ERROR,
                        '更新包内含越界路径，已中止：' . $original
                    );
                }
                array_pop($parts);
                continue;
            }
            $parts[] = $part;
        }
        if (!$parts) {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '更新包内含非法路径，已中止：' . $original);
        }
        $target = $destRoot . '/' . implode('/', $parts);
        if (!self::isInside($destRoot, $target)) {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '更新包内含越界路径，已中止：' . $original);
        }
        return $target;
    }

    private static function isInside(string $root, string $path): bool
    {
        return $path === $root || strncmp($path, rtrim($root, '/') . '/', strlen(rtrim($root, '/')) + 1) === 0;
    }

    // ---------------------------------------------------------------- 工具

    /** 版本号会被拼进路径，必须挡掉 ../ 之类的字符。 */
    public static function safeVersion(?string $version): string
    {
        $value = trim((string) $version);
        if ($value === '' || !preg_match('/^[A-Za-z0-9.+_-]+$/', $value)) {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '版本号非法：' . var_export($version, true));
        }
        if (strpos($value, '..') !== false || $value[0] === '.') {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '版本号非法：' . var_export($version, true));
        }
        return $value;
    }

    /** 单文件包的落地文件名同样来自服务端，同样要过滤。 */
    private static function safeEntryName(string $entry): string
    {
        $name = basename(str_replace('\\', '/', $entry));
        if ($name === '' || $name === '.' || $name === '..') {
            throw new LicenseError(ErrorCode::INTERNAL_ERROR, '入口文件名非法：' . $entry);
        }
        return $name;
    }

    private static function isZip(string $path): bool
    {
        $fp = @fopen($path, 'rb');
        if ($fp === false) {
            return false;
        }
        $magic = fread($fp, 4);
        fclose($fp);
        return $magic === "PK\x03\x04" || $magic === "PK\x05\x06" || $magic === "PK\x07\x08";
    }

    public static function rmTree(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            @unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        $items = @scandir($path);
        if ($items !== false) {
            foreach ($items as $item) {
                if ($item !== '.' && $item !== '..') {
                    self::rmTree($path . '/' . $item);
                }
            }
        }
        @rmdir($path);
    }

    private function fail(string $message, string $code = ErrorCode::INTERNAL_ERROR): void
    {
        throw new LicenseError($code, $message);
    }
}
