import { isAbsolute } from "node:path";
import type { Labels } from "./interfaces";

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}

export function hostName(value: string): void {
  if (
    value.length > 253 ||
    !value.includes(".") ||
    !value
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new Error("Invalid host name");
}

export function port(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("Invalid port");
}

export function labels(values: Labels): void {
  if (Object.keys(values).length > 64) throw new Error("Too many labels");
  for (const [key, value] of Object.entries(values)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(key) ||
      value.length > 256 ||
      hasControlCharacters(value)
    ) {
      throw new Error("Invalid label");
    }
  }
}

export function absolutePath(value: string): void {
  if (
    !isAbsolute(value) ||
    value.length > 4096 ||
    hasControlCharacters(value) ||
    value.split("/").includes("..")
  ) {
    throw new Error("Invalid absolute path");
  }
}

export function imageName(value: string): void {
  if (
    value.length > 256 ||
    !/^[a-z0-9][a-z0-9._/:@-]*$/.test(value) ||
    value.includes("..")
  )
    throw new Error("Invalid image name");
}

export function containerId(value: string): void {
  if (!/^[a-f0-9]{12,64}$/.test(value)) throw new Error("Invalid container ID");
}

export function upstreamAddress(value: string): void {
  const match = /^(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(value);
  if (!match) throw new Error("Invalid loopback upstream");
  port(Number(match[2]));
}
