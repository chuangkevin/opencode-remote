import { randomUUID } from "node:crypto";

export const createId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
