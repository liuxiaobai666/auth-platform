/**
 * 宽松语义化版本比较，容忍 "1.2", "v1.2.3", "1.2.3-beta.1" 这类写法。
 * 返回 -1 / 0 / 1。无法解析的一段按 0 处理，避免客户端上报脏版本号时直接抛错。
 */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const cleaned = String(v ?? '').trim().replace(/^v/i, '');
    const [core, pre] = cleaned.split('-');
    const nums = core.split('.').map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums: nums.slice(0, 3), pre: pre ?? '' };
  };

  const va = parse(a);
  const vb = parse(b);

  for (let i = 0; i < 3; i++) {
    if (va.nums[i] > vb.nums[i]) return 1;
    if (va.nums[i] < vb.nums[i]) return -1;
  }

  // 有预发布标识的版本小于同号正式版：1.2.0-beta < 1.2.0
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre === vb.pre) return 0;
  return va.pre < vb.pre ? -1 : 1;
}

export function isVersionLower(current: string, target: string): boolean {
  return compareVersion(current, target) < 0;
}

export function isValidVersion(v: string): boolean {
  return /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.\-]+)?$/.test(String(v ?? '').trim());
}
