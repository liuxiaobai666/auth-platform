/**
 * 设备指纹脱敏。
 *
 * 脱敏的目的是不把完整指纹暴露给后台，但**必须保留足够的可分辨性** ——
 * 运营要靠它判断「该解绑哪一台」，两台不同设备显示成同一串就没法用了。
 * 之前只保留首 6 位加末 4 位，前缀相同的设备会撞成一样。
 *
 * 现在的规则：
 *   长度 ≤ 20 的标识按原样返回（这类通常是调用方自己给的业务标识，不是硬件指纹）；
 *   更长的保留首 10 位与末 8 位，中间打码。48 位十六进制指纹会露出 18 位，
 *   既足够区分，也远不足以反推完整值。
 */
export function maskDeviceId(deviceId: string | null | undefined): string | null {
  if (!deviceId) return null;
  if (deviceId.length <= 20) return deviceId;
  return `${deviceId.slice(0, 10)}****${deviceId.slice(-8)}`;
}
