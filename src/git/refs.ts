import { branchSlug } from "../core/validation";

export function parseRefs(
  input: string,
): { oldSha: string; sha: string; branch: string }[] {
  if (input.length > 1024 * 1024 || input.includes("\0"))
    throw new Error("Invalid ref input");
  const refs: { oldSha: string; sha: string; branch: string }[] = [];
  const slugs = new Map<string, string>();
  for (const line of input.split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^ ]{1,220})$/.exec(
      line,
    );
    if (
      !match ||
      [...line].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error("Invalid pre-receive ref line");
    if (!(match[3] ?? "").startsWith("refs/heads/")) continue;
    const branch = (match[3] ?? "").slice(11);
    const slug = branchSlug(branch);
    if (slugs.has(slug))
      throw new Error(
        `Branch slug collision with existing branch ${slugs.get(slug)} in push.`,
      );
    slugs.set(slug, branch);
    refs.push({ oldSha: match[1] ?? "", sha: match[2] ?? "", branch });
  }
  return refs;
}
