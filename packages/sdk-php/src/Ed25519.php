<?php

declare(strict_types=1);

namespace JcKami;

/**
 * Ed25519 验签。
 *
 * 只做一件事：判断「这个包确实是平台用私钥签发的」。哈希只能防传输损坏，
 * 防不了篡改 —— 能替换安装包的人同样能替换哈希，只有签名伪造不了。
 *
 * 这里不提供任何「验不了就跳过」的降级路径：那等于把保护直接关掉，
 * 比不做签名更危险（调用方以为验过了）。没有 sodium 就明确抛错。
 */
final class Ed25519
{
    /**
     * 小阶点黑名单。
     *
     * 全零公钥之类的小阶点会让验签对**任意**消息都通过，攻击者只要把响应里的
     * 公钥换成它就能绕过一切校验。虽然本 SDK 的公钥内置在客户端、不从服务端下发，
     * 这里依然兜一层：万一调用方把公钥做成了可配置项，也不至于被一个全零串攻破。
     */
    private const SMALL_ORDER_POINTS = [
        '0100000000000000000000000000000000000000000000000000000000000000',
        'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '0000000000000000000000000000000000000000000000000000000000000080',
        '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
        'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
        '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
        'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    ];

    private function __construct()
    {
    }

    /** 运行环境是否具备验签能力。 */
    public static function available(): bool
    {
        return function_exists('sodium_crypto_sign_verify_detached')
            || function_exists('Sodium\crypto_sign_verify_detached');
    }

    /**
     * 校验分离式签名。
     *
     * @param string $publicKey 裸 32 字节公钥
     * @param string $message   签名原文
     * @param string $signature 64 字节签名
     *
     * @throws LicenseError 当前环境没有 sodium，无法验签
     */
    public static function verify(string $publicKey, string $message, string $signature): bool
    {
        // 长度不对直接判否：交给 sodium 会抛异常，不如在这里给出确定结论
        if (strlen($publicKey) !== 32 || strlen($signature) !== 64) {
            return false;
        }
        if (in_array(bin2hex($publicKey), self::SMALL_ORDER_POINTS, true)) {
            return false;
        }

        if (function_exists('sodium_crypto_sign_verify_detached')) {
            try {
                return sodium_crypto_sign_verify_detached($signature, $message, $publicKey);
            } catch (\SodiumException $e) {
                return false;
            }
        }
        if (function_exists('Sodium\crypto_sign_verify_detached')) {
            // PHP 7.2 之前的 pecl libsodium 老扩展
            try {
                return (bool) \Sodium\crypto_sign_verify_detached($signature, $message, $publicKey);
            } catch (\Throwable $e) {
                return false;
            }
        }

        throw new LicenseError(
            ErrorCode::INTERNAL_ERROR,
            '当前 PHP 缺少 sodium 扩展，无法验证更新包签名。'
            . '请启用 ext-sodium（PHP 7.2+ 内置）后再安装更新 —— 跳过验签等于放弃防篡改保护'
        );
    }
}
