export function appName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name.endsWith("-"))
    throw new Error("Invalid app name");
  return name;
}

export function branchSlug(branch: string): string {
  if (
    branch.length > 200 ||
    !branch ||
    [...branch].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
    /[~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.startsWith("-") ||
    branch
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      )
  )
    throw new Error("Invalid branch name");
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug.length > 63) throw new Error("Invalid branch slug");
  return slug;
}

export function healthPath(path: string): string {
  if (
    path.length > 2048 ||
    !/^\/(?:[A-Za-z0-9_./~-]*)$/.test(path) ||
    path.includes("..")
  )
    throw new Error("Invalid health path");
  return path;
}
