import type { ModelMessage } from "ai";

export function addCacheControl(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg, i) => {
    if (i === 0) {
      return {
        ...msg,
        providerOptions: { cacheControl: { type: "ephemeral" } },
      };
    }
    if (i < messages.length - 2) {
      return {
        ...msg,
        providerOptions: { cacheControl: { type: "ephemeral" } },
      };
    }
    return msg;
  });
}