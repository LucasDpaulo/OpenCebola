import type { SVGProps } from "react";

export function BrandIcon({ size = 28, className, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="65 65 230 230"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <image href="/onion-brand.png" x="0" y="0" width="360" height="360" />
    </svg>
  );
}
