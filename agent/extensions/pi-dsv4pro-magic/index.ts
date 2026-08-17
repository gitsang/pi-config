/**
 * pi-dsv4pro-magic
 *
 * When the active model matches `deepseek-v4-pro`, replace the system prompt
 * with a fixed "magic" prompt that forces English thinking and a fixed
 * "We need..." thought prefix.
 *
 * The match is case-insensitive and checked against both the model id and the
 * full `provider/id` identifier, so it works whether the model is addressed
 * as `deepseek-v4-pro` or `some-provider/deepseek-v4-pro`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAGIC_MODEL_PATTERN = /deepseek-v4-pro/i;

const MAGIC_SYSTEM_PROMPT =
  'You are a helpful software engineer assistant. When you thought, thought in ENGLISH, start with "We need..."';

/** Returns true when the active model matches the magic pattern. */
function isMagicModel(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;

  const candidates = [model.id];
  if (model.provider) {
    candidates.push(`${model.provider}/${model.id}`);
  }

  return candidates.some((candidate) => MAGIC_MODEL_PATTERN.test(candidate));
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!isMagicModel(ctx)) return;

    return {
      systemPrompt: MAGIC_SYSTEM_PROMPT,
    };
  });
}
