import type english from "../../../locales/en.json";

export type MessageKey = keyof typeof english.messages;
export type MessageVariables = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, variables?: MessageVariables) => string;
