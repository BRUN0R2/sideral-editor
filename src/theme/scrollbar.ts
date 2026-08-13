import type { CSSProperties } from "react";

export const SIDERAL_THEME_CHANGE_EVENT = "sideral-theme-change";

export const SCROLLBAR_CSS_VARIABLES = {
  trackSize: "--sideral-scrollbar-track-size",
  thumbSize: "--sideral-scrollbar-thumb-size",
  trackColor: "--sideral-scrollbar-track-color",
  thumbColor: "--sideral-scrollbar-thumb-color",
  thumbHoverColor: "--sideral-scrollbar-thumb-hover-color",
  thumbActiveColor: "--sideral-scrollbar-thumb-active-color",
  buttonDisplay: "--sideral-scrollbar-button-display",
  buttonSize: "--sideral-scrollbar-button-size",
  arrowSize: "--sideral-scrollbar-arrow-size",
  arrowHeight: "--sideral-scrollbar-arrow-height",
  arrowColor: "--sideral-scrollbar-arrow-color",
  arrowHoverColor: "--sideral-scrollbar-arrow-hover-color",
  arrowActiveColor: "--sideral-scrollbar-arrow-active-color",
  cornerRadius: "--sideral-scrollbar-corner-radius",
} as const;

const DEFAULT_TRACK_SIZE = 14;
const DEFAULT_THUMB_SIZE = 10;
const DEFAULT_BUTTON_SIZE = 22;
const DEFAULT_ARROW_SIZE = 11;
const DEFAULT_ARROW_HEIGHT = 6;

type ScrollbarCssVariable = (typeof SCROLLBAR_CSS_VARIABLES)[keyof typeof SCROLLBAR_CSS_VARIABLES];

export type ScrollbarCustomProperties = CSSProperties &
  Partial<Record<ScrollbarCssVariable, string>>;

export interface ScrollbarThemeOverride {
  readonly trackSize?: number;
  readonly thumbSize?: number;
  readonly trackColor?: string;
  readonly thumbColor?: string;
  readonly thumbHoverColor?: string;
  readonly thumbActiveColor?: string;
  readonly showButtons?: boolean;
  readonly buttonSize?: number;
  readonly arrowSize?: number;
  readonly arrowHeight?: number;
  readonly arrowColor?: string;
  readonly arrowHoverColor?: string;
  readonly arrowActiveColor?: string;
  readonly cornerRadius?: number;
}

export interface ResolvedScrollbarTheme {
  readonly trackSize: number;
  readonly thumbSize: number;
  readonly trackColor: string;
  readonly thumbColor: string;
  readonly thumbHoverColor: string;
  readonly thumbActiveColor: string;
  readonly showButtons: boolean;
  readonly buttonSize: number;
  readonly arrowSize: number;
  readonly arrowHeight: number;
  readonly arrowColor: string;
  readonly arrowHoverColor: string;
  readonly arrowActiveColor: string;
  readonly cornerRadius: number;
}

interface CssPropertyReader {
  getPropertyValue(name: string): string;
}

export function resolveScrollbarTheme(element: Element): ResolvedScrollbarTheme {
  return readScrollbarTheme(getComputedStyle(element));
}

export function readScrollbarTheme(style: CssPropertyReader): ResolvedScrollbarTheme {
  const theme = {
    trackSize: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.trackSize),
    thumbSize: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.thumbSize),
    trackColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.trackColor),
    thumbColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.thumbColor),
    thumbHoverColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.thumbHoverColor),
    thumbActiveColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.thumbActiveColor),
    showButtons: requiredButtonVisibility(style),
    buttonSize: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.buttonSize),
    arrowSize: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.arrowSize),
    arrowHeight: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.arrowHeight),
    arrowColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.arrowColor),
    arrowHoverColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.arrowHoverColor),
    arrowActiveColor: requiredValue(style, SCROLLBAR_CSS_VARIABLES.arrowActiveColor),
    cornerRadius: requiredPixels(style, SCROLLBAR_CSS_VARIABLES.cornerRadius),
  } satisfies ResolvedScrollbarTheme;
  validateGeometry(
    theme.trackSize,
    theme.thumbSize,
    theme.buttonSize,
    theme.arrowSize,
    theme.arrowHeight,
  );
  return theme;
}

export function scrollbarCustomProperties(
  override: ScrollbarThemeOverride | null | undefined,
): ScrollbarCustomProperties | undefined {
  if (override == null) {
    return undefined;
  }
  const trackSize = override.trackSize ?? DEFAULT_TRACK_SIZE;
  const thumbSize = override.thumbSize ?? Math.min(DEFAULT_THUMB_SIZE, trackSize);
  const buttonSize = override.buttonSize ?? DEFAULT_BUTTON_SIZE;
  const arrowSize = override.arrowSize ?? Math.min(DEFAULT_ARROW_SIZE, trackSize, buttonSize);
  const arrowHeight = override.arrowHeight ?? Math.min(DEFAULT_ARROW_HEIGHT, arrowSize, buttonSize);
  validateGeometry(trackSize, thumbSize, buttonSize, arrowSize, arrowHeight);
  const properties: Partial<Record<ScrollbarCssVariable, string>> = {};
  setPixels(properties, SCROLLBAR_CSS_VARIABLES.trackSize, override.trackSize);
  if (override.thumbSize !== undefined || thumbSize !== DEFAULT_THUMB_SIZE) {
    setPixels(properties, SCROLLBAR_CSS_VARIABLES.thumbSize, thumbSize);
  }
  setColor(properties, SCROLLBAR_CSS_VARIABLES.trackColor, override.trackColor);
  setColor(properties, SCROLLBAR_CSS_VARIABLES.thumbColor, override.thumbColor);
  setColor(properties, SCROLLBAR_CSS_VARIABLES.thumbHoverColor, override.thumbHoverColor);
  setColor(properties, SCROLLBAR_CSS_VARIABLES.thumbActiveColor, override.thumbActiveColor);
  if (override.showButtons !== undefined) {
    properties[SCROLLBAR_CSS_VARIABLES.buttonDisplay] = override.showButtons ? "block" : "none";
  }
  setPixels(properties, SCROLLBAR_CSS_VARIABLES.buttonSize, override.buttonSize);
  if (override.arrowSize !== undefined || arrowSize !== DEFAULT_ARROW_SIZE) {
    setPixels(properties, SCROLLBAR_CSS_VARIABLES.arrowSize, arrowSize);
  }
  if (override.arrowHeight !== undefined || arrowHeight !== DEFAULT_ARROW_HEIGHT) {
    setPixels(properties, SCROLLBAR_CSS_VARIABLES.arrowHeight, arrowHeight);
  }
  setColor(properties, SCROLLBAR_CSS_VARIABLES.arrowColor, override.arrowColor);
  setColor(properties, SCROLLBAR_CSS_VARIABLES.arrowHoverColor, override.arrowHoverColor);
  setColor(properties, SCROLLBAR_CSS_VARIABLES.arrowActiveColor, override.arrowActiveColor);
  setPixels(properties, SCROLLBAR_CSS_VARIABLES.cornerRadius, override.cornerRadius);
  return properties as ScrollbarCustomProperties;
}

export function notifySideralThemeChanged(): void {
  window.dispatchEvent(new Event(SIDERAL_THEME_CHANGE_EVENT));
}

function requiredPixels(style: CssPropertyReader, name: ScrollbarCssVariable): number {
  const value = requiredValue(style, name);
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value);
  if (match === null) {
    throw new Error(`Scrollbar token ${name} must be an absolute pixel value, received: ${value}`);
  }
  const pixels = Number(match[1]);
  if (!Number.isFinite(pixels) || pixels < 0) {
    throw new Error(`Scrollbar token ${name} must be a non-negative pixel value.`);
  }
  return pixels;
}

function requiredValue(style: CssPropertyReader, name: ScrollbarCssVariable): string {
  const value = style.getPropertyValue(name).trim();
  if (value === "") {
    throw new Error(`Required scrollbar token is missing: ${name}`);
  }
  return value;
}

function requiredButtonVisibility(style: CssPropertyReader): boolean {
  const value = requiredValue(style, SCROLLBAR_CSS_VARIABLES.buttonDisplay);
  if (value === "block") {
    return true;
  }
  if (value === "none") {
    return false;
  }
  throw new Error(
    `Scrollbar token ${SCROLLBAR_CSS_VARIABLES.buttonDisplay} must be block or none, received: ${value}`,
  );
}

function validateGeometry(
  trackSize: number,
  thumbSize: number,
  buttonSize: number,
  arrowSize: number,
  arrowHeight: number,
): void {
  if (!Number.isInteger(trackSize) || trackSize < 8 || trackSize > 32) {
    throw new Error("Scrollbar track size must be an integer between 8 and 32 pixels.");
  }
  if (!Number.isInteger(thumbSize) || thumbSize < 4 || thumbSize > trackSize) {
    throw new Error("Scrollbar thumb size must be an integer between 4 pixels and the track size.");
  }
  if (!Number.isInteger(buttonSize) || buttonSize < 8 || buttonSize > 32) {
    throw new Error("Scrollbar button size must be an integer between 8 and 32 pixels.");
  }
  if (
    !Number.isInteger(arrowSize) ||
    arrowSize < 4 ||
    arrowSize > Math.min(trackSize, buttonSize)
  ) {
    throw new Error(
      "Scrollbar arrow size must be an integer between 4 pixels and the smaller track or button size.",
    );
  }
  if (
    !Number.isInteger(arrowHeight) ||
    arrowHeight < 3 ||
    arrowHeight > Math.min(arrowSize, buttonSize)
  ) {
    throw new Error(
      "Scrollbar arrow height must be an integer between 3 pixels and the smaller arrow width or button size.",
    );
  }
}

function setPixels(
  properties: Partial<Record<ScrollbarCssVariable, string>>,
  name: ScrollbarCssVariable,
  value: number | undefined,
): void {
  if (value !== undefined) {
    properties[name] = `${value}px`;
  }
}

function setColor(
  properties: Partial<Record<ScrollbarCssVariable, string>>,
  name: ScrollbarCssVariable,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const color = value.trim();
  if (color === "") {
    throw new Error(`Scrollbar color ${name} cannot be empty.`);
  }
  properties[name] = color;
}
