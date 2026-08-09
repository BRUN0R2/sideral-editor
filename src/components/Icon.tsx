import type { SVGProps } from "react";

export type IconName =
  | "alert"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "code"
  | "download"
  | "file"
  | "folder"
  | "folderOpen"
  | "globe"
  | "more"
  | "newFile"
  | "refresh"
  | "settings"
  | "spark"
  | "update";

interface IconProps extends SVGProps<SVGSVGElement> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <IconPath name={name} />
    </svg>
  );
}

function IconPath({ name }: { readonly name: IconName }) {
  switch (name) {
    case "alert":
      return (
        <>
          <path d="M12 3 2.8 19a1.3 1.3 0 0 0 1.12 2h16.16a1.3 1.3 0 0 0 1.12-2L12 3Z" />
          <path d="M12 9v4.5" />
          <path d="M12 17.5h.01" />
        </>
      );
    case "chevronDown":
      return <path d="m7 9 5 5 5-5" />;
    case "chevronRight":
      return <path d="m9 7 5 5-5 5" />;
    case "close":
      return (
        <>
          <path d="m7 7 10 10" />
          <path d="M17 7 7 17" />
        </>
      );
    case "code":
      return (
        <>
          <path d="m9 18-6-6 6-6" />
          <path d="m15 6 6 6-6 6" />
        </>
      );
    case "download":
      return (
        <>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M6 2.75h7l5 5V21.25H6z" />
          <path d="M13 2.75v5h5" />
        </>
      );
    case "folder":
      return <path d="M3 6.5h7l2 2h9v10.75H3z" />;
    case "folderOpen":
      return (
        <>
          <path d="M3 7h7l2 2h8.5" />
          <path d="m3 19 2.5-7h16L19 19z" />
        </>
      );
    case "globe":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a15 15 0 0 1 0 18" />
          <path d="M12 3a15 15 0 0 0 0 18" />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case "newFile":
      return (
        <>
          <path d="M5 3h8l4 4v14H5z" />
          <path d="M13 3v4h4" />
          <path d="M8 14h6" />
          <path d="M11 11v6" />
        </>
      );
    case "refresh":
      return (
        <>
          <path d="M20 7v5h-5" />
          <path d="M19 12a7 7 0 1 0-2 5" />
        </>
      );
    case "settings":
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15.04 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.87l-.06-.06L7.03 4.2l.06.06a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.04 1.52 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.87A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
        </>
      );
    case "spark":
      return (
        <>
          <path d="m12 2 1.4 5.6L19 9l-5.6 1.4L12 16l-1.4-5.6L5 9l5.6-1.4z" />
          <path d="m18.5 15 .7 2.8 2.8.7-2.8.7-.7 2.8-.7-2.8-2.8-.7 2.8-.7z" />
        </>
      );
    case "update":
      return (
        <>
          <path d="M12 20V7" />
          <path d="m7 12 5-5 5 5" />
          <path d="M5 3h14" />
        </>
      );
  }
}
