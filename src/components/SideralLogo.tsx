import type { ReactElement } from "react";

interface SideralLogoProps {
  readonly className?: string;
}

export function SideralLogo({ className }: SideralLogoProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      viewBox="0 0 160 202"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M106 10 22 112h50l-24 80L138 78H90l16-68Z"
        fill="currentColor"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="10"
      />
    </svg>
  );
}
