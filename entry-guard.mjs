import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether `moduleUrl` is the process entry.
 *
 * Node sets `import.meta.url` to the real path of the module and leaves
 * `process.argv[1]` as the path it was invoked with. Both sides are realpath'd.
 * No argv, no module URL, or a realpath that throws → true (the entry runs).
 * A resolved path that is a different file → false (this module was imported).
 */
export function invokedDirectly(argv1, moduleUrl) {
  if (!argv1 || !moduleUrl) return true;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return true;
  }
}
