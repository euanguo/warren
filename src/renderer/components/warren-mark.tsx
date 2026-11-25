import { cn } from '@/lib/utils';

/**
 * 品牌标记 —— 界面里 logo 的单源。
 *
 * 一个拱门（洞口），负空间里是一只兔子：兔子底部与拱门底边齐平，头是圆心落在底边上的半圆。
 * 内联 SVG 而不是引资源文件：尺寸由父级 className 给，拱门色走 --brand-mark-arch token
 * （theme/theme-tokens.css），换 logo 只改这一个组件。
 * 打包用的 app icon 是同几何的另一份资产：assets/warren-icon.svg / icon.icns。
 */
export function WarrenMark({ className }: { className?: string }) {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 这个组件的全部意义就是内联 SVG（不引资源文件），换 <img> 就没了
    <svg viewBox="0 0 1024 1024" role="img" aria-label="Warren" className={cn('shrink-0', className)}>
      <defs>
        <mask id="warren-rabbit" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
          <rect x="0" y="0" width="1024" height="1024" fill="#fff" />
          <g fill="#000">
            <circle cx="512" cy="815" r="190" />
            <ellipse cx="394" cy="541" rx="56" ry="158" transform="rotate(-10 394 541)" />
            <ellipse cx="630" cy="541" rx="56" ry="158" transform="rotate(10 630 541)" />
          </g>
        </mask>
      </defs>
      <path
        d="M198 815L198 523A314 314 0 0 1 826 523L826 815Z"
        style={{ fill: 'var(--brand-mark-arch)' }}
        mask="url(#warren-rabbit)"
      />
    </svg>
  );
}
