/**
 * CodeRifts contract gate for OpenClaw.
 *
 * MEASURED SHAPE (openclaw 2026.6.35 installed, main source read 2026-09-13):
 *
 *   api.on("before_tool_call", handler, { priority })
 *     handler(event, ctx) -> undefined | { params } | { block, blockReason } | { requireApproval }
 *
 *   Handlers run sequentially in DESCENDING priority; same priority keeps registration order. The
 *   first `block: true` stops the chain. `block` is sticky, so an earlier plugin passing the call
 *   through does NOT stop this one from refusing. The FIRST `requireApproval` wins, so if another
 *   plugin already asked, ours is dropped — our `block` still applies.
 *
 *   The host declares before_tool_call fail-closed (failurePolicyByHook) with a 15000ms budget, and
 *   a thrown handler error is NOT swallowed: it propagates and the tool call fails. Verified live
 *   against the host's own hook runner, all eight cases.
 *
 * PRIORITY 100 is deliberate. This gate wants to run before a plugin that might request approval
 * for its own reasons, because only the first requireApproval survives the merge, and a refusal
 * that names the contract change is more useful to a human than one that does not.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGate } from "./gate.js";

export default definePluginEntry({
  id: "coderifts-contract-gate",
  name: "CodeRifts contract gate",
  register(api) {
    // api.pluginConfig, NOT api.config. Measured: `api.config` is the whole OpenClaw config
    // snapshot; ours is `plugins.entries.<id>.config`. Reading the wrong one is silent — apiKey
    // would simply never be found, and the gate would run unkeyed forever while looking configured.
    const gate = createGate(api.pluginConfig ?? {});
    api.on(
      "before_tool_call",
      async (event) => {
        try {
          return await gate(event);
        } catch (err) {
          // Never throw out of the handler. The host would turn this into an opaque tool failure;
          // an approval request with a reason is the same safety with a readable cause.
          return {
            requireApproval: {
              title: "CodeRifts gate failed",
              description:
                `The contract gate raised an error before it could reach a decision ` +
                `(${String(err?.message ?? err)}). Not knowing is not permission.`,
              severity: "warning",
              timeoutBehavior: "deny",
            },
          };
        }
      },
      { priority: 100 },
    );
  },
});
