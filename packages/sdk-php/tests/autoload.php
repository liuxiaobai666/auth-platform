<?php
// 最小 PSR-4 自动加载，用于免 composer 跑测试
spl_autoload_register(function (string $class): void {
    $prefix = 'JcKami\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) return;
    $relative = substr($class, strlen($prefix));
    $file = __DIR__ . '/../src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) require $file;
});
