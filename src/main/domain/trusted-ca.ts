/**
 * 「这个环境的 Session 要不要信任某张 CA」的判定。
 *
 * 纯函数、只依赖 `node:crypto`，所以 `node --test` 能直接加载（`environments.ts` 里那段
 * 装 `setCertificateVerifyProc` 的接线因为 import electron 没法单测）。
 *
 * 用途：让某个环境信任代理自己的根证书，从而让 MITM 生效。
 * 见 docs/WHISTLE-PLUGIN-PLAN.md §3.3。
 */
import { X509Certificate } from 'node:crypto';

/**
 * 叶子证书是不是这张 CA 签的。
 *
 * **必须是验签，不能比较 issuer。** Electron 的 `request.certificate.issuerCert.data`
 * 是空的（实测 PEM 长度 0），拿它跟 root.crt 比永远不相等；而 `issuerName` 只给到 CN，
 * 拿 CN 当身份校验太弱（任何人签一张 CN 相同的证书都能过）。
 */
export function leafSignedByCa(leafPem: string, ca: X509Certificate): boolean {
  try {
    return new X509Certificate(leafPem).verify(ca.publicKey);
  } catch {
    // 链不完整 / PEM 坏了 / 不是证书：一律当作不通过，不往上抛
    return false;
  }
}

/** 读一张 PEM 当 CA。读不出来返回 undefined（调用方据此**不装**钩子，而不是放行）。 */
export function parseCa(pem: string): X509Certificate | undefined {
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}
