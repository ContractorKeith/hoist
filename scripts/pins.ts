import { caddyRelease } from "../src/adapters/caddy-binary";
import { publicVerbs } from "../src/cli/index";

const pins = [
  `CADDY_VERSION=${caddyRelease.version}`,
  ...Object.entries(caddyRelease.linux).flatMap(([arch, pin]) => [
    `CADDY_${arch.toUpperCase()}_ARCHIVE=${pin.archiveSha256}`,
    `CADDY_${arch.toUpperCase()}_BINARY=${pin.binarySha256}`,
  ]),
].join("\n");
if (!process.argv.includes("--write") && !process.argv.includes("--check")) {
  console.log(pins);
} else {
  const path = "install.sh";
  const current = await Bun.file(path).text();
  const unit = (await Bun.file("systemd/hoist.service").text()).trimEnd();
  const replace = (text: string, name: string, body: string) => {
    const pattern = new RegExp(
      `(# BEGIN ${name}[^\\n]*\\n)[\\s\\S]*?(# END ${name})`,
    );
    if (!pattern.test(text)) throw new Error(`Missing generated ${name} block`);
    return text.replace(pattern, `$1${body}\n$2`);
  };
  const expected = replace(
    replace(current, "CADDY PINS", pins),
    "HOIST UNIT",
    unit,
  );
  const client = `${JSON.stringify(publicVerbs, null, 2)}\n`;
  const readme = await Bun.file("README.md").text();
  if (
    !readme.includes("<!-- BEGIN VERBS -->") ||
    !readme.includes("<!-- END VERBS -->")
  )
    throw new Error("Missing README verb block");
  const reference = `<!-- BEGIN VERBS -->\n\`\`\`text\n${publicVerbs.map((v) => `hoist ${v}`).join("\n")}\n\`\`\`\n<!-- END VERBS -->`;
  const docs = readme.replace(
    /<!-- BEGIN VERBS -->[\s\S]*?<!-- END VERBS -->/,
    reference,
  );
  if (process.argv.includes("--write")) {
    await Bun.write(path, expected);
    await Bun.write("cli/verbs.json", client);
    await Bun.write("README.md", docs);
  } else if (
    current !== expected ||
    (await Bun.file("cli/verbs.json").text()) !== client ||
    readme !== docs
  ) {
    throw new Error(
      "Generated pins, unit, verbs or README are stale; run bun run pins --write",
    );
  }
}

if (process.argv.includes("--build")) {
  // Arch's native Bun links system ICU; use the official portable runtime instead.
  const target =
    process.arch === "x64" ? "bun-linux-x64-baseline" : "bun-linux-arm64";
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${target}`,
      "src/cli/index.ts",
      "--outfile",
      "dist/hoist",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await child.exited;
}
