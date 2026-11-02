import { expect, spyOn, test } from "bun:test";
import { run } from "../../src/cli/index";

for (const verb of ["--help", "bogus", "serve", "ssh-dispatch", "git-hook"]) {
  test(`SSH ${verb} prints the complete public usage table`, async () => {
    const previous = process.env.SSH_ORIGINAL_COMMAND;
    const output = spyOn(
      console,
      verb === "--help" ? "log" : "error",
    ).mockImplementation(() => {});
    try {
      process.env.SSH_ORIGINAL_COMMAND = `hoist ${verb}`;
      expect(await run(["ssh-dispatch"])).toBe(verb === "--help" ? 0 : 1);
      const message = String(output.mock.calls[0]?.[0]);
      expect(message).toContain("config:set");
      expect(message).toContain("doctor");
    } finally {
      output.mockRestore();
      if (previous === undefined) delete process.env.SSH_ORIGINAL_COMMAND;
      else process.env.SSH_ORIGINAL_COMMAND = previous;
    }
  });
}
