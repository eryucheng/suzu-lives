/**
 * Product-facing entry for Suzu's configurable text-model transport.
 *
 * The implementation is a deliberately narrow, audited upstream adapter
 * snapshot.  Suzu owns its public name, settings namespace, configuration UI
 * and provider profiles; the vendored code only translates the three wire
 * protocols Suzu exposes (OpenAI Chat Completions, OpenAI Responses and
 * Anthropic Messages).
 */
import {
  Config,
  PiAiAdapter,
  apply,
  inject,
  supportedProtocols,
} from "@suzu-lives/suzu-agent-runtime/core/compatible-protocols";

import { installCompatibleSystemMessageSupport } from "./compatible-system-messages.mjs";

installCompatibleSystemMessageSupport(PiAiAdapter);

export {
  Config,
  PiAiAdapter as SuzuCompatibleLlmAdapter,
  apply,
  inject,
  supportedProtocols,
};

export const name = "suzu-compatible-llm";
